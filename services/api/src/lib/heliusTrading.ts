import bs58 from 'bs58';
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';

export const SENDER_TIP_ACCOUNTS = [
  '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE',
  'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ',
  '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta',
  '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn',
  '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD',
  '2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ',
  'wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF',
  '3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT',
  '4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey',
  '4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or',
] as const;

export const priorityLevelValues = ['Medium', 'High', 'VeryHigh'] as const;
export type PriorityLevel = (typeof priorityLevelValues)[number];

export const tipTierValues = ['normal', 'elevated', 'urgent'] as const;
export type TipTier = (typeof tipTierValues)[number];

export type HeliusTradingConfig = {
  gatekeeperEnabled: boolean;
  senderEnabled: boolean;
  senderEndpoint: string;
  senderEscalationEndpoint: string;
  senderUseSwqosOnly: boolean;
  senderMinTipLamports: number;
  senderElevatedTipLamports: number;
  senderUrgentTipLamports: number;
  priorityFeeLevel: PriorityLevel;
  priorityFeeMultiplier: number;
  priorityFeeFallbackMicroLamports: number;
  priorityFeeCapMicroLamports: number;
};

const parseBoolean = (value: string | undefined, defaultValue: boolean) => {
  if (value === undefined) return defaultValue;
  return value === 'true';
};

const parsePositiveInt = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const parsePositiveNumber = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parsePriorityLevel = (value: string | undefined): PriorityLevel => {
  if (value === 'Medium' || value === 'VeryHigh') return value;
  return 'High';
};

export const getHeliusTradingConfig = (env: NodeJS.ProcessEnv): HeliusTradingConfig => {
  // Default to SWQoS-only: staked connections without Jito auction.
  // 38x cheaper tips (5K vs 200K lamports). Escalate to full Sender on congestion.
  const senderUseSwqosOnly = parseBoolean(env.HELIUS_SENDER_USE_SWQOS_ONLY, true);
  const senderRegion = (env.HELIUS_SENDER_REGION ?? '').toLowerCase().trim();
  const regionalBase = senderRegion === 'slc'
    ? 'http://slc-sender.helius-rpc.com/fast'
    : senderRegion === 'ewr'
      ? 'http://ewr-sender.helius-rpc.com/fast'
      : 'https://sender.helius-rpc.com/fast';
  const swqosEndpoint = `${regionalBase}${regionalBase.includes('?') ? '&' : '?'}swqos_only=true`;
  const fullEndpoint = regionalBase;
  const defaultSenderEndpoint = senderUseSwqosOnly ? swqosEndpoint : fullEndpoint;

  return {
    gatekeeperEnabled: parseBoolean(env.HELIUS_GATEKEEPER_ENABLED, true),
    senderEnabled: parseBoolean(env.HELIUS_SENDER_ENABLED, true),
    senderEndpoint: env.HELIUS_SENDER_ENDPOINT || defaultSenderEndpoint,
    senderEscalationEndpoint: env.HELIUS_SENDER_ESCALATION_ENDPOINT || fullEndpoint,
    senderUseSwqosOnly,
    senderMinTipLamports: parsePositiveInt(
      env.HELIUS_SENDER_MIN_TIP_LAMPORTS,
      5_000,
    ),
    senderElevatedTipLamports: parsePositiveInt(
      env.HELIUS_SENDER_ELEVATED_TIP_LAMPORTS,
      50_000,
    ),
    senderUrgentTipLamports: parsePositiveInt(
      env.HELIUS_SENDER_URGENT_TIP_LAMPORTS,
      200_000,
    ),
    priorityFeeLevel: parsePriorityLevel(env.HELIUS_PRIORITY_FEE_LEVEL),
    priorityFeeMultiplier: parsePositiveNumber(env.HELIUS_PRIORITY_FEE_MULTIPLIER, 1.2),
    priorityFeeFallbackMicroLamports: parsePositiveInt(
      env.HELIUS_PRIORITY_FEE_FALLBACK_MICROLAMPORTS,
      50_000,
    ),
    priorityFeeCapMicroLamports: parsePositiveInt(
      env.HELIUS_PRIORITY_FEE_CAP_MICROLAMPORTS,
      senderUseSwqosOnly ? 100_000 : 0,
    ),
  };
};

export const getTipLamportsForTier = (config: HeliusTradingConfig, tier: TipTier): number => {
  switch (tier) {
    case 'urgent': return config.senderUrgentTipLamports;
    case 'elevated': return config.senderElevatedTipLamports;
    default: return config.senderMinTipLamports;
  }
};

export const getSenderEndpointForTier = (config: HeliusTradingConfig, tier: TipTier): string => {
  // urgent tier uses full Sender (SWQoS + Jito dual-route) for maximum landing probability
  if (tier === 'urgent') return config.senderEscalationEndpoint;
  return config.senderEndpoint;
};

export const selectSenderTipAccount = (random = Math.random) => {
  const index = Math.min(
    SENDER_TIP_ACCOUNTS.length - 1,
    Math.floor(random() * SENDER_TIP_ACCOUNTS.length),
  );
  return new PublicKey(SENDER_TIP_ACCOUNTS[index]);
};

export const createSenderTipInstruction = (
  payer: PublicKey,
  lamports: number,
  random = Math.random,
) => SystemProgram.transfer({
  fromPubkey: payer,
  toPubkey: selectSenderTipAccount(random),
  lamports,
});

export const composePreparedSwapInstructions = (params: {
  senderEnabled: boolean;
  payer: PublicKey;
  computeUnitLimit: number;
  priorityFeeMicroLamports?: number;
  senderTipLamports?: number;
  baseComputeBudgetInstructions: TransactionInstruction[];
  coreSwapInstructions: TransactionInstruction[];
  random?: () => number;
}) => {
  if (!params.senderEnabled) {
    return [
      ComputeBudgetProgram.setComputeUnitLimit({ units: params.computeUnitLimit }),
      ...params.baseComputeBudgetInstructions,
      ...params.coreSwapInstructions,
    ];
  }

  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: params.computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: params.priorityFeeMicroLamports ?? 50_000,
    }),
    ...params.coreSwapInstructions,
    createSenderTipInstruction(
      params.payer,
      params.senderTipLamports ?? 200_000,
      params.random,
    ),
  ];
};

export const buildPriorityFeeEstimateRequest = (params: {
  payer: PublicKey;
  blockhash: string;
  instructions: TransactionInstruction[];
  priorityLevel: PriorityLevel;
}) => {
  const options = {
    priorityLevel: params.priorityLevel,
    recommended: true,
  };

  try {
    const estimateTransaction = new Transaction({
      feePayer: params.payer,
      recentBlockhash: params.blockhash,
    });

    for (const instruction of params.instructions) {
      estimateTransaction.add(instruction);
    }

    return {
      jsonrpc: '2.0',
      id: 'priority-fee-estimate',
      method: 'getPriorityFeeEstimate',
      params: [
        {
          transaction: bs58.encode(
            estimateTransaction.serialize({
              requireAllSignatures: false,
              verifySignatures: false,
            }),
          ),
          options,
        },
      ],
    };
  } catch {
    const accountKeys = [...new Set([
      params.payer.toBase58(),
      ...params.instructions.flatMap((instruction) => [
        instruction.programId.toBase58(),
        ...instruction.keys.map((account) => account.pubkey.toBase58()),
      ]),
    ])];

    return {
      jsonrpc: '2.0',
      id: 'priority-fee-estimate',
      method: 'getPriorityFeeEstimate',
      params: [
        {
          accountKeys,
          options,
        },
      ],
    };
  }
};

export const parsePriorityFeeEstimateResponse = (
  payload: unknown,
  fallbackMicroLamports: number,
  multiplier: number,
  capMicroLamports?: number,
) => {
  const estimate = (payload as { result?: { priorityFeeEstimate?: unknown } } | null)?.result?.priorityFeeEstimate;
  const numericEstimate = typeof estimate === 'number' && Number.isFinite(estimate)
    ? estimate
    : fallbackMicroLamports;
  const scaled = Math.max(1, Math.ceil(numericEstimate * multiplier));
  return capMicroLamports && capMicroLamports > 0 ? Math.min(scaled, capMicroLamports) : scaled;
};

export const parseSenderSignature = (payload: unknown) => {
  const errorMessage = (payload as { error?: { message?: unknown } } | null)?.error?.message;
  if (typeof errorMessage === 'string' && errorMessage.length > 0) {
    throw new Error(errorMessage);
  }

  const result = (payload as { result?: unknown } | null)?.result;
  if (typeof result !== 'string' || result.length === 0) {
    throw new Error('Sender did not return a transaction signature');
  }
  return result;
};
