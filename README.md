# cbBTC Trend Rider — Race a BTC trading bot live for 24 hours

[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/mutiafebrizki-ship-it/btc-race-24h-20261123-0511/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/mutiafebrizki-ship-it/btc-race-24h-20261123-0511/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)

Entry for the [make.fun bounty "Race a BTC trading bot live for 24 hours"](https://make.fun/bounty/btc-race-24h-20261123-0511): a bot that trades Coinbase Wrapped BTC (cbBTC) on 1-minute on-chain prices with $1,000 of paper money. Simulation only — no real money is traded.

## Strategy

One asset, one-minute bars, long only. A 1-minute bar moves ~8 bps while a full-size round trip costs ~30–40 bps in fee, slippage and pool impact, so the bot trades rarely and holds:

- **Trend ride:** EMA(30) vs EMA(90) crossover, with 60-minute momentum positive and RSI(14) under 75, buys. The first trade of the window is half size (the opening bars carry almost no history); it is topped up to full size once 2-hour momentum confirms (> +0.8%) and the slow EMA is rising. A backup entry buys a strong established uptrend near its 240-bar high in case the cross was missed.
- **Re-entry discipline:** after a trend exit, a new entry needs a genuine regime reset — the fast EMA spending 180+ consecutive bars under the slow one. At most 2 trend trades per window.
- **Mean-reversion insurance:** a tiny (15% of equity) oversold-bounce buy (RSI ≤ 25 and price > 1.8 std below its 20-bar mean) so a flat or falling window still records at least one trade; at most 2, sold quickly.
- **Risk:** exit everything on a cross down, on −1.5% vs average cost (−0.8% for an unconfirmed early half position), or on a 2.5% trailing pullback from the highest close since entry. No shorts, no leverage, one open position, at most one order per reply.

Deterministic: float64 math on the bars only — no clock, no randomness, no network, no files outside the repo. Same bars give the same orders.

## Local dev grade

Graded with the kit's own replay (`node cli/makefun.mjs grade-local --kit . --bot . --driver process`):

- **Net PnL: +20.24 USDC** after all fees (2x-fees: +19.18 USDC)
- **Trades: 7**, max drawdown 1.81%, guardrails met

## Layout

- `main.ts` — the bot (Node 22, TypeScript via type stripping)
- `vendor/makefun-bars.ts` — byte-identical copy of the kit's `agent-fun/bars-replay/v1` SDK shim
- `LICENSE` — MIT

## License

SPDX-License-Identifier: MIT — see [LICENSE](LICENSE).
