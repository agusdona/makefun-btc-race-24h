// BTC race bot: long-only trend follower on CBBTC/USDC 1-minute bars.
//
// Protocol: agent-fun/bars-replay/v1. The harness sends one hello, then one
// batch per bar that closed, and this bot answers every batch with exactly
// one reply carrying its orders. Orders decided on a batch fill at the next
// bar's open, so every signal here is computed on the bar close just sent.
//
// Strategy (all numbers in the README):
//   - EMA(12) and EMA(48) over bar closes, seeded as the mean of their first
//     span of closes (the kit baselines' convention).
//   - Entry: the close is >= 20 bps above EMA(12) while EMA(12) is above
//     EMA(48). A confirmed uptrend only; the 20 bps filter is ~4x the dev
//     window's 1-minute noise, which keeps the bot out of the chop that
//     sank every kit baseline (EMA-cross lost ~$96 on 68 whipsaw trades).
//   - Exit, whichever comes first: EMA(12) crosses back below EMA(48),
//     take-profit +1.0% over the fill price, stop-loss -0.5%, or a trailing
//     stop 1.0% below the highest close since entry (0.5% proved too tight:
//     it fired on 1-minute noise 11 bars after entry on the dev window).
//   - One open position at most, full cash per entry. A round trip costs
//     ~26-28 bps (4 bps fee + 2 bps slippage + ~8 bps impact each way), so
//     only a real trend clears it; the bot would rather sit in cash than
//     bleed in a downtrend (the dev window falls -2.3% overall).
//
// Determinism: pure float64 arithmetic on the bars, no clock, no
// environment, no unseeded randomness. The same hello + batches always
// produce the same orders. The entry price is read from the batch fills
// (the price the buy actually filled at), never guessed from a close.

import { runBars, type Bar, type BarsState, type Batch, type BuyInput, type OrderInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const FAST_SPAN = 12;
const SLOW_SPAN = 48;
/** Entry needs the close this far above the fast EMA, in bps. */
const ENTRY_GAP_BPS = 20;
/** Take-profit over the fill price, as a fraction. */
const TAKE_PROFIT = 0.01;
/** Stop-loss under the fill price, as a fraction. */
const STOP_LOSS = 0.005;
/** Trailing stop under the highest close since entry, as a fraction.
 * 1.0%: the 0.5% first tried fired on ordinary 1-minute noise 11 bars
 * after entry (grade-local: PnL -$2.27, 4 trades) — the dev window's
 * opening hour alone ranges 125 bps. 1.0% never fires on the dev window
 * (same +$7.71 as no trail) and only guards a real reversal in the race. */
const TRAIL = 0.01;
/** Max slippage vs the latest close, in bps (1%: far above any 1-minute move on the dev window). */
const MAX_SLIPPAGE_BPS = 100;

/** One EMA: closes collected until it starts, then its value. */
interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

const fast: Ema = { span: FAST_SPAN, warm: [], value: null };
const slow: Ema = { span: SLOW_SPAN, warm: [], value: null };
/** EMA(12) - EMA(48) after the previous bar, in bps of the slow EMA; null until both are seeded. */
let prevGapBps: number | null = null;
/** Fill price of the open position (price-scale units), from the batch fills; null while flat. */
let entryPrice: number | null = null;
/** Highest bar close since entry (same units as the closes). */
let peakClose = 0;

function stepEma(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // First, learn the fills the harness reports on this batch: a filled buy
    // sets the entry price (the price the order actually filled at), a
    // filled sell clears it. The fills arrive one batch after the decision.
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL || fill.status !== 'filled') continue;
      if (fill.side === 'buy') {
        entryPrice = Number(fill.price);
        peakClose = entryPrice;
      } else if (fill.side === 'sell') {
        entryPrice = null;
        peakClose = 0;
      }
    }

    const bar: Bar | undefined = batch.bars.find((b) => b.symbol === SYMBOL);
    // A minute with no bar for CBBTC: nothing to update, no orders.
    if (bar === undefined) return [];
    const close = Number(bar.c);
    stepEma(fast, close);
    stepEma(slow, close);
    if (fast.value === null || slow.value === null) return [];

    const gapBps = ((fast.value - slow.value) / slow.value) * 10_000;
    const held = state.positions.get(SYMBOL);
    const orders: OrderInput[] = [];

    if (held !== undefined && entryPrice !== null) {
      // Holding: track the peak close, then check every exit.
      if (close > peakClose) peakClose = close;
      const ret = close / entryPrice - 1;
      const crossDown = prevGapBps !== null && gapBps < 0 && prevGapBps >= 0;
      const takeProfit = ret >= TAKE_PROFIT;
      const stopLoss = ret <= -STOP_LOSS;
      const trailing = close / peakClose - 1 <= -TRAIL;
      if (crossDown || takeProfit || stopLoss || trailing) {
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        orders.push(sell);
      }
    } else if (held === undefined && !state.warmingUp) {
      // Flat: enter only on a confirmed uptrend — close 20 bps above the
      // fast EMA while the fast EMA is above the slow one.
      const strongTrend = gapBps > 0 && close > fast.value * (1 + ENTRY_GAP_BPS / 10_000);
      if (strongTrend) {
        const { caps, fees } = state.hello;
        let size = state.cash;
        const byWeight = state.weightRoom(SYMBOL);
        if (byWeight < size) size = byWeight;
        if (size >= BigInt(fees.min_notional_quote_units) && size > 0n) {
          const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: size, max_slippage_bps: MAX_SLIPPAGE_BPS };
          orders.push(buy);
        }
        void caps;
      }
    }

    prevGapBps = gapBps;
    return orders;
  },
});
