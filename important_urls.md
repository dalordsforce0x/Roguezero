# Important URLs

A running list of high-value external references, with research notes mapped to
RogueZero's real, verified state (not generic theory).

---

## 1. Coincidence AI — "Automated Crypto Trading Strategies That Actually Work"

- **URL:** https://www.coincidenceai.xyz/blog/automated-crypto-trading-strategies
- **Author / date:** Antonio Bisignani, December 16, 2025
- **Why it matters here:** It is a structured field guide to *why automated
  strategies fail* and *what makes one viable*. RogueZero is exactly the kind of
  system it describes (automated, multi-bot, non-custodial, staged rollout via a
  Noah canary). Below is heavy research on the page, then a direct mapping to
  RogueZero's verified code/data.

### Related pages from the same blog (for later reading)
- https://www.coincidenceai.xyz/blog/crypto-trading-patterns
- https://www.coincidenceai.xyz/blog/crypto-trading-bot-strategies
- https://www.coincidenceai.xyz/blog/crypto-swing-trading-strategy
- https://www.coincidenceai.xyz/blog/most-volatile-crypto-for-day-trading
- https://www.coincidenceai.xyz/blog/best-time-to-trade-crypto
- https://www.coincidenceai.xyz/blog/can-you-make-money-trading-crypto

---

## Heavy research notes — what the article actually teaches

### A. The four parts of any strategy (the article's mental model)
A strategy is four parts running in sequence:
1. **Signal definition** — the conditions that trigger a trade (MA crossover,
   composite indicators, event rules).
2. **Order execution logic** — order types, sizes, routes chosen to minimize
   slippage.
3. **Risk controls** — daily loss limits, max position sizing, circuit breakers.
4. **Monitoring / telemetry** — logging fills, PnL, alerts so you can inspect
   *what happened and why*.

> Core claim: execution **consistency** is a primary edge. Inconsistent
> execution erodes returns over months *more than a single bad signal*.

### B. Hard numbers the article cites
- >70% of crypto trading volume is driven by bots (you trade against machines).
- ~70% of strategies fail due to **weak risk management**, not weak alpha.
- Only ~10% of automated strategies stay profitable long-term.
- 70% of strategic initiatives fail on **execution**, not idea quality.
- Disciplined execution orgs outperform peers by ~20%.

### C. The 4 core strategy archetypes (and each one's failure mode)
1. **Trend-following** — ride confirmed directional moves; trade infrequently.
   - *Failure mode:* friction in **ranging markets** — repeated small losses pile
     up without volatility filters / adaptive stops.
   - *Fix:* trend-strength thresholds, **ATR-based stops**, skip low-vol stretches.
2. **Mean reversion** — bet that extremes unwind to a local average.
   - *Failure mode:* strong momentum runs far past historical ranges; a small
     losing streak becomes a catastrophic drawdown.
   - *Fix:* tight sizing, staggered scaling, **time-based stopouts**, zero
     exposure after a loss sequence.
3. **Breakout** — trigger when price exits a range (vol expansion / volume).
   - *Failure mode:* **false breakouts / whipsaws** blow through stops.
   - *Fix:* require multi-timeframe + liquidity/flow confirmation; **graduated
     exposure** (add on confirmation, not full size up front).
4. **Time/session-based** — trade specific windows (open hour, events).
   - *Failure mode:* scheduled trades running unchecked into abnormal events.
   - *Fix:* intraday risk ceilings + automated kill switches.

> **The single most quoted lesson:** *If your strategy does not explicitly encode
> WHEN NOT TO TRADE, it will lose edge.* Trend-followers bleed in ranges,
> mean-revertors blow up in momentum, breakouts get chopped — all from the same
> omission. Build **trade-suppression rules, blackout windows, and circuit
> breakers before scaling size.**

### D. Why most strategies fail (operational truth)
- **Operational fragility:** dropped feeds, API rate limits clipping orders,
  partial fills creating phantom positions, exchange margin/funding behaving
  unlike the backtest.
- **Human-workflow gaps:** deploys without a runbook, monitoring, or an agreed
  kill procedure → a recoverable blip becomes a full drawdown because *response
  time matters more than clever signals*.
- **Invisible technical bugs:** feature leakage, stale reference data, timezone
  mismatches, differing candle aggregation, unsimulated slippage/fees/latency.
  "A pleasant backtest that dies on the first heavy-volume day."
- **Automation magnifies small mistakes:** a weak/unfiltered signal executed
  thousands of times/day compounds losses faster than any human could.

### E. What makes a strategy actually viable
- **Continuous validation, not one-off backtests:** tie each fill back to the
  exact trigger; measure realized vs projected slippage; auto-flag divergence.
- **Test for brittleness without overfitting:** walk-forward windows, parameter
  stability checks, **Monte Carlo resampling** of trade sequences, and
  transaction-cost perturbation (fees, latency, partial fills). "A rule that
  fails under modest fee/slippage shifts is an artifact, not an algorithm."
- **Risk architecture is hierarchical, not just per-trade:** combine per-trade
  risk + per-instrument exposure + daily portfolio drawdown ceiling; add
  correlation-aware sizing and automatic deleveraging when correlations spike.
- **Defensive patterns:** ensemble/voting to denoise a single signal;
  degrade-to-safe (scale exposure to zero on abnormal telemetry); blackout
  windows; **canary traffic** that halts on mismatch.

### F. The "Hidden Barrier" — idea → executable contract
- Decompose the idea into **atomic predicates** (each returns true/false, named
  inputs, expected units/ranges).
- Attach an **order template** to each trigger (order type, TIF, routing
  priority, slippage tolerance).
- Add an explicit **failure-mode section** (partial fills, rate-limit errors,
  maintenance windows).
- Codify **invariants** ("exposure never exceeds X%", "cumulative realized
  slippage stays within Y bps") and unit-test predicates against synthetic
  candles + oddball timestamps. *Treat parameters as contracts, not suggestions.*
- **Staged rollout:** e.g. 0.1% capital for 24h → 1% for 7 days → scale only
  after thresholds hold. Immutable audit logs tie every param change to user +
  timestamp + rationale.

---

## Direct mapping to RogueZero (verified against code + prod data 2026-06-09)

The article is unusually on-point for our exact situation. Mapping its lessons to
what we have actually proven in this codebase:

| Article lesson | RogueZero status (verified) |
|---|---|
| "Encode WHEN NOT TO TRADE" | Our entry gate (`assessTradeGate`, index.ts L5667-5687) fires on momentum just over threshold (12) + buffer (5) — **no move-size / volatility / round-trip-cost filter**. Logs show entries at momentumBps 52/53/58/67 indiscriminately. This is exactly the missing "don't trade" rule. |
| Trend-following bleeds in ranges; needs ATR stops + vol filter | Our loss engine is **supertrend** (~21% win rate, 529 stop-outs vs 140 TP over 7d). Same failure mode the article names. |
| Risk management is the #1 failure (70%) | Stop-loss is silently forced to **-120 bps** (configured 50 is dead code, L5925); losers run to **-509**. Hierarchical/peak-anchored stop is missing. |
| Simulate realistic slippage/fees/latency | Real round-trip cost is **low** (network ~14.5k lamports ≈ 0 bps, platform fee 0 on 668/816 swaps, price impact p50 ~2.2 / p90 ~46 bps/leg) — but we enforce a **120-bps floor**, ~2-4x reality. Mis-modeled cost → unreachable TP (180 vs major MFE p75 ≈ 94). |
| Staged rollout / canary | We **have** this: Noah canary (`Fu23Ra8...`) tested before fleet promotion via `WORKER_GRADUATED_FEATURES`. Keep it. |
| Continuous validation, tie fill → trigger | We have `swap_executions` + `exit_shadow_decisions` telemetry, but **no per-trade realized PnL** stored; reconstruction is manual. Gap vs article's "tie each fill back to the exact trigger." |
| Correlation-aware sizing / per-cluster caps | We **have** clusters (`TOKEN_CLUSTER_BY_MINT`, sol_beta/btc/stable) + `WORKER_MAX_OPEN_PER_CLUSTER`. Aligned with article. |
| Trade-suppression / blackout / circuit breakers | Partial: `WORKER_ENTRY_CORE_UNIVERSE_ONLY` (pump-token leak closed by today's 10:14 UTC deploy), reject-cooldowns, flat-regime suppression. No event-blackout windows. |
| Only ~10% stay profitable; weak signal x1000 = fast loss | Matches our over-trading drain: JTO **-90 bps over 86 trades** = biggest volume bleed despite tiny per-trade edge. |

### The two highest-value article lessons for our current work
1. **"Encode when NOT to trade."** → Entry selectivity: require expected favorable
   move to clearly exceed the **full round-trip cost** (both legs + fee + buffer),
   not just the single entry leg. Directly serves our agreed target metric:
   *realized gross edge per trade − round-trip cost > 0 on Noah.*
2. **ATR-based / adaptive stops over fixed friction floors.** → Replace the dead
   fixed -120 stop with a peak-anchored / ATR stop so losers can't run to -509,
   paired with the selective entries (article warns a naive tight stop alone just
   gets whipsawed — matches our MAE p50 -72).

> Net: the article independently validates the entry-selectivity-first +
> bleed-stop-second plan already agreed with the user, and frames it as the
> textbook fix for a trend-follower bleeding in ranges with mis-modeled costs.

---

## 2. Coincidence AI — AI-drafted multi-strategy bot spec (for audit)

- **URL:** https://www.coincidenceai.xyz/chat/chat_1507_1781004999
- **What it is:** An AI-generated strategy spec (Supertrend + Momentum +
  Mean-Reversion rotation with trailing TP, dynamic ATR/breakeven SL, dynamic
  position sizing). Pasted by user 2026-06-09 as raw material to fix up for
  RogueZero. Partial paste ("there is a lot more") and partly corrupted by
  markdown.
- **Saved verbatim + full audit:** see
  [strategy-draft-multi-strategy-bot.md](strategy-draft-multi-strategy-bot.md)
- **Audit verdict (short):** Structure matches our 3-strategy rotation, but it
  assumes CEX shorts, percentage stops (2-10%), and full OHLCV+RSI+MACD+ADX
  feeds — none of which fit our spot, long-only, Jupiter/Helius, bps-denominated,
  thin-candle reality. **Mine 3 ideas, converted to bps + long-only + cost-aware,
  test on Noah one at a time:** (1) profit-scaled trailing TP, (2) breakeven +
  ATR/peak-anchored stop, (3) consecutive-loss sizing taper. Discard: all short
  logic, % thresholds, extra indicator hard-gates, CEX order framing, 5% risk cap.

---

## 3. Coincidence AI — "Understanding the Crypto Swing Trading Strategy"

- **URL:** https://www.coincidenceai.xyz/blog/crypto-swing-trading-strategy
- **Author / date:** Antonio Bisignani, Feb 14, 2025
- **Why it matters here:** It is the most direct external confirmation of the
  exact bleed we just proved on the live RogueCEO wallet. The article's central
  warning is the cost-vs-edge math, which is precisely what is killing us.

### Hard claims worth keeping
- **Fee drag is structural and decisive.** Transaction costs can add up to **~2%
  of trading capital per trade**, "a level that can turn attractive backtested
  returns into marginal or negative real returns." Repeated entries/exits compound
  this fast.
- **Risk controls matter more than entry precision.** Fixed-fraction sizing,
  correlation caps, daily loss limits, circuit breakers → cited **~30% improvement
  in risk-adjusted outcomes**. "Position sizing... matters far more than squeezing
  a few extra ticks from entries."
- **Simpler indicator stacks beat complex ones.** Momentum + volume confirmation
  outperformed multi-indicator stacks in a 3-week forward sweep (less overfitting).
- **Win rates of viable systems: 60-70%.** Returns are a byproduct of discipline,
  not the goal. Treat 10-50%/mo figures as *stress-test scenarios*, never promises.
- **Validate in sequence, not at once:** historical backtest → walk-forward →
  ≥3 weeks live paper in the *current* regime → slippage/illiquidity stress test.
  "Automation should be the last step, not the first." Scale in tranches only when
  live median slippage stays at/below the modeled level for the whole window.
- **Behavioral decay is the #1 killer:** tinkering/tightening/averaging-down
  during adverse stretches turns a mechanical edge into a discretionary gamble.
  Design so the human sets cadence + risk params, NOT minute-by-minute exits.
- **Kill conditions:** halt live sizing if 2 of {out-of-sample equity below max DD,
  fill-rate drop / partial-fill spike, correlation drift} occur in one cycle.

### Direct mapping to RogueZero's verified state (2026-06-09)
- **"~2% fee per trade kills edge" → EXACTLY our finding.** Our round-trip cost is
  ~110-150 bps (35 bps platform fee × 2 legs = 70 bps alone) while captured moves
  are only **13-27 bps**. The article's structural warning is our literal P&L.
- **"Sizing > entry precision" → confirmed by our data.** Entry-quality band did
  NOT predict outcome (strong −32.7 bps vs weak −21.9 bps). Stop chasing entry
  selectivity; fix sizing + the cost/exit asymmetry.
- **"60-70% win rate" → we are at ~21% take-profit share** (28 TP of 130 sells).
  We are nowhere near a viable win-rate regime; this is a structural-edge gap.
- **"Daily loss limit / circuit breaker" → we have a per-session capital cap but no
  daily-loss circuit breaker on the bleed; the article says this is non-negotiable.**

---

## 4. Coincidence AI — "4 Crypto Trading Bot Strategies That Actually Work"

- **URL:** https://www.coincidenceai.xyz/blog/crypto-trading-bot-strategies
- **Author / date:** Antonio Bisignani, Dec 15, 2025
- **Why it matters here:** It frames *why retail bots lose* in infrastructure +
  execution + governance terms, and gives concrete sizing/governance rules that
  map cleanly onto our worker.

### Hard claims worth keeping
- **Only ~10% of crypto bots are consistently profitable** (Coincub). >70% of
  traders use bots; >80% of crypto volume is bot-executed → your edge competes
  with software at scale. Plug-and-play templates decay once live frictions appear.
- **Retail structural disadvantage:** public-internet latency, higher slippage,
  delayed fills vs co-located institutions. Backtests that assume clean fills lie.
- **Capacity-based sizing rule (concrete):** if a token's **average daily volume <
  10× your planned order**, reduce size or switch to limit orders to avoid impact.
  Enforce per-pair AND portfolio caps; hard portfolio stop blocks new entries past
  a DD threshold.
- **Execution tweaks move returns more than indicators:** limit ladders in thin
  liquidity, IOC/TWAP for larger fills, adaptive order-sizing that backs off when
  slippage climbs. Measure realized slippage as a first-class live metric.
- **Regime filters are the glue for multi-strategy:** trend filter pauses
  mean-reversion during sustained moves; vol-expansion rule stops grids
  accumulating risk on spikes. Combine at the *sizing* layer, not by stacking
  opposing entries on the same instrument at full size.
- **Governance that keeps it honest:** immutable change log, fixed recalibration
  cadence, automated rollback to last robust checkpoint on divergence, kill
  switches on order rejections / API failures / slippage out of tolerance.
- **Robustness test before trust:** walk-forward (multiple non-overlapping windows)
  + randomized-parameter stress + execution-aware sim (slippage+latency) + Monte
  Carlo trade-order reshuffles. If it only works on one parameter set → fragile.

### Direct mapping to RogueZero's verified state (2026-06-09)
- **"10% of bots profitable" → we are currently in the 90%** on the live
  RogueCEO/Foxy wallets (real users, both red). This is the baseline to beat,
  not a surprise.
- **"ADV < 10× order → reduce size" → we have volatility sizing but no explicit
  ADV/liquidity-capacity gate at entry.** Worth adding as a real, cost-aware gate.
- **"Combine strategies at the sizing layer + regime filter" → matches our
  3-strategy rotation;** the missing piece is the regime filter that makes the bot
  *sit out* flat tapes (our 13-bps-median-favorable churn is exactly trading noise
  in a flat regime).
- **"Kill switch on execution anomalies / slippage" → we should add a daily-loss /
  bleed circuit breaker** distinct from the per-session capital cap.
- **"Govern parameter changes" → reinforces the Noah-canary-first, one-change-at-a-
  time, prove-on-real-data discipline already in force.**
