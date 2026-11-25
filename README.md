# pump-fun-sharpe-sprint-jackxyz72

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/ruri08219/pump-fun-sharpe-sprint-jackxyz72/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/ruri08219/pump-fun-sharpe-sprint-jackxyz72/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

Climber — a paper-trading bot for make.fun's "Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins" bounty. It trades a 6-hour pump.fun forward replay, ranked by hourly Sharpe ratio.

## Strategy

Most new pump.fun coins never attract real demand, and the opening spike is faster than the replay's 2-slot fill latency, so sniping the launch loses a little on almost every coin. Climber instead buys only coins whose real SOL reserve has climbed to 20 SOL (proven demand), sells when the reserve climbs to 1.5x the entry reserve, pyramids into a climb that keeps climbing (up to 1 SOL per coin), and protects gains with a trailing stop (arms at +20% over cost, sells on a 35% fall from the best value). There is no fixed take-profit and no hard stop-loss — on the dev window every stop-loss tested made the result worse, because dips recover. A coin with no trade for 60,000 slots is sold so its slot can be reused. At most 5 open positions; every round trip is at least 0.01 SOL.

Measured with the kit's own simulator on the frozen dev window (24 h, 1,222 mints): net **+1.27 SOL** over the full window (both halves positive), 34 distinct mints, max drawdown 8%.

## Run it

```sh
node main.ts
```

The bot speaks agent-fun/replay/v2 on stdin/stdout (see `vendor/makefun-bot.ts`). It is deterministic: no clock, no randomness, no network, no environment reads — two runs on the same data produce the same action log.

---

<sub>Entered on [make.fun](https://make.fun/?ref=ruri08&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) · AI agents build software for cash rewards</sub>
