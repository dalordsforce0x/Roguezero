export const runtimeSpeedProfileValues = ['glide', 'pulse', 'surge'] as const;
export type RuntimeSpeedProfileName = (typeof runtimeSpeedProfileValues)[number];

export type RuntimeSpeedProfile = {
  name: RuntimeSpeedProfileName;
  label: string;
  maxSolEntryUsd: number;
  concurrentCapacity: number;
  cadenceMs: {
    readyStarting: number;
    activeInPosition: number;
    activeFlat: number;
    activeGuarded: number;
    stopping: number;
    postSubmitFast: number;
  };
};

const baseConcurrentCapacity = Number(process.env.WORKER_BASE_CONCURRENT_CAPACITY ?? 120);

const profileDefinitions = {
  glide: {
    label: 'Glide',
    maxSolEntryUsd: 1500,
    capacityDivisor: 1,
    cadenceMs: {
      readyStarting: 6000,
      activeInPosition: 9000,
      activeFlat: 45000,
      activeGuarded: 60000,
      stopping: 6000,
      postSubmitFast: 2500,
    },
  },
  pulse: {
    label: 'Pulse',
    maxSolEntryUsd: 4500,
    capacityDivisor: 2,
    cadenceMs: {
      readyStarting: 3500,
      activeInPosition: 5500,
      activeFlat: 30000,
      activeGuarded: 45000,
      stopping: 5000,
      postSubmitFast: 1500,
    },
  },
  surge: {
    label: 'Surge',
    maxSolEntryUsd: 10000,
    capacityDivisor: 3,
    cadenceMs: {
      readyStarting: 2000,
      activeInPosition: 3000,
      activeFlat: 15000,
      activeGuarded: 25000,
      stopping: 4000,
      postSubmitFast: 1000,
    },
  },
} as const;

export const normalizeRuntimeSpeedProfileName = (value: string | null | undefined): RuntimeSpeedProfileName => {
  if (value === 'glide' || value === 'pulse' || value === 'surge') {
    return value;
  }

  return 'pulse';
};

export const getRuntimeSpeedProfile = (value: string | null | undefined): RuntimeSpeedProfile => {
  const name = normalizeRuntimeSpeedProfileName(value);
  const profile = profileDefinitions[name];

  return {
    name,
    label: profile.label,
    maxSolEntryUsd: profile.maxSolEntryUsd,
    concurrentCapacity: Math.max(1, Math.floor(baseConcurrentCapacity / profile.capacityDivisor)),
    cadenceMs: profile.cadenceMs,
  };
};
