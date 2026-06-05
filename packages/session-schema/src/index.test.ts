import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  DEFAULT_ROTATION_INTERVAL_MINUTES,
  createSessionRequestSchema,
  sessionRotationStateSchema,
} from './index.js';

const OWNER_WALLET = '11111111111111111111111111111111';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

test('createSessionRequestSchema defaults maxOpenPositions to the profile ceiling', () => {
  const parsed = createSessionRequestSchema.parse({
    userId: 'user-1',
    keyAuthUserId: 'keyauth-1',
    licenseId: 'license-1',
    ownerWallet: OWNER_WALLET,
    fundingMint: SOL_MINT,
    fundingTokenSymbol: 'SOL',
    startingBalanceAtomic: '0',
  });

  // GLIDE/PULSE/SURGE apply their runtime clamps on top of this session ceiling:
  // GLIDE=3, PULSE=10, SURGE=session/bot-decided.
  assert.equal(parsed.riskLimits.maxOpenPositions, 10);
  assert.equal(parsed.targetDurationMinutes, 0);
});

test('sessionRotationStateSchema defaults rotation interval to shared runtime cadence', () => {
  const parsed = sessionRotationStateSchema.parse({
    activeStrategy: 'momentum',
    queuedStrategy: 'momentum',
    lastRotatedAt: null,
    lockedUntil: null,
  });

  assert.equal(parsed.rotationIntervalMinutes, DEFAULT_ROTATION_INTERVAL_MINUTES);
  assert.equal(parsed.rotationIntervalMinutes, 15);
});
