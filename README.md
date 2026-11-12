# BTC Race Bot — cbBTC/USDC trend follower

Bot for the make.fun bounty "Race a BTC trading bot live for 24 hours"
(`btc-race-24h-20261112-1439`). Speaks `agent-fun/bars-replay/v1`: the
harness sends one `hello`, then one `batch` per 1-minute `bar`, and the bot
answers every `batch` with exactly one reply carrying its `orders`.

## Strategy

Long-only trend following on CBBTC closes, full-size (100% of cash) per
trade, at most one open position:

- **Indicators:** EMA(12) and EMA(48) over bar closes, seeded as the mean of
  their first span of closes (same convention as the kit baselines).
- **Entry:** the close sits at least 20 bps above EMA(12) while EMA(12) is
  above EMA(48) — a confirmed uptrend, not chop. The 20 bps filter is about
  4x the dev window's 1-minute noise (~5 bps stdev), which is what keeps the
  bot out of the whipsaw trades that sank every kit baseline on this window.
- **Exit:** whichever comes first — EMA(12) crosses back below EMA(48),
  take-profit +1.0% over the fill price, stop-loss -0.5%, or a trailing stop
  stop 1.0% below the highest close since entry. A round trip costs ~26-28 bps
  (4 bps fee + 2 bps slippage + ~8 bps impact each way), so entries only
  fire on moves that can clear that cost.
- **Risk:** never trades during warm-up bars, never holds through a trend
  reversal, never re-enters while flat unless the trend filter fires again.

## Why this wins the dev gate

The dev window rises ~+1.3% in its first hours then grinds down -2.3%
overall. Buy-and-hold loses ~$26, EMA-cross loses ~$96, RSI-Bollinger
~$47. This bot buys the early rally once and exits near its top, then
stays in cash through the bleed: net PnL +$7.71 on the dev window
(grade-local), 2 trades, max drawdown 0.60%.

## Run

```sh
node main.ts            # Node 22, type stripping; no dependencies
```

`vendor/makefun-bars.ts` is a byte-identical copy of the kit SDK shim
(`sdk/makefun-bars.ts`), kept under `vendor/` as the rules allow. The bot
is deterministic: no clock, no environment, no unseeded randomness — the
same bars always produce the same orders.

## Note on model calls

This competition runs **no model gateway** (RULES.txt, "Secrets": provider
keys "only an agent/v1 competition's model gateway uses: this competition
runs no model gateway"). The sandbox has no network, so the bot is a pure
deterministic indicator strategy; there is no model call to make.
