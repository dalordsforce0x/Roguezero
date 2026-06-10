/**
 * Strategy signal modules for RogueZero.
 *
 * Three strategies that complement each other across market regimes:
 *   - momentum:        existing tape-based momentum BPS classifier
 *   - mean_reversion:  Bollinger Band reversion (ranging/flat markets)
 *   - supertrend:      ATR-adaptive trend following (trending/breakout markets)
 *
 * Each strategy produces a SignalDecision that the worker uses for entry/exit.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type MarketRegime = 'bullish' | 'bearish' | 'flat';

export type SignalDecision = {
  strategy: 'momentum' | 'mean_reversion' | 'supertrend';
  status: 'warming_up' | 'ready' | 'guarded_off';
  regime: MarketRegime | null;
  momentumBps: number | null;
  guardReason: string | null;
  /** Strategy-specific metadata for logging/debugging */
  meta: Record<string, number | string | null>;
};

export const STRATEGY_SCAN_ORDER = ['momentum', 'mean_reversion', 'supertrend'] as const;
export type StrategyKey = (typeof STRATEGY_SCAN_ORDER)[number];

export const getNextStrategyInSequence = (
  current: StrategyKey,
  enabledStrategies: readonly StrategyKey[],
): StrategyKey => {
  const enabledSet = new Set(enabledStrategies);
  const orderedEnabled = STRATEGY_SCAN_ORDER.filter((strategy) => enabledSet.has(strategy));
  if (orderedEnabled.length === 0) return current;

  const currentIndex = orderedEnabled.indexOf(current);
  if (currentIndex < 0) return orderedEnabled[0];
  return orderedEnabled[(currentIndex + 1) % orderedEnabled.length];
};

export const getStrategyScanOrder = (
  current: StrategyKey,
  enabledStrategies: readonly StrategyKey[],
): StrategyKey[] => {
  const enabledSet = new Set(enabledStrategies);
  const orderedEnabled = STRATEGY_SCAN_ORDER.filter((strategy) => enabledSet.has(strategy));
  if (orderedEnabled.length === 0) return [current];

  const start = orderedEnabled.includes(current) ? current : orderedEnabled[0];
  const startIndex = orderedEnabled.indexOf(start);
  return [
    ...orderedEnabled.slice(startIndex),
    ...orderedEnabled.slice(0, startIndex),
  ];
};

export type PriceSample = {
  usdPrice: number;
  sampledAt: string;
};

// ── Bollinger Band Mean Reversion ────────────────────────────────────────────

export type BollingerConfig = {
  /** Number of samples for SMA/stdev (default 20) */
  length: number;
  /** Number of standard deviations for bands (default 2.0) */
  stdMultiplier: number;
  /** Minimum band width as fraction of SMA to trade (default 0.006 = 0.6%) */
  minBandWidthFraction: number;
  /** BBP threshold for entry buy (default 0.0 = lower band) */
  entryThreshold: number;
  /** BBP threshold for exit sell (default 0.5 = midband) */
  exitThreshold: number;
};

export const DEFAULT_BOLLINGER_CONFIG: BollingerConfig = {
  length: 20,
  stdMultiplier: 2.0,
  minBandWidthFraction: 0.006,
  entryThreshold: 0.0,
  exitThreshold: 0.5,
};

type BollingerState = {
  sma: number;
  upper: number;
  lower: number;
  bbp: number; // 0.0 = at lower band, 1.0 = at upper band
  bandWidth: number; // (upper - lower) / sma
};

const computeBollinger = (prices: readonly number[], config: BollingerConfig): BollingerState | null => {
  if (prices.length < config.length) return null;

  const window = prices.slice(-config.length);
  const sma = window.reduce((sum, p) => sum + p, 0) / config.length;
  if (sma <= 0) return null;

  const variance = window.reduce((sum, p) => sum + (p - sma) ** 2, 0) / config.length;
  const std = Math.sqrt(variance);
  const upper = sma + config.stdMultiplier * std;
  const lower = sma - config.stdMultiplier * std;
  const bandWidth = (upper - lower) / sma;
  const range = upper - lower;
  const bbp = range > 0 ? (prices[prices.length - 1] - lower) / range : 0.5;

  return { sma, upper, lower, bbp, bandWidth };
};

export const computeBollingerSignal = (
  tape: readonly PriceSample[],
  config: BollingerConfig = DEFAULT_BOLLINGER_CONFIG,
): SignalDecision => {
  const prices = tape.map(s => s.usdPrice);

  if (prices.length < config.length + 1) {
    return {
      strategy: 'mean_reversion',
      status: 'warming_up',
      regime: null,
      momentumBps: null,
      guardReason: null,
      meta: { tapeDepth: prices.length, required: config.length + 1 },
    };
  }

  const bb = computeBollinger(prices, config);
  if (!bb) {
    return {
      strategy: 'mean_reversion',
      status: 'guarded_off',
      regime: null,
      momentumBps: null,
      guardReason: 'bollinger_computation_failed',
      meta: {},
    };
  }

  // Gate: band width too narrow = no edge
  if (bb.bandWidth < config.minBandWidthFraction) {
    return {
      strategy: 'mean_reversion',
      status: 'ready',
      regime: 'flat',
      momentumBps: Math.round(bb.bbp * 100),
      guardReason: null,
      meta: { bbp: Math.round(bb.bbp * 1000) / 1000, bandWidth: Math.round(bb.bandWidth * 10000) / 10000, sma: Math.round(bb.sma * 100) / 100 },
    };
  }

  // BBP < entryThreshold → oversold → bullish (buy signal)
  if (bb.bbp < config.entryThreshold) {
    return {
      strategy: 'mean_reversion',
      status: 'ready',
      regime: 'bullish',
      momentumBps: Math.round((config.exitThreshold - bb.bbp) * 10000 / 2), // estimated edge in bps
      guardReason: null,
      meta: { bbp: Math.round(bb.bbp * 1000) / 1000, bandWidth: Math.round(bb.bandWidth * 10000) / 10000, sma: Math.round(bb.sma * 100) / 100 },
    };
  }

  // BBP > exitThreshold → reverted to midband or above → bearish (sell signal)
  if (bb.bbp > config.exitThreshold) {
    return {
      strategy: 'mean_reversion',
      status: 'ready',
      regime: 'bearish',
      momentumBps: Math.round((bb.bbp - config.exitThreshold) * -10000 / 2),
      guardReason: null,
      meta: { bbp: Math.round(bb.bbp * 1000) / 1000, bandWidth: Math.round(bb.bandWidth * 10000) / 10000, sma: Math.round(bb.sma * 100) / 100 },
    };
  }

  return {
    strategy: 'mean_reversion',
    status: 'ready',
    regime: 'flat',
    momentumBps: 0,
    guardReason: null,
    meta: { bbp: Math.round(bb.bbp * 1000) / 1000, bandWidth: Math.round(bb.bandWidth * 10000) / 10000, sma: Math.round(bb.sma * 100) / 100 },
  };
};

// ── Supertrend (ATR-adaptive trend following) ────────────────────────────────

export type SupertrendConfig = {
  /** Number of price samples per synthetic candle (default 10 = 30s at 3s cadence) */
  candleSamples: number;
  /** ATR period in candles (default 10) */
  atrPeriod: number;
  /** ATR multiplier for bands (default 3.0) */
  multiplier: number;
};

export const DEFAULT_SUPERTREND_CONFIG: SupertrendConfig = {
  candleSamples: 14,
  atrPeriod: 14,
  multiplier: 3.0,
};

type Candle = {
  open: number;
  high: number;
  low: number;
  close: number;
};

type SupertrendState = {
  direction: 'up' | 'down';
  supertrendLine: number;
  atr: number;
  prevDirection: 'up' | 'down';
};

const buildCandles = (prices: readonly number[], candleSamples: number): Candle[] => {
  const candles: Candle[] = [];
  for (let i = 0; i + candleSamples <= prices.length; i += candleSamples) {
    const slice = prices.slice(i, i + candleSamples);
    candles.push({
      open: slice[0],
      close: slice[slice.length - 1],
      high: Math.max(...slice),
      low: Math.min(...slice),
    });
  }
  return candles;
};

const computeSupertrend = (candles: Candle[], config: SupertrendConfig): SupertrendState | null => {
  if (candles.length < config.atrPeriod + 1) return null;

  // Compute True Range
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    trs.push(Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose),
    ));
  }

  // ATR = SMA of last atrPeriod TRs
  const atrSlice = trs.slice(-config.atrPeriod);
  const atr = atrSlice.reduce((sum, tr) => sum + tr, 0) / config.atrPeriod;
  if (atr <= 0) return null;

  // Compute supertrend bands iteratively
  let finalUb = Infinity;
  let finalLb = -Infinity;
  let direction: 'up' | 'down' = 'up';
  let prevDirection: 'up' | 'down' = direction;

  // Process from atrPeriod onwards (we need atrPeriod TRs, which start at index 1)
  const startIdx = config.atrPeriod;
  for (let i = startIdx; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;

    // Local ATR for this candle
    const localTrs = trs.slice(Math.max(0, i - 1 - config.atrPeriod), i - 1);
    const localAtr = localTrs.length > 0
      ? localTrs.reduce((sum, tr) => sum + tr, 0) / localTrs.length
      : atr;

    const hl2 = (c.high + c.low) / 2;
    const basicUb = hl2 + config.multiplier * localAtr;
    const basicLb = hl2 - config.multiplier * localAtr;

    // Ratchet: only tighten, never widen against trend
    finalUb = prevClose <= finalUb ? Math.min(basicUb, finalUb) : basicUb;
    finalLb = prevClose >= finalLb ? Math.max(basicLb, finalLb) : basicLb;

    prevDirection = direction;
    if (direction === 'down' && c.close > finalUb) {
      direction = 'up';
    } else if (direction === 'up' && c.close < finalLb) {
      direction = 'down';
    }
  }

  return {
    direction,
    supertrendLine: direction === 'up' ? finalLb : finalUb,
    atr,
    prevDirection,
  };
};

export const computeSupertrendSignal = (
  tape: readonly PriceSample[],
  config: SupertrendConfig = DEFAULT_SUPERTREND_CONFIG,
): SignalDecision => {
  const prices = tape.map(s => s.usdPrice);
  const minSamples = (config.atrPeriod + 2) * config.candleSamples;

  if (prices.length < minSamples) {
    return {
      strategy: 'supertrend',
      status: 'warming_up',
      regime: null,
      momentumBps: null,
      guardReason: null,
      meta: { tapeDepth: prices.length, required: minSamples },
    };
  }

  const candles = buildCandles(prices, config.candleSamples);
  const st = computeSupertrend(candles, config);

  if (!st) {
    return {
      strategy: 'supertrend',
      status: 'guarded_off',
      regime: null,
      momentumBps: null,
      guardReason: 'supertrend_computation_failed',
      meta: { candleCount: candles.length },
    };
  }

  const currentPrice = prices[prices.length - 1];
  const distanceBps = currentPrice > 0
    ? Math.round(((currentPrice - st.supertrendLine) / currentPrice) * 10000)
    : 0;

  // Trend flip detection
  const flippedUp = st.prevDirection === 'down' && st.direction === 'up';
  const flippedDown = st.prevDirection === 'up' && st.direction === 'down';

  let regime: MarketRegime;
  if (flippedUp || st.direction === 'up') {
    regime = 'bullish';
  } else if (flippedDown || st.direction === 'down') {
    regime = 'bearish';
  } else {
    regime = 'flat';
  }

  return {
    strategy: 'supertrend',
    status: 'ready',
    regime,
    momentumBps: distanceBps,
    guardReason: null,
    meta: {
      direction: st.direction,
      supertrendLine: Math.round(st.supertrendLine * 100) / 100,
      atr: Math.round(st.atr * 10000) / 10000,
      distanceBps,
      candleCount: candles.length,
      flipped: flippedUp ? 'up' : flippedDown ? 'down' : null,
    },
  };
};

export const computeAtrFromTape = (
  tape: readonly PriceSample[],
  config: SupertrendConfig = DEFAULT_SUPERTREND_CONFIG,
): { atrUsd: number; atrBps: number; candleCount: number } | null => {
  const prices = tape.map(s => s.usdPrice);
  const minSamples = (config.atrPeriod + 2) * config.candleSamples;

  if (prices.length < minSamples) {
    return null;
  }

  const candles = buildCandles(prices, config.candleSamples);
  const st = computeSupertrend(candles, config);
  const currentPrice = prices[prices.length - 1];

  if (!st || currentPrice <= 0) {
    return null;
  }

  return {
    atrUsd: st.atr,
    atrBps: Math.max(1, Math.round((st.atr / currentPrice) * 10_000)),
    candleCount: candles.length,
  };
};

// ── Regime detector / strategy router ────────────────────────────────────────

export type StrategyRecommendation = {
  recommended: 'momentum' | 'mean_reversion' | 'supertrend';
  reason: string;
  bbWidth: number | null;
  priceSlope: number | null;
};

/**
 * Determines which strategy is best suited for current market conditions.
 *
 * Logic:
 *   - Narrow bands + flat slope → mean_reversion (range-bound)
 *   - Expanding bands + steep slope → supertrend (trending/breakout)
 *   - Otherwise → momentum (general purpose)
 */
export const recommendStrategy = (
  tape: readonly PriceSample[],
  bollingerConfig: BollingerConfig = DEFAULT_BOLLINGER_CONFIG,
): StrategyRecommendation => {
  const prices = tape.map(s => s.usdPrice);

  if (prices.length < bollingerConfig.length + 1) {
    return { recommended: 'momentum', reason: 'insufficient_data', bbWidth: null, priceSlope: null };
  }

  const bb = computeBollinger(prices, bollingerConfig);
  if (!bb) {
    return { recommended: 'momentum', reason: 'computation_failed', bbWidth: null, priceSlope: null };
  }

  // Compute price slope over last 20 samples (in bps per sample)
  const slopeWindow = Math.min(20, prices.length);
  const firstPrice = prices[prices.length - slopeWindow];
  const lastPrice = prices[prices.length - 1];
  const priceSlope = firstPrice > 0
    ? Math.round(((lastPrice - firstPrice) / firstPrice) * 10000 / slopeWindow)
    : 0;
  const absSlopeBps = Math.abs(priceSlope);

  // Regime classification
  if (bb.bandWidth < bollingerConfig.minBandWidthFraction && absSlopeBps < 2) {
    return {
      recommended: 'mean_reversion',
      reason: 'narrow_bands_flat_slope',
      bbWidth: bb.bandWidth,
      priceSlope,
    };
  }

  if (bb.bandWidth > bollingerConfig.minBandWidthFraction * 1.5 && absSlopeBps > 3) {
    return {
      recommended: 'supertrend',
      reason: 'expanding_bands_steep_slope',
      bbWidth: bb.bandWidth,
      priceSlope,
    };
  }

  return {
    recommended: 'momentum',
    reason: 'default_regime',
    bbWidth: bb.bandWidth,
    priceSlope,
  };
};
