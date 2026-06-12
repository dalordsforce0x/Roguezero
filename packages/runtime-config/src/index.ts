import { z } from 'zod';

const placeholderPrefixes = ['YOUR_', 'CHANGEME_', 'REPLACE_'] as const;
const keyLabelPattern = /^[A-Z0-9_]+$/;
export const jupiterFeeTokenValues = ['SOL', 'USDC', 'USDT'] as const;

const isPlaceholderValue = (value: string | undefined) => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return true;
  }

  return placeholderPrefixes.some((prefix) => trimmed.startsWith(prefix));
};

const getConfiguredEnvValue = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const optionalConfiguredString = (schema: z.ZodString) => z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  schema.optional(),
);

const envSchema = z.object({
  SOLANA_NETWORK: z.enum(['mainnet-beta', 'devnet']).default('mainnet-beta'),
  HELIUS_API_KEY: z.string().min(1),
  HELIUS_RPC_URL: z.string().url(),
  HELIUS_GATEKEEPER_ENABLED: z.coerce.boolean().optional(),
  JUPITER_API_KEY: z.string().min(1),
  PYTH_API_KEY: optionalConfiguredString(z.string().min(1)),
  PYTH_HERMES_URL: optionalConfiguredString(z.string().url()),
  JUPITER_PLATFORM_FEE_BPS: z.coerce.number().int().min(0).max(1000),
  JUPITER_FEE_ACCOUNT_SOL: z.string().min(32),
  JUPITER_FEE_ACCOUNT_USDC: z.string().min(32),
  JUPITER_FEE_ACCOUNT_USDT: z.string().min(32),
  JUPITER_SWAP_MAX_ACCOUNTS: z.coerce.number().int().min(1).max(64).optional(),
  JUPITER_SWAP_DEXES: optionalConfiguredString(z.string().min(1)),
  JUPITER_SWAP_EXCLUDE_DEXES: optionalConfiguredString(z.string().min(1)),
  JUPITER_TRIGGER_REFERRAL_ACCOUNT: optionalConfiguredString(z.string().min(32)),
  KEYAUTH_APP_NAME: z.string().min(1),
  KEYAUTH_OWNER_ID: z.string().min(1),
  KEYAUTH_APP_SECRET: z.string().min(1),
  DATABASE_PROVIDER: z.enum(['tigerdata', 'supabase']).default('tigerdata'),
  DATABASE_URL: optionalConfiguredString(z.string().min(1)),
  DATABASE_PRIVATE_URL: optionalConfiguredString(z.string().min(1)),
  // Performance fee: 0.33% of net session profit at session end
  PERFORMANCE_FEE_BPS: z.coerce.number().int().min(0).max(1000).default(33),
  PERFORMANCE_FEE_COLLECTOR_WALLET: optionalConfiguredString(z.string().min(32)),
  NEXT_PUBLIC_APP_NAME: z.string().min(1),
  NEXT_PUBLIC_SOLANA_NETWORK: z.enum(['mainnet-beta', 'devnet']).default('mainnet-beta'),
});

const requiredLiveKeys = [
  'HELIUS_API_KEY',
  'JUPITER_API_KEY',
  'KEYAUTH_OWNER_ID',
  'KEYAUTH_APP_SECRET',
  'DATABASE_URL',
  'DATABASE_PRIVATE_URL',
] as const;

export type RuntimeEnv = z.infer<typeof envSchema>;
export type RequiredLiveKey = (typeof requiredLiveKeys)[number];
export type JupiterFeeToken = (typeof jupiterFeeTokenValues)[number];
export const runtimeSpeedProfileValues = ['glide', 'pulse', 'surge'] as const;
export type RuntimeSpeedProfileName = (typeof runtimeSpeedProfileValues)[number];

export type RuntimeSpeedProfile = {
  name: RuntimeSpeedProfileName;
  label: string;
  concurrentCapacity: number;
  // Max open positions per bot for this fleet mode. null = dynamic / bot-decided (Surge).
  maxOpenPositions: number | null;
  cadenceMs: {
    readyStarting: number;
    activeInPosition: number;
    activeFlat: number;
    activeGuarded: number;
    stopping: number;
    postSubmitFast: number;
  };
};

const runtimeSpeedProfileDefinitions = {
  // Exit timing is decoupled from the fleet throttle. `activeInPosition` (the
  // re-check cadence for an OPEN position = stop-loss / take-profit reaction) is
  // held at the price-mark rate (~3s) in EVERY mode, because an in-position visit
  // reads only in-memory marks from the single shared price poll and makes ZERO
  // per-bot provider calls — checking exits faster costs nothing and scales to
  // 350 bots for free. The fleet downshift (glide) instead throttles ENTRY-side
  // work — `activeFlat` (flat scouting), `readyStarting`, `activeGuarded`, and
  // `maxOpenPositions` — which is where real per-bot provider load lives.
  glide: {
    label: 'Glide',
    capacityDivisor: 1,
    maxOpenPositions: 3,
    cadenceMs: {
      readyStarting: 6_000,
      activeInPosition: 3_000,
      activeFlat: 45_000,
      activeGuarded: 60_000,
      stopping: 6_000,
      postSubmitFast: 2_500,
    },
  },
  pulse: {
    label: 'Pulse',
    capacityDivisor: 1,
    maxOpenPositions: 10,
    cadenceMs: {
      readyStarting: 3_500,
      activeInPosition: 3_000,
      activeFlat: 30_000,
      activeGuarded: 45_000,
      stopping: 5_000,
      postSubmitFast: 1_500,
    },
  },
  surge: {
    label: 'Surge',
    capacityDivisor: 1,
    maxOpenPositions: null,
    cadenceMs: {
      readyStarting: 2_000,
      activeInPosition: 3_000,
      activeFlat: 15_000,
      activeGuarded: 25_000,
      stopping: 4_000,
      postSubmitFast: 1_000,
    },
  },
} as const;

export const normalizeRuntimeSpeedProfileName = (value: string | null | undefined): RuntimeSpeedProfileName => {
  if (value === 'glide' || value === 'pulse' || value === 'surge') {
    return value;
  }

  return 'pulse';
};

export const getRuntimeSpeedProfile = (
  value: string | null | undefined,
  env: NodeJS.ProcessEnv,
): RuntimeSpeedProfile => {
  const name = normalizeRuntimeSpeedProfileName(value);
  const definition = runtimeSpeedProfileDefinitions[name];
  // Fleet-wide base capacity default aligned to the 350-bot target.
  const baseConcurrentCapacity = Number(env.WORKER_BASE_CONCURRENT_CAPACITY ?? 350);

  return {
    name,
    label: definition.label,
    concurrentCapacity: Math.max(1, Math.floor(baseConcurrentCapacity / definition.capacityDivisor)),
    maxOpenPositions: definition.maxOpenPositions,
    cadenceMs: definition.cadenceMs,
  };
};

export type WorkerFundingThresholds = {
  tradeAmountLamports: number;
  maxRouteSetupLamports: number;
  operatingBufferLamports: number;
  txFeeLamports: number;
  minimumTradeableLamports: number;
};

const collectNamedKeys = (env: NodeJS.ProcessEnv, prefix: 'HELIUS_API_KEY_' | 'JUPITER_API_KEY_') =>
  Object.entries(env)
    .filter(([key, value]) => key.startsWith(prefix) && keyLabelPattern.test(key) && !!value)
    .map(([key, value]) => ({
      key,
      configured: !isPlaceholderValue(value),
    }));

const collectNamedKeyValues = (env: NodeJS.ProcessEnv, prefix: 'HELIUS_API_KEY_' | 'JUPITER_API_KEY_') =>
  Object.entries(env)
    .filter(([key, value]) => key.startsWith(prefix) && keyLabelPattern.test(key) && !!value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, value]) => value!.trim())
    .filter((value) => value.length > 0 && !isPlaceholderValue(value));

const uniqueNonEmptyKeys = (keys: readonly string[]) => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of keys) {
    const trimmed = key.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
};

export const getJupiterApiKeys = (env: NodeJS.ProcessEnv): readonly string[] => {
  const config = getValidatedRuntimeConfig(env);
  return uniqueNonEmptyKeys([
    config.JUPITER_API_KEY,
    ...collectNamedKeyValues(env, 'JUPITER_API_KEY_'),
  ]);
};

export const getHeliusApiKeys = (env: NodeJS.ProcessEnv): readonly string[] => {
  const config = getValidatedRuntimeConfig(env);
  return uniqueNonEmptyKeys([
    config.HELIUS_API_KEY,
    ...collectNamedKeyValues(env, 'HELIUS_API_KEY_'),
  ]);
};

export const createRoundRobinKeySelector = (keys: readonly string[]) => {
  const keyPool = uniqueNonEmptyKeys(keys);
  if (keyPool.length === 0) {
    throw new Error('createRoundRobinKeySelector requires at least one configured key');
  }

  let cursor = 0;
  return {
    next: () => {
      const key = keyPool[cursor % keyPool.length];
      cursor = (cursor + 1) % keyPool.length;
      return key;
    },
    size: keyPool.length,
    keys: keyPool as readonly string[],
  };
};

export const getDatabaseConnectionUrl = (env: NodeJS.ProcessEnv) => {
  const privateUrl = getConfiguredEnvValue(env.DATABASE_PRIVATE_URL);
  if (privateUrl && !isPlaceholderValue(privateUrl)) {
    return privateUrl;
  }

  if (env.ALLOW_PUBLIC_DATABASE_URL_FALLBACK !== 'true') {
    throw new Error('DATABASE_PRIVATE_URL must be configured for runtime database access');
  }

  const publicUrl = getConfiguredEnvValue(env.DATABASE_URL);
  if (publicUrl && !isPlaceholderValue(publicUrl)) {
    return publicUrl;
  }

  throw new Error('DATABASE_PRIVATE_URL or DATABASE_URL must be configured');
};

export const getRuntimeConfigReport = (env: NodeJS.ProcessEnv) => {
  const parsed = envSchema.safeParse(env);
  const missingLiveValues = requiredLiveKeys.filter((key) => {
    if (key === 'DATABASE_URL' || key === 'DATABASE_PRIVATE_URL') {
      return false;
    }

    return isPlaceholderValue(env[key]);
  });
  const databasePrivateConfigured = !isPlaceholderValue(env.DATABASE_PRIVATE_URL);
  const databasePublicConfigured = !isPlaceholderValue(env.DATABASE_URL);
  if (!databasePrivateConfigured) {
    missingLiveValues.push('DATABASE_PRIVATE_URL');
  }
  const heliusKeyPool = collectNamedKeys(env, 'HELIUS_API_KEY_');
  const jupiterKeyPool = collectNamedKeys(env, 'JUPITER_API_KEY_');

  return {
    schemaValid: parsed.success,
    missingLiveValues,
    databaseProvider: env.DATABASE_PROVIDER ?? 'tigerdata',
    databaseConnection: {
      privateConfigured: databasePrivateConfigured,
      publicConfigured: databasePublicConfigured,
      activeTarget: databasePrivateConfigured ? 'private' : databasePublicConfigured ? 'public' : 'missing',
      publicFallbackAllowed: env.ALLOW_PUBLIC_DATABASE_URL_FALLBACK === 'true',
    },
    feeAccountsPresent: {
      sol: !isPlaceholderValue(env.JUPITER_FEE_ACCOUNT_SOL),
      usdc: !isPlaceholderValue(env.JUPITER_FEE_ACCOUNT_USDC),
      usdt: !isPlaceholderValue(env.JUPITER_FEE_ACCOUNT_USDT),
    },
    keyPools: {
      helius: {
        primaryConfigured: !isPlaceholderValue(env.HELIUS_API_KEY),
        backupsConfigured: heliusKeyPool.filter((entry) => entry.configured).length,
      },
      jupiter: {
        primaryConfigured: !isPlaceholderValue(env.JUPITER_API_KEY),
        backupsConfigured: jupiterKeyPool.filter((entry) => entry.configured).length,
      },
    },
    readyForLiveIntegration:
      parsed.success && missingLiveValues.length === 0,
    issues: parsed.success
      ? []
      : parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
  };
};

export const getValidatedRuntimeConfig = (env: NodeJS.ProcessEnv) => {
  const report = getRuntimeConfigReport(env);

  if (!report.schemaValid || report.missingLiveValues.length > 0) {
    throw new Error(
      `Runtime config incomplete: ${JSON.stringify(report, null, 2)}`,
    );
  }

  return envSchema.parse(env);
};

export const getHeliusRpcUrl = (env: NodeJS.ProcessEnv) => {
  return getHeliusRpcUrls(env)[0];
};

export const getHeliusRpcUrls = (env: NodeJS.ProcessEnv): readonly string[] => {
  const config = getValidatedRuntimeConfig(env);

  if (config.HELIUS_GATEKEEPER_ENABLED) {
    return getHeliusApiKeys(env).map((apiKey) => `https://beta.helius-rpc.com/?api-key=${apiKey}`);
  }

  return [config.HELIUS_RPC_URL];
};

export const getJupiterFeeAccounts = (env: NodeJS.ProcessEnv) => {
  const config = getValidatedRuntimeConfig(env);

  return {
    SOL: config.JUPITER_FEE_ACCOUNT_SOL,
    USDC: config.JUPITER_FEE_ACCOUNT_USDC,
    USDT: config.JUPITER_FEE_ACCOUNT_USDT,
  } as const;
};

export const getJupiterSwapBuildConfig = (env: NodeJS.ProcessEnv) => {
  const config = getValidatedRuntimeConfig(env);
  const feeAccounts = getJupiterFeeAccounts(env);
  const apiKeys = getJupiterApiKeys(env);

  if (config.JUPITER_SWAP_DEXES && config.JUPITER_SWAP_EXCLUDE_DEXES) {
    throw new Error('JUPITER_SWAP_DEXES and JUPITER_SWAP_EXCLUDE_DEXES are mutually exclusive');
  }

  return {
    apiBaseUrl: 'https://api.jup.ag/swap/v2',
    apiKey: config.JUPITER_API_KEY,
    apiKeys,
    platformFeeBps: config.JUPITER_PLATFORM_FEE_BPS,
    feeAccounts,
    routeControls: {
      maxAccounts: config.JUPITER_SWAP_MAX_ACCOUNTS,
      dexes: config.JUPITER_SWAP_DEXES,
      excludeDexes: config.JUPITER_SWAP_EXCLUDE_DEXES,
    },
    getFeeAccountForToken: (token: JupiterFeeToken) => feeAccounts[token],
  };
};

export const getWorkerFundingThresholds = (env: NodeJS.ProcessEnv): WorkerFundingThresholds => {
  const tradeAmountLamports = Number(env.WORKER_TRADE_AMOUNT_LAMPORTS ?? 1_000_000);
  const maxRouteSetupLamports = Number(env.WORKER_MAX_ROUTE_SETUP_LAMPORTS ?? 2_192_400);
  const operatingBufferLamports = Number(env.WORKER_OPERATING_BUFFER_LAMPORTS ?? 0);
  const txFeeLamports = Number(env.WORKER_TX_FEE_LAMPORTS ?? 5_000);

  return {
    tradeAmountLamports,
    maxRouteSetupLamports,
    operatingBufferLamports,
    txFeeLamports,
    minimumTradeableLamports:
      tradeAmountLamports +
      maxRouteSetupLamports +
      operatingBufferLamports +
      txFeeLamports,
  };
};

// ── Stage 3 adaptive sizing ───────────────────────────────────────────────────
// Per-trade size is derived from session-wallet balance and a configured
// fraction, after reserving lamports for route setup, tx base fee, and
// Helius Sender tip / priority-fee headroom (the operating buffer).
//
// platformFeeBps (Jupiter Router) is NOT deducted from the session wallet —
// Jupiter takes it on the output side and routes it to our fee token accounts.
// It therefore does NOT enter the reserve math here.

export type WorkerSizingPolicy = {
  tradeFractionBps: number;
  minTradeLamports: number;
  maxTradeLamports: number;
};

export const getWorkerSizingPolicy = (env: NodeJS.ProcessEnv): WorkerSizingPolicy => {
  const thresholds = getWorkerFundingThresholds(env);
  const tradeFractionBps = Number(env.WORKER_TRADE_FRACTION_BPS ?? 1_000);
  const minTradeLamports = Number(
    env.WORKER_MIN_TRADE_LAMPORTS ?? thresholds.tradeAmountLamports,
  );
  const maxTradeLamports = Number(env.WORKER_MAX_TRADE_LAMPORTS ?? 50_000_000);

  return {
    tradeFractionBps,
    minTradeLamports,
    maxTradeLamports,
  };
};

// ── Performance fee config ────────────────────────────────────────────────────
// 0.33% of net session profit deducted at session end before funds return home.
export type PerformanceFeeConfig = {
  feeBps: number;
  collectorWallet: string | null;
  enabled: boolean;
};

export const getPerformanceFeeConfig = (env: NodeJS.ProcessEnv): PerformanceFeeConfig => {
  const config = envSchema.parse(env);
  const feeBps = config.PERFORMANCE_FEE_BPS;
  const collectorWallet = config.PERFORMANCE_FEE_COLLECTOR_WALLET ?? null;
  return {
    feeBps,
    collectorWallet,
    enabled: feeBps > 0 && collectorWallet !== null,
  };
};

export type TradeSizingSkipReason = 'below_min_viable' | 'insufficient_balance';

export type TradeSizingDecision =
  | {
      skip: true;
      reason: TradeSizingSkipReason;
      balanceLamports: number;
      reserveLamports: number;
      tradableLamports: number;
      targetLamports: number;
      sizedLamports: number;
    }
  | {
      skip: false;
      amountLamports: number;
      balanceLamports: number;
      reserveLamports: number;
      tradableLamports: number;
      targetLamports: number;
    };

export const computeTradeAmountLamports = (params: {
  balanceLamports: number;
  thresholds: WorkerFundingThresholds;
  policy: WorkerSizingPolicy;
}): TradeSizingDecision => {
  const { balanceLamports, thresholds, policy } = params;

  const reserveLamports =
    thresholds.maxRouteSetupLamports +
    thresholds.txFeeLamports +
    thresholds.operatingBufferLamports;

  const tradableLamports = Math.max(0, balanceLamports - reserveLamports);

  if (tradableLamports === 0) {
    return {
      skip: true,
      reason: 'insufficient_balance',
      balanceLamports,
      reserveLamports,
      tradableLamports,
      targetLamports: 0,
      sizedLamports: 0,
    };
  }

  const targetLamports = Math.floor(
    (tradableLamports * policy.tradeFractionBps) / 10_000,
  );
  const sizedLamports = Math.min(policy.maxTradeLamports, targetLamports);

  if (sizedLamports < policy.minTradeLamports) {
    return {
      skip: true,
      reason: 'below_min_viable',
      balanceLamports,
      reserveLamports,
      tradableLamports,
      targetLamports,
      sizedLamports,
    };
  }

  return {
    skip: false,
    amountLamports: sizedLamports,
    balanceLamports,
    reserveLamports,
    tradableLamports,
    targetLamports,
  };
};

// ── Stage 4 price feeds ──────────────────────────────────────────────────────
// Two independent providers on independent rate buckets:
//   • Pyth Hermes (no auth, no shared bucket) → primary signal + TP/SL/trailing
//   • Jupiter /price/v3 (already on Jupiter general bucket) → slow drift check
// Jupiter execution bucket (135 RPS fleet cap, 90% of 150) is NOT touched by
// price polling beyond one batched /price/v3 call per minute.

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Pyth SOL/USD feed id on Hermes (mainnet). Hex, no 0x prefix.
// https://www.pyth.network/developers/price-feed-ids
const PYTH_SOL_USD_FEED_ID =
  'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';

export type JupiterPriceConfig = {
  apiBaseUrl: string;
  apiKey: string;
  apiKeys: readonly string[];
  defaultMints: readonly string[];
};

export const getJupiterPriceConfig = (env: NodeJS.ProcessEnv): JupiterPriceConfig => {
  const config = getValidatedRuntimeConfig(env);
  const apiKeys = getJupiterApiKeys(env);
  return {
    apiBaseUrl: 'https://api.jup.ag/price/v3',
    apiKey: config.JUPITER_API_KEY,
    apiKeys,
    defaultMints: [SOL_MINT, USDC_MINT],
  };
};

export type PythPriceConfig = {
  hermesBaseUrl: string;
  apiKey: string | null;
  solUsdFeedId: string;
};

export const getPythPriceConfig = (env: NodeJS.ProcessEnv): PythPriceConfig => {
  const apiKey = !isPlaceholderValue(env.PYTH_API_KEY) ? env.PYTH_API_KEY!.trim() : null;
  const hermesBaseUrl = env.PYTH_HERMES_URL?.trim()
    || (apiKey ? 'https://pyth.dourolabs.app/hermes' : 'https://hermes.pyth.network');

  return {
    hermesBaseUrl,
    apiKey,
    solUsdFeedId: PYTH_SOL_USD_FEED_ID,
  };
};

export type WorkerPricePollPolicy = {
  pythPollMs: number;
  jupiterPricePollMs: number;
  maxConsecutiveFailures: number;
  sharedTapeSize: number;
};

export const getWorkerPricePollPolicy = (env: NodeJS.ProcessEnv): WorkerPricePollPolicy => {
  const pythPollMs = Number(env.WORKER_PYTH_POLL_MS ?? 3_000);
  // Token marks drive token stop-loss / take-profit. A 60s poll let a token blow
  // through its stop unseen for up to a minute (a 20bps stop realizing ~70bps).
  // Matched to the Pyth 3s SOL cadence and the Jupiter Price REST reprice floor.
  // This is ONE shared batched call for the whole fleet (not per-bot), so the
  // 60s->3s change is ~+0.16% of the monthly Jupiter request budget at any size.
  const jupiterPricePollMs = Number(env.WORKER_JUPITER_PRICE_POLL_MS ?? 3_000);
  const maxConsecutiveFailures = Number(env.WORKER_PRICE_MAX_CONSECUTIVE_FAILURES ?? 10);
  const sharedTapeSize = Number(env.WORKER_SHARED_MARKET_TAPE_SIZE ?? 900);
  return { pythPollMs, jupiterPricePollMs, maxConsecutiveFailures, sharedTapeSize };
};

export type WorkerSignalPolicy = {
  momentumLookbackSamples: number;
  momentumThresholdBps: number;
  maxPythAgeSeconds: number;
  maxPythConfidenceBps: number;
  edgeSafetyBufferBps: number;
};

export type WorkerPositionExitPolicy = {
  takeProfitBps: number;
  stopLossBps: number;
  trailingStopBps: number;
  atrTakeProfitMultiplier: number;
  atrStopLossMultiplier: number;
  atrTrailingStopMultiplier: number;
  exitCostFloorBps: number;
  trailingStopFloorBps: number;
  takeProfitTimeDecayStartMs: number;
  takeProfitTimeDecayFullMs: number;
};

export const getWorkerSignalPolicy = (env: NodeJS.ProcessEnv): WorkerSignalPolicy => {
  const momentumLookbackSamples = Number(env.WORKER_SIGNAL_MOMENTUM_LOOKBACK_SAMPLES ?? 2);
  const momentumThresholdBps = Number(env.WORKER_SIGNAL_MOMENTUM_THRESHOLD_BPS ?? 2);
  const maxPythAgeSeconds = Number(env.WORKER_SIGNAL_MAX_PYTH_AGE_SECONDS ?? 10);
  const maxPythConfidenceBps = Number(env.WORKER_SIGNAL_MAX_PYTH_CONFIDENCE_BPS ?? 15);
  const edgeSafetyBufferBps = Number(env.WORKER_SIGNAL_EDGE_SAFETY_BUFFER_BPS ?? 1);
  return {
    momentumLookbackSamples,
    momentumThresholdBps,
    maxPythAgeSeconds,
    maxPythConfidenceBps,
    edgeSafetyBufferBps,
  };
};

export const getWorkerPositionExitPolicy = (env: NodeJS.ProcessEnv): WorkerPositionExitPolicy => {
  const takeProfitBps = Number(env.WORKER_TAKE_PROFIT_BPS ?? 30);
  const stopLossBps = Number(env.WORKER_STOP_LOSS_BPS ?? 20);
  const trailingStopBps = Number(env.WORKER_TRAILING_STOP_BPS ?? 15);
  const atrTakeProfitMultiplier = Number(env.WORKER_ATR_TP_MULT ?? 1.8);
  const atrStopLossMultiplier = Number(env.WORKER_ATR_SL_MULT ?? 1.0);
  const atrTrailingStopMultiplier = Number(env.WORKER_ATR_TRAIL_MULT ?? 0.8);
  const exitCostFloorBps = Number(env.WORKER_EXIT_COST_FLOOR_BPS ?? 60);
  // Trailing-stop floor is DECOUPLED from the take-profit cost floor. The cost
  // floor was lowered so take-profits become reachable; if the trailing stop
  // shared that floor it would hair-trigger on low-volatility assets (SOL) and
  // churn buy->trail->rebuy every few seconds. The trailing band must stay wide
  // enough to ignore normal noise so winners can actually run.
  const trailingStopFloorBps = Number(env.WORKER_TRAILING_STOP_FLOOR_BPS ?? 120);
  // Time-decay take-profit ladder: a young position requires its full ATR/static
  // take-profit target; once it ages past the start window the required target
  // decays linearly toward the cost floor (breakeven + fees) by the full window,
  // freeing capital from stale positions without ever selling below cost.
  const takeProfitTimeDecayStartMs = Number(env.WORKER_TP_DECAY_START_MS ?? 90_000);
  const takeProfitTimeDecayFullMs = Number(env.WORKER_TP_DECAY_FULL_MS ?? 900_000);

  return {
    takeProfitBps,
    stopLossBps,
    trailingStopBps,
    atrTakeProfitMultiplier,
    atrStopLossMultiplier,
    atrTrailingStopMultiplier,
    exitCostFloorBps,
    trailingStopFloorBps,
    takeProfitTimeDecayStartMs,
    takeProfitTimeDecayFullMs,
  };
};
