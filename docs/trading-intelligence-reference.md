# RogueZero — Trading Intelligence Reference

Created: 2026-06-10
Purpose: Permanent reference for the trading concepts, indicators, and strategies
that RogueZero's bot needs to understand. This is the project's education base.
Every indicator here should be understood before implementing or modifying trading logic.

---

## 1. Core Principle: Confluence

No single indicator is reliable alone. Professional trading systems require **confluence** —
multiple independent signals agreeing before taking action.

RogueZero's current problem: it checks price momentum (one dimension) through 23 gates.
That's like asking 23 versions of the same question. What it needs is 3-4 different
questions that all say "yes" before entering.

The minimum confluence set for entries:
1. **Trend direction** — is price going up? (momentum, supertrend, MACD)
2. **Trend strength** — is this a REAL trend or noise? (ADX, volume confirmation)
3. **Market regime** — what kind of market is this? (Bollinger bandwidth, ATR trend)
4. **Overbought/oversold** — am I buying at the top? (RSI, Bollinger %B)

---

## 2. Volume Indicators

### Why Volume Matters
- Volume PRECEDES price. Smart money accumulates before price moves.
- A price move on high volume = conviction. A price move on low volume = noise.
- Our bot has ZERO volume awareness. This is the single biggest gap.

### On-Balance Volume (OBV)
- **What:** Cumulative volume indicator. Add volume on up-candles, subtract on down-candles.
- **Formula:** If close > prev_close: OBV += volume. If close < prev_close: OBV -= volume. If equal: unchanged.
- **Interpretation:**
  - OBV rising + price rising = strong uptrend, volume confirms
  - OBV rising + price flat = accumulation happening, price will follow up
  - OBV falling + price rising = distribution, trend is fake, reversal coming
  - OBV falling + price falling = confirmed downtrend
- **Leading indicator** — predicts price moves but can produce false signals.
- **Use with:** lagging indicators (moving averages) for confirmation.
- **Our data source:** GeckoTerminal OHLCV candles (volume = row[5], currently discarded in parseOhlcvList)

### Relative Volume (RVOL)
- **What:** Current candle volume / average volume over N candles.
- **Formula:** RVOL = current_volume / SMA(volume, N)
- **Interpretation:**
  - RVOL > 2.0 = unusually high volume, move is significant
  - RVOL 1.0-2.0 = normal volume, move is credible
  - RVOL < 0.5 = dead volume, move is likely noise
- **Use for:** Entry filter. Don't buy if RVOL < 1.0 (below average volume).
- **Our data source:** Same GeckoTerminal candles.

### Volume-Price Trend (VPT)
- **What:** Like OBV but weights volume by the MAGNITUDE of price change, not just direction.
- **Formula:** VPT += volume × ((close - prev_close) / prev_close)
- **More sensitive than OBV** because a +5% move counts more than a +0.1% move.
- **Useful for:** Detecting divergences between price and volume-weighted momentum.

### Volume Moving Average (VMA)
- **What:** Simple moving average of volume over N periods.
- **Use for:** Establishing what "normal" volume looks like for a token.
- **Key signal:** Current volume crossing above VMA = volume breakout, often precedes price breakout.

### Key Volume Rules for Our Bot
1. Never enter a trade where RVOL < 1.0 (below average volume)
2. Strong entries require RVOL > 1.5 (above average volume)
3. OBV must be rising (or at least not falling) for a bullish entry
4. Volume + price divergence = early warning of reversal

---

## 3. Trend Strength Indicators

### Average Directional Index (ADX)
- **What:** Measures HOW STRONG a trend is, regardless of direction. Scale 0-100.
- **Components:** ADX line + Positive Directional Indicator (+DI) + Negative Directional Indicator (-DI)
- **Interpretation:**
  - ADX > 25 = strong trend (worth trading)
  - ADX 20-25 = emerging trend
  - ADX < 20 = no trend / choppy (sit out or use mean reversion)
  - ADX > 40 = very strong trend
  - ADX > 50 = extremely strong (rare)
- **+DI vs -DI:**
  - +DI > -DI = bullish trend direction
  - -DI > +DI = bearish trend direction
  - Crossover of +DI above -DI with ADX > 25 = strong buy signal
  - Crossover of -DI above +DI with ADX > 25 = strong sell signal
- **Calculation:** Uses True Range, Directional Movement (+DM, -DM), smoothed over 14 periods.
- **Lag:** ADX is a lagging indicator (based on moving averages of directional movement).
- **Our data source:** Computable from Pyth tape (we have high/low/close price data at 3s cadence).
- **Critical insight for us:** We have ATR (price range/volatility) but NOT ADX (trend strength). These are different things.
  - ATR says "prices move 50 bps per candle" — how volatile
  - ADX says "those moves are consistently in one direction" — how trendy
  - We need both.

### RSI (Relative Strength Index)
- **What:** Momentum oscillator, scale 0-100. Measures speed/magnitude of recent price changes.
- **Formula:** RSI = 100 - (100 / (1 + avg_gain/avg_loss)) over 14 periods.
- **Interpretation:**
  - RSI > 70 = overbought (price may be too high, pullback likely)
  - RSI < 30 = oversold (price may be too low, bounce likely)
  - RSI = 50 = neutral
- **CRITICAL: RSI works best in RANGING markets, NOT trending markets.**
  - In strong uptrend: RSI stays 40-80, rarely hits 30. An RSI of 40 is actually a buy signal.
  - In strong downtrend: RSI stays 20-60, rarely hits 70. An RSI of 60 is actually a sell signal.
  - Adjust thresholds based on regime!
- **RSI Divergence:**
  - Bullish divergence: price makes lower low, RSI makes higher low → reversal coming
  - Bearish divergence: price makes higher high, RSI makes lower high → reversal coming
- **RSI Swing Rejection (4-step):**
  1. RSI falls below 30 (oversold)
  2. RSI crosses back above 30
  3. RSI dips again but stays above 30
  4. RSI breaks recent high → BUY signal
- **Our data source:** Computable from Pyth tape. We do NOT compute RSI today.
- **Key use for us:** Don't buy overbought tokens (RSI > 70). Combined with regime detection,
  adjust RSI thresholds so we don't buy exhausted moves.

---

## 4. Trend Direction Indicators

### MACD (Moving Average Convergence Divergence)
- **What:** Trend-following momentum indicator showing relationship between two EMAs.
- **Components:**
  - MACD line = 12-period EMA - 26-period EMA
  - Signal line = 9-period EMA of MACD line
  - Histogram = MACD line - Signal line
- **Signals:**
  - MACD crosses ABOVE signal line = bullish (buy)
  - MACD crosses BELOW signal line = bearish (sell)
  - Histogram growing = trend accelerating
  - Histogram shrinking = trend decelerating
- **MACD divergence** works like RSI divergence — price vs indicator disagreement.
- **Our data source:** Computable from Pyth tape or Jupiter prices. We do NOT compute MACD today.
- **Potential use:** Replace or supplement raw momentum BPS with MACD for trend direction.

### Supertrend (already implemented)
- **What we have:** ATR-based trend following. Direction up/down, flip detection.
- **What it does well:** Catches trend changes when ATR is properly calibrated.
- **Limitation:** Lagging. By the time supertrend flips bullish, part of the move is over.
- **Our config:** candleSamples=14, atrPeriod=14, multiplier=3.0

### Simple Momentum (already implemented)
- **What we have:** Price change over N samples (30 samples = ~3 min), classified as bullish/bearish/flat.
- **Limitation:** Only measures direction. Says nothing about strength, volume, or sustainability.
- **Our config:** lookback=30 samples, thresholdBps=8, persistence=3

---

## 5. Market Regime Detection

### Bollinger Bands (partially implemented)
- **What we have:** Band width, BBP (Bollinger Band Percentage), used by mean_reversion strategy.
- **What we're NOT using it for:** Regime classification.
- **Bandwidth interpretation:**
  - Narrow bands (squeeze) = low volatility, consolidation, breakout coming
  - Expanding bands = increasing volatility, trend in progress
  - Wide bands = high volatility, potential exhaustion
- **The Squeeze:** Bands tighten → expand. The expansion direction = breakout direction.
  - Squeeze + volume spike = strongest breakout signal
  - Squeeze without volume = false breakout risk
- **BBP for entries:**
  - BBP < 0 (below lower band) = oversold in context of recent range
  - BBP > 1 (above upper band) = overbought in context of recent range
  - BBP 0.4-0.6 = mid-range, neutral
- **CRITICAL: `recommendStrategy()` in strategies.ts already computes this and selects
  the correct strategy. It is logged to signal_observations but NOT used for actual
  strategy selection. The worker uses round-robin instead.**

### ATR Trend (partially implemented)
- **What we have:** ATR computed from supertrend calculation, used for exit levels.
- **What we could add:** Track ATR direction over time:
  - Rising ATR = increasing volatility = trend gaining momentum OR reversing
  - Falling ATR = decreasing volatility = trend exhausting OR consolidation
  - ATR combined with direction: rising ATR + bullish price = strong trend
- **Our data:** Already computed. Just not used for regime classification.

### Regime Classification Framework
Based on research, the regime detection should produce one of:

| Regime | Bollinger Width | ADX | Price Slope | Best Strategy |
|--------|----------------|-----|-------------|---------------|
| **Trending up** | Expanding | > 25 | Positive | Momentum / Supertrend |
| **Trending down** | Expanding | > 25 | Negative | Don't trade (or short if supported) |
| **Ranging** | Narrow | < 20 | Near zero | Mean Reversion |
| **Breakout** | Squeeze → Expand | Rising 20→25+ | Any | Wait for confirmation, then Momentum |
| **Choppy** | Wide, oscillating | < 20 | Oscillating | Sit out entirely |
| **Exhaustion** | Very wide | Falling from >25 | Slowing | Tighten exits, no new entries |

**`recommendStrategy()` in strategies.ts already does a simplified version of this!**
It checks bandwidth + slope and recommends momentum/mean_reversion/supertrend.
We just need to wire it into actual strategy selection.

---

## 6. Candlestick Patterns

### Why They Matter
Candlestick patterns show the battle between buyers and sellers within a single time period.
They are visual representations of market psychology.

### Key Bullish Reversal Patterns
- **Hammer:** Long lower shadow, small body at top. Sellers pushed price down, buyers fought back. Bullish at bottom of downtrend.
- **Bullish Engulfing:** Small red candle followed by larger green candle that completely engulfs it. Strong buying pressure overcoming selling.
- **Morning Star:** 3-candle pattern. Long red → small body (indecision) → long green closing above midpoint of first candle. Trend reversal.
- **Piercing Line:** Long red candle → green candle opens below previous low but closes above midpoint. Buyers stepping in.

### Key Bearish Reversal Patterns
- **Hanging Man:** Same shape as hammer but at top of uptrend. Selling pressure emerging.
- **Bearish Engulfing:** Small green candle followed by larger red candle that engulfs it. Strong selling overwhelming buying.
- **Evening Star:** Long green → small body → long red closing below midpoint of first. Trend reversal.
- **Dark Cloud Cover:** Long green → red candle opens above previous high but closes below midpoint.

### Continuation Patterns
- **Doji:** Open ≈ Close. Indecision. Direction depends on context (after trend = potential reversal, in range = continuation).
- **Marubozu:** Full-body candle with no shadows. Strong conviction in direction.

### Application to Our Bot
- **Current state:** We have GeckoTerminal 1-minute OHLCV candles (open, high, low, close, volume) but we only use close price.
- **Opportunity:** We could detect basic patterns (hammer, engulfing, doji) from the OHLC data we already fetch but throw away.
- **Priority:** LOWER than volume and regime detection. Candlestick patterns need volume confirmation to be reliable anyway.
- **Implementation note:** On 1-minute candles with DEX data, many traditional patterns are less reliable due to noise. Focus on engulfing + volume confirmation as the most robust combo.

---

## 7. Exit Strategy Intelligence

### Current State
- TP = 1.8× ATR, SL = 1.0× ATR, Trail = 0.8× ATR — fixed for all conditions.

### What Research Says About Adaptive Exits
- **In trending markets:** Wider TP (2.5-3× ATR), tighter trail (let winners run)
- **In ranging markets:** Tighter TP (1.0-1.5× ATR, take what the range gives), wider SL (don't get stopped by range noise)
- **In volatile/choppy markets:** Tighter everything, or don't trade
- **RSI-based exits:** Exit long when RSI > 70 (overbought), regardless of TP target
- **Volume-based exits:** Exit if volume dries up during a move (conviction lost)
- **Bollinger-based exits:** Exit when price touches opposite band (mean reversion complete)

### Key Exit Rules
1. Never fight the regime. Tight TP in ranges, wide TP in trends.
2. Volume exhaustion = exit warning even if TP not reached.
3. RSI divergence at extremes = exit immediately.
4. Trail stop should adapt to ATR so it doesn't get triggered by normal volatility.

---

## 8. What RogueZero Has vs What It Needs

### Already Computed (just not used or connected)
| Indicator | Location | Status |
|-----------|----------|--------|
| Bollinger Bands (BBP, bandwidth) | `strategies.ts:computeBollingerSignal()` | Used by mean_reversion only |
| Supertrend direction + flips | `strategies.ts:computeSupertrendSignal()` | Used by supertrend only |
| ATR (from supertrend) | `strategies.ts:computeAtrFromTape()` | Used for exits + entry quality |
| Regime → strategy recommendation | `strategies.ts:recommendStrategy()` | **COMPUTED BUT IGNORED** — logged to DB, round-robin used instead |
| Momentum BPS (price direction) | `index.ts:buildMintMomentumSignal()` | Used everywhere |
| GeckoTerminal OHLCV feed | `geckoTerminalCandles.ts` | **MODULE EXISTS BUT NOT IMPORTED BY WORKER** |

### Missing Entirely
| Indicator | Needed For | Data Source | Priority |
|-----------|-----------|-------------|----------|
| Volume (OBV, RVOL) | Entry confirmation | GeckoTerminal row[5] (currently discarded) | **HIGHEST** |
| ADX (trend strength) | Distinguish real trends from noise | Pyth tape (has price data) | HIGH |
| RSI | Overbought/oversold filter | Pyth tape | MEDIUM |
| MACD | Trend direction confirmation | Pyth tape | MEDIUM |
| Candlestick patterns | Entry/exit signals | GeckoTerminal OHLC (currently discarded) | LOW |

### Dead Code / Disconnected
1. `geckoTerminalCandles.ts` — entire module not imported by worker
2. `parseOhlcvList()` — discards volume (row[5]) and OHLC (rows 1-3), only keeps close
3. `recommendStrategy()` — computes regime-based strategy recommendation, result logged but not used

---

## 9. Implementation Priority for TRADING-FIX-PLAN Phase 2

Based on this research, the correct order for Phase 2 is:

### Step 1: Wire `recommendStrategy()` (B3 — largely done already)
- Replace round-robin with regime-based strategy selection
- The code exists. It just needs to be plugged in.
- Fastest impact of any Phase 2 change.

### Step 2: Volume confirmation (B2 — biggest gap)
1. Fix `parseOhlcvList()` to preserve volume + OHLC
2. Import and wire `geckoTerminalCandles` feed into worker
3. Compute RVOL (relative volume) per token
4. Compute OBV trend direction per token
5. Add volume gate: block entries where RVOL < 1.0 or OBV falling

### Step 3: Regime adaptation (B4)
1. Feed Bollinger bandwidth into position sizing (smaller in tight/choppy)
2. Feed bandwidth into exit multipliers (tighter TP in range, wider in trend)
3. Add ADX computation from Pyth tape
4. Combine ADX + bandwidth for full regime classification

### Step 4: Adaptive exits (C2)
1. Regime-based exit multiplier scaling
2. RSI-based exit triggers (exit overbought positions)
3. Volume-based exit warnings

---

## 10. Reference Sources
- Investopedia: On-Balance Volume (OBV), VWAP, Volume Trading Strategies
- Investopedia: Average Directional Index (ADX)
- Investopedia: Bollinger Bands
- Investopedia: Relative Strength Index (RSI)
- Investopedia: Candlestick Chart Patterns
- Investopedia: MACD
- User-provided PDFs (content summarized above):
  - Trendsignal Trading Strategy v2 (rules-based trend following)
  - Missouri Extension: Major Candlestick Signals
  - Trading Strategy and Methods (TSaM) — technical analysis textbook
