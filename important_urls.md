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
  ~110-150 bps (per-trade platform fee was 35 bps × 2 legs = 70 bps alone, NOW DISABLED to 0) while captured moves
  were only **13-27 bps**. Per-trade fee removed; 0.33% performance fee at session end agreed instead (NOT YET BUILT).
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

---

## 5. Jupiter + Solana official docs (execution / cost / SOL-funded path)

Added 2026-06-09 to diagnose the SOL-funded bot (RogueCEO) cost problem. These are
the authoritative pages for our Router (`/build`) execution path. Research notes
are mapped to our verified prod behavior, not generic theory.

### URL list (as provided)
- Solana token extensions: https://solana.com/docs/tokens/extensions
- Solana transfer-fee extension: https://solana.com/docs/tokens/extensions/transfer-fees
- Solana JS client: https://solana.com/docs/clients/official/javascript
- Jupiter rate limits: https://developers.jup.ag/docs/portal/rate-limits
- Jupiter order & execute: https://developers.jup.ag/docs/swap/order-and-execute
- Jupiter build (Router): https://developers.jup.ag/docs/swap/build
- Jupiter common instructions: https://developers.jup.ag/docs/swap/build/common-instructions
- Jupiter submit: https://developers.jup.ag/docs/transaction/submit
- Jupiter reduce tx size: https://developers.jup.ag/docs/swap/advanced/reduce-transaction-size
- Jupiter reduce latency: https://developers.jup.ag/docs/swap/advanced/reduce-latency
- Jupiter compute units: https://developers.jup.ag/docs/swap/advanced/compute-units
- Jupiter slippage (RTSE): https://developers.jup.ag/docs/swap/advanced/slippage
- Jupiter API ref /order: https://developers.jup.ag/docs/api-reference/swap/order
- Jupiter API ref /execute: https://developers.jup.ag/docs/api-reference/swap/execute
- Jupiter swap overview: https://developers.jup.ag/docs/swap
- Jupiter docs repo: https://github.com/jup-ag/docs
- Jupiter org: https://github.com/jup-ag
- TeamRaccoons (Metis/router): https://github.com/TeamRaccoons

### Hard facts pulled from the docs (verbatim-accurate)

**Rate limits** (per *account*, NOT per key; 60s sliding window):
- Keyless 0.5 / Free 1 / Developer 10 / Launch 50 / **Pro 150 RPS** general.
- `/swap/v2/execute` and `/tx/v1/submit` have **their own dedicated buckets**,
  separate from general and from each other: Keyless 20 / Free 50 / **Paid 100 RPS**.
- → Our Jupiter is Pro: **150 RPS general + 100 RPS dedicated /submit**, all 3 keys
  share one account bucket. Matches our `roguezero-constraints.md`.

**Router `/build` defaults** (the path we use, per CLAUDE.md):
- `slippageBps` **defaults to 50 (fixed 0.5%)** on `/build`. RTSE is **opt-in** — you
  must pass the literal string `slippageBps=rtse` to get Jupiter's real-time
  estimator. Meta-aggregator `/order` gets RTSE automatically; Router does NOT.
- `platformFeeBps` default 0; needs `feeAccount`. Fee is added inside the swap
  instruction; `feeAccount` is any SPL token account we control (no referral
  program needed). → per-trade fee now disabled (0); 0.33% performance fee at session end agreed (NOT YET BUILT).
- `maxAccounts` default 64 (1-64). `mode=fast` (BETA) for low-latency routing.
- `computeBudgetInstructions` returns the **CU price but NOT the CU limit** — the
  integrator must simulate and set the limit themselves.

**Compute units = priority-fee cost (the SOL-cost lever):**
- `priority fee = compute unit price × compute unit limit`.
- Doc's exact warning: *"Setting it to the maximum (1,400,000) when you only use
  200,000 means you pay 7x more than necessary."*
- Correct flow: simulate with max CU → take `unitsConsumed` → set limit to **1.2×
  simulated** (capped at 1.4M) → add the CU price instruction from `/build`.
- `computeUnitPricePercentile`: "medium"=25th, "high"=50th (default), "veryHigh"=75th;
  `mode=fast` with no percentile defaults to the **90th** percentile.

**`/submit` (Jupiter landing) requires a SOL tip:**
- **Minimum tip 1,000,000 lamports = 0.001 SOL** to one of 16 tip accounts.
- `/submit` does NOT simulate (sends straight to TPU). Randomize tip account to
  avoid write-lock contention. Dedicated 100 RPS bucket on Paid.
- NOTE: per CLAUDE.md we submit via **Helius RPC**, not Jupiter `/submit` — so the
  0.001 SOL Jupiter tip does **not** apply to us. But the same principle applies to
  any Helius Sender tip we attach: a fixed lamport tip is a flat per-trade SOL cost
  that hits small SOL-funded trades hardest.

**Reduce tx size:** `maxAccounts` lower = simpler route (warning: <50 can break
routing/pricing). The `/build` setup instructions always include
`createAssociatedTokenAccountIdempotent` even when the ATA exists — these are no-ops
that still consume tx bytes; can be stripped with a `getAccountInfo` check.

**Token-2022 transfer-fee extension (PnL correctness):** `TransferFeeConfig` mints
deduct a fee on **every transfer**, withheld on the destination account. The
*received* amount is less than the *sent* amount by the fee. If RogueZero ever
routes into a Token-2022 transfer-fee mint, our on-chain *received delta* already
reflects the fee — but any sizing/PnL math that assumes received == quoted-out will
be wrong. Our wallet-truth reconcile (tracks actual on-chain balances) is the
correct defense; quote-based position math is not.

### Direct mapping to the SOL-funded bot bug (RogueCEO, verified 2026-06-09)

RogueCEO (SOL-funded) now sizes entries correctly (~$4.16 after the economic-floor
fix) but every entry is cancelled `entry_edge_below_cost` — the **round-trip cost**
the gate computes is bigger than the edge. The docs point at three concrete,
checkable cost levers that disproportionately hurt the SOL-funded path:

1. **CU limit may be inflated → priority fee 7× too high.** If our worker sets the
   CU limit to a fixed max (1.4M) instead of `1.2 × simulated unitsConsumed`, every
   trade overpays priority fee by up to 7×. That inflates
   `estimatedNetworkCostLamports`, which feeds BOTH our economic floor AND the
   `entry_edge_below_cost` gate. ACTION: verify the worker simulates and sets a
   tight CU limit; if it uses a fixed max, fix it — this is the single highest-value
   SOL-cost reduction in the docs.
2. **Fixed lamport tip is a flat SOL tax on small trades.** Whatever tip we attach
   (Helius Sender) is a constant lamport cost. On a $4 SOL trade it is a large bps
   share; on a $10 USDC trade it is small — which is exactly why USDC bots (Foxy)
   clear the cost gate and SOL RogueCEO does not. ACTION: confirm the per-trade tip
   size and whether it scales or is flat; consider a smaller/scaled tip for small
   SOL entries.
3. **We may be on fixed 50-bps slippage, not RTSE.** Router `/build` defaults to a
   FIXED 0.5% slippage unless we pass `slippageBps=rtse`. Fixed slippage that is too
   wide widens the modeled cost; too tight raises failure/retry cost. ACTION: verify
   what slippage value we send to `/build` and whether RTSE would model cost more
   accurately for our exit-heavy tokens.

> Net for the SOL problem: the floor/sizing fix was necessary but the remaining
> `entry_edge_below_cost` block is a COST-MODEL problem. The docs say the dominant,
> controllable SOL cost is priority fee = CU price × CU limit, and the #1 mistake is
> a fixed max CU limit. That is the next thing to verify in our `/prepare` code
> before touching the edge model.
