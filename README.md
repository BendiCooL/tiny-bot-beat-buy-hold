# Tiny Bot — Beat Buy-and-Hold on Solana

[![make.fun](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![rank](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/BendiCooL/tiny-bot-beat-buy-hold/rank.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![reward](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/BendiCooL/tiny-bot-beat-buy-hold/reward.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)

A tiny paper-trading bot for the [make.fun bounty "Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana"](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1). It reads hourly Solana bars and decides when to hold and when to sit in USDC — aiming to beat buy-and-hold on net PnL.

## Strategy

Trend-filtered momentum rotation, long only, no leverage, no shorts:

- **Enter** when EMA(8) is above EMA(21) **and** the 12h return is positive, strongest candidates first (ranked by 12h return), up to 3 open positions.
- **Exit** the whole position when EMA(8) crosses back under EMA(21), when the 12h return falls below −2%, on a −5% stop-loss from cost, or on a +20% take-profit.
- **Stake**: equity / 3 per slot, capped at the 25% max-weight cap. Sells go out before buys; a sell's proceeds never fund a buy of the same reply.
- **Deterministic**: float64 math on closes only — no clock, no environment, no randomness. Slippage capped at 100 bps.

Why it beats buy-and-hold: buy-and-hold sits in every asset, losers included, for the whole window. This bot only holds assets in an uptrend with positive 12h momentum, sits in cash otherwise, and cuts losers at −5% instead of riding them down.

## Local dev score

Graded with the kit's own grader on the published dev window (136 hourly bars, 7 symbols, $10,000 paper capital):

| | Net PnL | Return | Max drawdown | Trades |
|---|---|---|---|---|
| **Tiny Bot** | **−$210.86** | −2.11% | 3.42% | 19 |
| Buy-and-hold | −$869.34 | −8.69% | 10.92% | 7 |

Parameters were chosen by testing rolling 72-bar windows (the final window's length): this set kept at least 9 trades in every window (guardrail: 8) while losing far less than buy-and-hold in each.

## Files

- `main.ts` — the bot (Node 22, TypeScript, stdlib only; speaks `agent-fun/bars-replay/v1` on stdin/stdout)
- `vendor/makefun-bars.ts` — the kit's protocol shim (byte-identical copy of the kit's `sdk/makefun-bars.ts`)
- `LICENSE` — MIT

## Run it

```sh
node cli/makefun.mjs grade-local --kit <kit-dir> --bot . --driver process --worktree
```
