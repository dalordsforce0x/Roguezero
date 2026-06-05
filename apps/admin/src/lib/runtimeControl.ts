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

// Fleet-wide base capacity default aligned to the 350-bot target.
const baseConcurrentCapacity = Number(process.env.WORKER_BASE_CONCURRENT_CAPACITY ?? 350);

const profileDefinitions = {
  glide: {
    label: 'Glide',
    capacityDivisor: 1,
    maxOpenPositions: 3,
    cadenceMs: {
      readyStarting: 6000,
      activeInPosition: 11000,
      activeFlat: 45000,
      activeGuarded: 60000,
      stopping: 6000,
      postSubmitFast: 2500,
    },
  },
  pulse: {
    label: 'Pulse',
    capacityDivisor: 1,
    maxOpenPositions: 10,
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
    capacityDivisor: 1,
    maxOpenPositions: null,
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
    concurrentCapacity: Math.max(1, Math.floor(baseConcurrentCapacity / profile.capacityDivisor)),
    maxOpenPositions: profile.maxOpenPositions,
    cadenceMs: profile.cadenceMs,
  };
};
