# BTC Race Bot — Round 3: Violent-Dip Swing Bot

A bot that trades Coinbase Wrapped BTC (cbBTC) against USDC on 1-minute
on-chain bars, for the make.fun competition
`btc-race-24h-20261112-1439` ("Race a BTC trading bot live for 24 hours").
Long only, $1,000 of paper money, one asset (CBBTC). Standard library plus
the vendored kit shim only; no network, no wall clock, no files outside the
repository; fully deterministic.

## Strategy

Buy the dip — but only a violent one. The dev window is a quiet, falling
market (BTC -2.3% over 24h, 1-minute returns only 5 bps stdev), so most
dips are just the grind down wearing a costume. The bot waits for a dip
that comes with real movement behind it, banks a quick rebound, and cuts
the losers fast with a trailing stop.

- **Dip:** the close is 60-150 bps below the rolling 60-bar high of
  closes. Shallower than 60 is noise; deeper than 150 is a crash, not a
  dip, and the bot refuses it.
- **Vol gate:** the mean 1-minute range over the last 10 bars is at least
  8 bps. This is the filter that does the work: it passes on only ~7% of
  bars, the genuinely moving hours, and keeps the bot flat through the
  dead stretches.
- **Entry (flat only, at most 3 round trips):** dip in range AND vol gate
  passes. One open position at most, full cash per entry.
- **Exit, whichever comes first:** take-profit +80 bps over the fill
  price, stop-loss -50 bps under it, or a trailing stop 40 bps below the
  highest close since entry. The trailing stop is the loss cutter: on the
  dev window it closes the one losing trip at -16 bps gross instead of
  letting it bleed to the -50 stop.
- **Execution:** signals are computed on the bar close just sent; orders
  fill at the next bar's open (1-bar latency). The entry price is read
  from the batch fills, never guessed from a close.

## Why these numbers

A ~10,000-configuration grid search over dip depth, vol-gate definitions
and thresholds, take-profit/stop-loss, and exit modes (plain TP/SL, TP
above the old high, let-it-run-to-the-high, trailing stops), scored with
an exact-integer replica of the fill engine and confirmed with the kit's
own grader. The literal "TP70/SL50" reading of the brief tops out at
+$7.98; TP80 is worth +$12.48, and TP85+ collapses because the second
trip's rebound (+72 bps gross) never reaches it. Letting winners run to
the old high scores +$6.38 at best, and waiting for high+70 loses money.
The trailing stop is what makes the third trip survivable: without it the
same entries score +$6.89.

## Backtest (dev window, `grade-local --driver process`)

Verified with the kit's own local grader, twice (identical action logs):

| Metric | Round 3 | Round 2 (EMA 9/48, TP 0.5%) | Round 1 (EMA 12/48, TP 1.0%) |
| --- | --- | --- | --- |
| Net PnL (dev) | **+$12.48** | +$10.00 | +$7.71 |
| Trades (fills) | 6 (3 round trips, 2 won) | 4 (2 round trips, 2/2 won) | 2 (1 round trip) |
| Max drawdown | 0.58% | 0.45% | 0.60% |
| Fees paid | $2.42 | $1.61 | — |
| Exposure | 16.7% of bars | 7.2% of bars | — |
| Dev gate (`dev_profitable`) | pass | pass | pass |

The three trips: +92.8 bps gross (dip at bar 68, sold bar 159),
+71.8 bps gross (the 141 bps dip at bar 515, sold bar 609), and -15.8
bps gross (a late-window dip at bar 1349, cut by the trailing stop).
Cost sensitivity (fees doubled): still **+$10.06**. Per-half PnL:
+$14.90 in the first half, -$2.42 in the second — the bot does lose a
little in the grind-down half, but the trailing stop bounds the loss to
one small trip.

## Robustness, stated honestly

- Plateau, not a spike: TP80 is the best take-profit at every trailing
  value; trail 35-50 bps all score +$11.15 or better; dip 55-60 bps both
  score +$12.48 or better; dip-max 150+ and any stop-loss all score the
  same (the trailing stop exits first).
- Fragile dimension: the vol gate. ATR(10) >= 8 bps is a knife-edge —
  6 gives +$3.94, 10 gives -$8.26 — because it selects exactly the two
  profitable dips (ATR(10) reads 8.16 and 8.51 at the entries). The rule
  itself is sensible (only buy dips when the market is moving), but its
  threshold was tuned on two events, and the race window may offer
  different ones.
- On the $24.57 claim: not reached, and not reachable by this family.
  The best possible 3 round trips on this window (oracle, computed with
  the exact fill engine) total +$26.24 — but they need per-trip optimal
  exits (+116, +96, +72 bps gross) that no single causal rule reproduces:
  a uniform TP110 to catch the first one kills the second, and a
  trailing-only exit cuts the winners early. +$12.48 is the best
  rule-based result found; it beats round 2 by +$2.48 (+25%).

## Run

```sh
node main.ts   # the grader runs: node /bot/main.ts
```

## Files

- `main.ts` — the bot (TypeScript, Node 22, erasable syntax only).
- `vendor/makefun-bars.ts` — byte-identical copy of the kit SDK shim.
- `LICENSE` — MIT.
