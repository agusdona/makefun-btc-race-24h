// BTC race bot, round 3: violent-dip swing on CBBTC/USDC 1-minute bars.
//
// Protocol: agent-fun/bars-replay/v1. The harness sends one hello, then one
// batch per bar that closed, and this bot answers every batch with exactly
// one reply carrying its orders. Orders decided on a batch fill at the next
// bar's open, so every signal here is computed on the bar close just sent.
//
// Strategy (all numbers in the README):
//   - Rolling 60-bar high of closes; a dip is the close below that high.
//   - Entry (flat only, at most 3 round trips): the dip is 60-150 bps AND
//     the mean 1-minute range over the last 10 bars is at least 8 bps.
//     That second condition is the vol gate: only buy a dip when the market
//     is actually moving. Quiet drifts and dead hours never qualify, which
//     is what keeps the bot out of the second half's steady grind down.
//   - Exit, whichever comes first: take-profit +80 bps over the fill price,
//     stop-loss -50 bps under it, or a trailing stop 40 bps below the
//     highest close since entry. The trailing stop is the loss cutter: on
//     the dev window it closes the one losing trip at -16 bps gross instead
//     of letting it bleed to the -50 stop.
//   - One open position at most, full cash per entry. A round trip costs
//     ~26-28 bps (4 bps fee + 2 bps slippage + ~8 bps impact each way), so
//     only a real rebound clears it; the bot would rather sit in cash than
//     chase a dip that keeps falling (the dev window falls -2.3% overall,
//     and its second half has no 60-minute up-window above 50 bps at all).
//
// Determinism: pure float64 arithmetic on the bars, no clock, no
// environment, no unseeded randomness. The same hello + batches always
// produce the same orders. The entry price is read from the batch fills
// (the price the buy actually filled at), never guessed from a close.

import { runBars, type Bar, type BarsState, type Batch, type BuyInput, type OrderInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const LOOKBACK = 60;
/** Entry needs the close this far below the 60-bar high, in bps. */
const DIP_MIN_BPS = 60;
/** Entry refuses a dip deeper than this, in bps (a crash, not a dip). */
const DIP_MAX_BPS = 150;
/** Vol gate window, in bars. */
const ATR_SPAN = 10;
/** Vol gate: mean 1-minute range over the window must be at least this, in bps. */
const ATR_MIN_BPS = 8;
/** Take-profit over the fill price, in bps. */
const TAKE_PROFIT_BPS = 80;
/** Stop-loss under the fill price, in bps. */
const STOP_LOSS_BPS = 50;
/** Trailing stop under the highest close since entry, in bps. */
const TRAIL_BPS = 40;
/** At most this many round trips in the window. */
const MAX_TRIPS = 3;
/** Max slippage vs the latest close, in bps (1%: far above any 1-minute move on the dev window). */
const MAX_SLIPPAGE_BPS = 100;

/** Every close seen, in order. */
const closes: number[] = [];
/** Every bar's (high - low) / close, in bps. */
const ranges: number[] = [];
/** Fill price of the open position (price-scale units), from the batch fills; null while flat. */
let entryPrice: number | null = null;
/** Highest bar close since entry (same units as the closes). */
let peakClose = 0;
/** Round trips completed (sell filled). */
let tripsDone = 0;

/** Highest close of the last `span` closes (fewer while warming up). */
function rollingHigh(span: number): number {
  let hi = 0;
  const start = Math.max(0, closes.length - span);
  for (let i = start; i < closes.length; i++) if (closes[i] > hi) hi = closes[i];
  return hi;
}

/** Mean 1-minute range over the last `span` bars, in bps. */
function meanRange(span: number): number {
  const start = Math.max(0, ranges.length - span);
  let sum = 0;
  for (let i = start; i < ranges.length; i++) sum += ranges[i];
  return sum / (ranges.length - start);
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // First, learn the fills the harness reports on this batch: a filled buy
    // sets the entry price (the price the order actually filled at) and the
    // trailing peak, a filled sell clears it and counts a completed trip.
    // The fills arrive one batch after the decision.
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL || fill.status !== 'filled') continue;
      if (fill.side === 'buy') {
        entryPrice = Number(fill.price);
        peakClose = entryPrice;
      } else if (fill.side === 'sell') {
        entryPrice = null;
        peakClose = 0;
        tripsDone += 1;
      }
    }

    const bar: Bar | undefined = batch.bars.find((b) => b.symbol === SYMBOL);
    // A minute with no bar for CBBTC: nothing to update, no orders.
    if (bar === undefined) return [];
    const close = Number(bar.c);
    closes.push(close);
    ranges.push(((Number(bar.h) - Number(bar.l)) / close) * 10_000);
    // Need a full 60-bar window before the dip is defined.
    if (closes.length < LOOKBACK) return [];

    const hi60 = rollingHigh(LOOKBACK);
    const dipBps = (hi60 / close - 1) * 10_000;
    const atr = meanRange(ATR_SPAN);
    const held = state.positions.get(SYMBOL);
    const orders: OrderInput[] = [];

    if (held !== undefined && entryPrice !== null) {
      // Holding: track the peak close, then check every exit.
      if (close > peakClose) peakClose = close;
      const retBps = (close / entryPrice - 1) * 10_000;
      const trailBps = (peakClose / close - 1) * 10_000;
      const takeProfit = retBps >= TAKE_PROFIT_BPS;
      const stopLoss = retBps <= -STOP_LOSS_BPS;
      const trailing = trailBps >= TRAIL_BPS;
      if (takeProfit || stopLoss || trailing) {
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        orders.push(sell);
      }
    } else if (held === undefined && !state.warmingUp) {
      // Flat: enter only on a vol-gated dip — 60-150 bps below the 60-bar
      // high while the last 10 bars averaged at least 8 bps of range.
      const tripsOpen = 0;
      const gatedDip = dipBps >= DIP_MIN_BPS && dipBps <= DIP_MAX_BPS && atr >= ATR_MIN_BPS;
      if (tripsDone + tripsOpen < MAX_TRIPS && gatedDip) {
        const { fees } = state.hello;
        const size = state.cash;
        if (size >= BigInt(fees.min_notional_quote_units) && size > 0n) {
          const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: size, max_slippage_bps: MAX_SLIPPAGE_BPS };
          orders.push(buy);
        }
      }
    }

    return orders;
  },
});
