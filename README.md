# BTC Race Bot — Round 2: Quick-Profit Trend Rider

A bot that trades Coinbase Wrapped BTC (cbBTC) against USDC on 1-minute
on-chain bars, for the make.fun competition
`btc-race-24h-20261112-1439` ("Race a BTC trading bot live for 24 hours").
Long only, $1,000 of paper money, one asset (CBBTC). Standard library plus
the vendored kit shim only; no network, no wall clock, no files outside the
repository; fully deterministic.

## Strategy

Trend following with a quick take-profit. The dev window is a quiet,
falling market (BTC -2.3% over 24h, 1-minute returns only 5 bps stdev),
so the bot trades rarely and only on confirmed uptrends, and banks small
wins instead of waiting for a top that may never come.

- **Indicators:** EMA(9) and EMA(48) over bar closes, seeded as the mean of
  their first span of closes (the kit baselines' convention).
- **Entry (flat only):** the close is at least 30 bps above EMA(9) while
  EMA(9) is above EMA(48). The 30 bps filter is ~6x the dev window's
  1-minute noise, which keeps the bot out of the chop that sank every kit
  baseline (EMA-cross lost ~$96 on 68 whipsaw trades, RSI-Bollinger
  ~$47, ADX-momentum ~$53, momentum ~$23, buy-and-hold ~$26).
- **Exit, whichever comes first:** EMA(9) crosses back below EMA(48),
  take-profit +0.5% over the fill price, stop-loss -1.0%, or a trailing
  stop 1.0% below the highest close since entry.
- **Sizing:** one open position at most, full cash per entry (capped by
  the weight room). A round trip costs ~26-28 bps (4 bps fee + 2 bps
  slippage + ~8 bps impact each way), so only a real trend clears it.
- **Execution:** signals are computed on the bar close just sent; orders
  fill at the next bar's open (1-bar latency). The entry price is read
  from the batch fills, never guessed from a close.

## Why 0.5% take-profit

On the dev window the catchable up-moves run 50-160 bps. Taking 50 bps
twice (two round trips) beats waiting for 100 bps once: the otherwise
identical 1.0% take-profit variant makes +$7.71 on one round trip, while
this 0.5% version makes +$10.00 on two. The trailing stop never fired on
the dev window; it only guards a real reversal in the live race.

## Backtest (dev window, `grade-local --driver process`)

Verified with the kit's own local grader, twice (identical action logs):

| Metric | Round 2 | Round 1 (EMA 12/48, TP 1.0%) |
| --- | --- | --- |
| Net PnL (dev) | **+$10.00** | +$7.71 |
| Trades (fills) | 4 (2 round trips, 2/2 won) | 2 (1 round trip) |
| Max drawdown | 0.45% | 0.60% |
| Fees paid | $1.61 | — |
| Exposure | 7.2% of bars | — |
| Dev gate (`dev_profitable`) | pass | pass |

Hourly-block PnL: +$3.74 (h0), +$2.68 (h1), +$3.58 (h2), $0.00 in every
other hour — no losing block anywhere. Cost sensitivity (fees doubled):
still +$8.39. The strategy was chosen from a ~10,000-configuration grid
search over EMA trend, Donchian breakout, Bollinger mean-reversion,
momentum burst, and sweep-reclaim families; +$10.00 is a 12-configuration
plateau (fast EMA 9 or 10, gap 30 bps, TP 0.5%), not an isolated spike.

Robustness, stated honestly: the dev window's second half is a steady
grind down (-233 bps) with no 60-minute up-window above 50 bps at all, so
no long-only bot can be profitable in both halves of this window — the
correct behaviour there is to stay flat, which this bot does (exactly
$0.00, no losses). The dev window never counts toward the ranking; it
only decides who races. This bot's edge for the live race is the same
discipline that produced the dev result: trade only confirmed uptrends,
bank 50 bps quickly, stop out at -1.0%, and sit in cash the rest of the
time.

## Run

```sh
node main.ts   # the grader runs: node /bot/main.ts
```

## Files

- `main.ts` — the bot (TypeScript, Node 22, erasable syntax only).
- `vendor/makefun-bars.ts` — byte-identical copy of the kit SDK shim.
- `LICENSE` — MIT.
