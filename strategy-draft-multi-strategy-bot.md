# Solana Dynamic Multi-Strategy Trading Bot (AI-drafted, for audit)

> Source: https://www.coincidenceai.xyz/chat/chat_1507_1781004999
> Status: AI-generated draft pasted by user 2026-06-09. NOT verified, NOT wired
> into RogueZero. Several blocks arrived truncated/mangled by markdown (entry
> conditions cut off, Python code partially corrupted). Saved verbatim below for
> reference; see AUDIT section at bottom for what is usable vs what conflicts
> with RogueZero's real architecture.

---

## Supertrend + Momentum + Mean Reversion with Trailing TP & Dynamic SL

### Strategy Overview
This bot combines three rotating strategies with dynamic position sizing, trailing
take profits, and adaptive stop losses for Solana network tokens (SOL/USDC or
SOL/USDT pairs).

---

## Strategy Components

### 1. Supertrend Strategy
**Purpose**: Trend following with momentum confirmation

**Entry Conditions (Long)**:
- Supertrend indicator flips bullish (price > supertrend line)
- ATR period: 10
- Multiplier: 3.0
- Volume > 20-period average volume
- RSI > 50 (momentum confirmation)

**Entry Conditions (Short)**:
- Supertrend indicator flips bearish (price < supertrend line)
- Volume > 20-period average volume
- RSI < 50

*(NOTE: original paste truncated the short block here.)*

---

### 2. Momentum Breakout Strategy
**Purpose**: Capture explosive moves

**Entry Conditions (Long)**:
- RSI crosses above 60 from below
- MACD line crosses above signal line
- Price breaks above 20-period EMA
- Volume spike: Current volume > 1.5x average volume
- ADX > 25 (strong trend)

**Entry Conditions (Short)**:
- RSI crosses below 40 from above
- MACD line crosses below signal line
- Price breaks below 20-period EMA
- Volume spike: Current volume > 1.5x average volume
- ADX > 25

**Exit**:
- Trailing stop: 1.5% from peak
- Dynamic SL: Moves to breakeven when profit > 2%
- TP targets: 4%, 7%, 10% (scale out: 50%, 30%, 20%)

---

### 3. Mean Reversion Strategy
**Purpose**: Buy dips in uptrends, sell rallies in downtrends

**Entry Conditions (Long)**:
- Price < 20-period Bollinger Band lower band
- RSI < 30 (oversold)
- Price > 200-period EMA (uptrend context)
- Price deviation from mean: > 2 standard deviations

**Entry Conditions (Short)**:
- Price > 20-period Bollinger Band upper band
- RSI > 70 (overbought)
- Stochastic RSI > 80
- 50-period EMA < 200-period EMA (downtrend context)

*(NOTE: original paste mangled the deviation/EMA comparisons here.)*

---

## Dynamic Position Sizing (as pasted, partially corrupted)

```python
def calculate_position_size(account_balance, base_risk, volatility, win_rate, consecutive_losses):
    risk_multiplier = 1.0

    # Volatility adjustment
    if volatility > 1.5:        # High volatility
        risk_multiplier = 0.7
    elif volatility < 0.6:      # Low volatility
        risk_multiplier *= 1.2

    # Win-rate adjustment (paste was truncated; intent inferred)
    # elif win_rate < threshold: risk_multiplier *= ...

    # Consecutive-loss throttle
    if consecutive_losses >= 3:
        risk_multiplier *= 0.5
    elif consecutive_losses >= 2:
        risk_multiplier *= 0.75

    # Calculate position size
    adjusted_risk = base_risk * risk_multiplier
    position_size = account_balance * adjusted_risk

    # Cap at 5% max risk
    position_size = min(position_size, account_balance * 0.05)

    return position_size
```

---

## Strategy Rotation Logic (as pasted, truncated)

```python
def select_active_strategy(market_conditions):
    """Rotate between strategies based on market regime"""
    volatility = calculate_atr_normalized()
    trend_strength = calculate_adx()
    market_regime = detect_regime()  # trending, ranging, volatile

    if market_regime == "trending" and trend_strength > 25:
        return "supertrend"
    elif market_regime == "volatile" and volatility > 1.5:
        return "momentum_breakout"
    elif market_regime == "ranging" or volatility < 1.5:
        return "mean_reversion"
    # (paste truncated here)
```

---

## Trailing Take Profit Implementation

```python
def update_trailing_tp(entry_price, current_price, position_type, highest_price, lowest_price):
    """Dynamic trailing take profit that locks in profits"""
    if position_type == "long":
        highest_price = max(highest_price, current_price)
        profit_pct = (current_price - entry_price) / entry_price

        if profit_pct > 0.10:      # 10%+ profit
            trail_distance = 0.015  # 1.5% trail
        elif profit_pct > 0.05:    # 5%+ profit
            trail_distance = 0.02   # 2% trail
        else:
            trail_distance = 0.025  # 2.5% trail

        trailing_stop = highest_price * (1 - trail_distance)
        return trailing_stop

    elif position_type == "short":
        lowest_price = min(lowest_price, current_price)
        profit_pct = (entry_price - current_price) / entry_price

        if profit_pct > 0.10:
            trail_distance = 0.015
        elif profit_pct > 0.05:
            trail_distance = 0.02
        else:
            trail_distance = 0.025

        trailing_stop = lowest_price * (1 + trail_distance)
        return trailing_stop
```

---

## Dynamic Stop Loss Implementation

```python
def calculate_dynamic_stoploss(entry_price, current_price, atr, position_type, time_in_trade):
    """Adaptive stop loss that adjusts based on market conditions and trade duration"""
    if position_type == "long":
        initial_sl = entry_price - (2 * atr)   # 2x ATR below entry

        profit_pct = (current_price - entry_price) / entry_price
        if profit_pct >= 0.02:                 # breakeven after 2% profit
            breakeven_sl = entry_price * 1.001
            return max(initial_sl, breakeven_sl)

        if time_in_trade > 240:                # tighten after 4h (minutes)
            time_adjusted_sl = entry_price - (1.5 * atr)
            return max(initial_sl, time_adjusted_sl)

        return initial_sl

    elif position_type == "short":
        initial_sl = entry_price + (2 * atr)

        profit_pct = (entry_price - current_price) / entry_price
        if profit_pct >= 0.02:
            breakeven_sl = entry_price * 0.999
            return min(initial_sl, breakeven_sl)

        if time_in_trade > 240:
            time_adjusted_sl = entry_price + (1.5 * atr)
            return min(initial_sl, time_adjusted_sl)

        return initial_sl
```

> User noted: "AND THERE IS A LOT MORE" — this paste is partial. Get the rest
> before treating any of it as a complete spec.

---
---

# AUDIT — what's usable, what conflicts with RogueZero (verified 2026-06-09)

Read against the real code: `services/worker/src/index.ts`,
`packages/runtime-config/src/index.ts`, and prod data (Tiger `pu4a5j80ut`).

## TL;DR
This draft is a **conventional long/short TA bot for a CEX with shorts, percentage
stops, and full OHLCV+volume+RSI+MACD+ADX feeds.** RogueZero is a **spot,
long-only, Solana DEX (Jupiter) bot** that already runs Supertrend + Momentum +
Mean-Reversion rotation. So the *structure* matches what we have, but several
**core assumptions do not hold for us**. Treat it as an idea source for the
exit/sizing logic, NOT as a drop-in.

## What CONFLICTS with our architecture (do not adopt as-is)
1. **Shorts.** Every strategy has a "Short" leg. We are **spot long-only** on
   Jupiter — there is no short. ~50% of this spec is dead for us. Ignore all
   short blocks.
2. **Percentage stops/TPs (2%, 4%, 7%, 10%).** Our system is **bps-denominated**
   and cost-aware. A 2% (200 bps) stop and 4-10% TPs are an order of magnitude
   wider than our reality (major MFE p75 ≈ 94 bps; real round-trip cost ≈ 30-60
   bps). These percentages would almost never trigger on the tokens/timeframe we
   actually trade. Useful as *shape*, wrong as *numbers*.
3. **Volume / RSI / MACD / ADX / Stochastic / Bollinger as hard gates.** These
   need a reliable OHLCV+volume feed. Our non-SOL signal source is GeckoTerminal
   1-min candles with a documented fallback to a thin "blind" Jupiter drift poll.
   Adding 5 more indicator gates on a feed that already fails for top tokens
   (JTO, BONK) would mostly produce "no data → no trade," not better entries.
4. **CEX framing (Bybit/KuCoin order types, TIF).** We submit signed swaps via
   Jupiter Router + Helius. No maker/taker order book, no TIF. Execution section
   does not map.

## What is GENUINELY USEFUL (worth adapting to bps, long-only)
1. **Trailing TP that widens as profit grows** (`update_trailing_tp`). This is the
   *opposite* of our current bug: we have a fixed cost-floored TP (180 bps) that's
   rarely hit while winners give back gains. A profit-scaled trail (lock more as
   MFE rises) directly attacks our "winners round-trip back to red" problem.
   → Adapt to bps: e.g. trail 60 bps until +120, then tighten.
2. **Move stop to breakeven after a profit threshold.** We have NO breakeven
   logic — losers run to -509. A "once +X bps reached, stop can't go below
   entry+fees" rule is exactly the bleed-stop lever already on our plan.
3. **ATR-based stop (2x ATR) instead of a fixed floor.** Aligns with the article
   you saved earlier ("trend-following needs ATR stops"). Our stop is dead-coded
   to -120; an ATR/peak-anchored stop is the right replacement. (We already have
   an ATR exit-profile path, flag-gated — this validates expanding it.)
4. **Consecutive-loss throttle on sizing.** Reduce size after 2-3 losses. We have
   stop-loss cluster locks but not a per-session loss-streak size taper. Cheap,
   defensible risk control.
5. **Regime-gated rotation** (`select_active_strategy`). Conceptually matches our
   rotation; the explicit `ADX>25 → trend, vol>1.5 → breakout, else mean-revert`
   mapping is a cleaner regime router than what we may have. Worth comparing.

## What is WRONG / risky in the draft itself (independent of us)
- Code is **truncated and partly corrupted** (cut entry conditions, missing
  win-rate branch, broken comparisons). Cannot be run as pasted.
- `time_in_trade > 240` "minutes = 4h": fine for swing, but our holds are short;
  this constant would need re-derivation from our actual hold-time distribution.
- "Cap at 5% max risk" per trade is **very aggressive** for a 150-350 bot fleet
  on illiquid Solana tokens. Our caps are far tighter (maxPositionSizeUsd, per
  cluster). Do not import the 5%.
- No mention of **price impact / liquidity gating** — the #1 thing that actually
  hurt us (pump tokens -500 to -719). This spec would happily enter illiquid
  names. We must keep our liquidity/core-universe gates on top of any of this.

## Net recommendation
Mine THREE ideas from this, converted to bps + long-only + cost-aware, and test
on Noah one at a time:
1. **Profit-scaled trailing TP** (replaces rarely-hit fixed 180 TP).
2. **Breakeven-after-profit stop + ATR/peak-anchored stop** (replaces dead -120
   floor; stops the -509 runners).
3. **Consecutive-loss sizing taper** (cheap fleet-wide risk control).

Discard: all short logic, percentage thresholds, extra indicator hard-gates on
our unreliable feed, CEX order-type framing, and the 5% risk cap.
