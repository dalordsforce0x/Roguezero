/**
 * Graduated-features model:
 *  - Noah (canary owner wallet / session-id pin) runs EVERY enabled lever (experiments).
 *  - Normal fleet sessions only get a lever if its feature key is in WORKER_GRADUATED_FEATURES.
 *  - Shadow telemetry levers (adaptive-exit, grid-chop) stay Noah-only to avoid fleet-wide
 *    DB write amplification at 350 bots.
 *
 * Gate: isFeatureActiveForSession(session, enabled, key) =
 *   enabled && ( isCanaryShadowEnabled(session, true)  // Noah gets everything
 *                || GRADUATED_FEATURES.has(key) )       // fleet gets proven features
 */
const fs = require('fs');
const path = 'services/worker/src/index.ts';
let src = fs.readFileSync(path, 'utf8');

function apply(label, oldStr, newStr) {
  const count = src.split(oldStr).length - 1;
  if (count !== 1) {
    throw new Error(`[${label}] expected exactly 1 match, found ${count}`);
  }
  src = src.split(oldStr).join(newStr);
  console.log(`[${label}] applied`);
}

// 1) Add WORKER_GRADUATED_FEATURES env parse right after the canary owner-wallet const.
apply(
  'env-parse',
  `const WORKER_ADAPTIVE_EXIT_CANARY_OWNER_WALLET = process.env.WORKER_ADAPTIVE_EXIT_CANARY_OWNER_WALLET?.trim() || null;`,
  `const WORKER_ADAPTIVE_EXIT_CANARY_OWNER_WALLET = process.env.WORKER_ADAPTIVE_EXIT_CANARY_OWNER_WALLET?.trim() || null;
// Graduated-features model: a comma-separated set of feature keys that have been promoted
// from Noah-only canary testing to the whole fleet. A lever is live for a normal customer
// session only if its flag is enabled AND its key is listed here. Noah (the canary owner
// wallet / session-id pin) always runs every enabled lever regardless of this list, so it
// stays our dedicated training bot. Empty/unset => nothing graduated (Noah-only).
const WORKER_GRADUATED_FEATURES = new Set(
  (process.env.WORKER_GRADUATED_FEATURES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0),
);`,
);

// 2) Add isFeatureActiveForSession helper right after isCanaryShadowEnabled.
apply(
  'helper-fn',
  `  // Exact session-id pin still works for one-off precision targeting.
  return WORKER_ADAPTIVE_EXIT_CANARY_SESSION_ID !== null && WORKER_ADAPTIVE_EXIT_CANARY_SESSION_ID === session.id;
};`,
  `  // Exact session-id pin still works for one-off precision targeting.
  return WORKER_ADAPTIVE_EXIT_CANARY_SESSION_ID !== null && WORKER_ADAPTIVE_EXIT_CANARY_SESSION_ID === session.id;
};

// Promote-aware gate. Noah (canary) runs every enabled lever; normal fleet sessions only get
// a lever once its feature key has been graduated via WORKER_GRADUATED_FEATURES.
const isFeatureActiveForSession = (session: RawSession, enabled: boolean, featureKey: string): boolean => {
  if (!enabled) return false;
  if (isCanaryShadowEnabled(session, true)) return true;
  return WORKER_GRADUATED_FEATURES.has(featureKey);
};`,
);

// 3) Re-point the 4 PROVEN execution levers to the graduated gate (shadow levers stay Noah-only).
apply(
  'call-capital-topup',
  `  const active = isCanaryShadowEnabled(session, WORKER_CAPITAL_TOPUP_ENABLED);`,
  `  const active = isFeatureActiveForSession(session, WORKER_CAPITAL_TOPUP_ENABLED, 'capital_topup');`,
);
apply(
  'call-token-class-exit',
  `  const exitProfilesActive = isCanaryShadowEnabled(session, WORKER_TOKEN_CLASS_EXIT_PROFILES_ENABLED);`,
  `  const exitProfilesActive = isFeatureActiveForSession(session, WORKER_TOKEN_CLASS_EXIT_PROFILES_ENABLED, 'token_class_exit');`,
);
apply(
  'call-partial-tp',
  `  const partialTpActive = isCanaryShadowEnabled(session, WORKER_PARTIAL_TP_ENABLED);`,
  `  const partialTpActive = isFeatureActiveForSession(session, WORKER_PARTIAL_TP_ENABLED, 'partial_tp');`,
);
apply(
  'call-class-sizing',
  `  const classSizingActive = isCanaryShadowEnabled(session, WORKER_CLASS_ENTRY_SIZING_ENABLED);`,
  `  const classSizingActive = isFeatureActiveForSession(session, WORKER_CLASS_ENTRY_SIZING_ENABLED, 'class_entry_sizing');`,
);

fs.writeFileSync(path, src, 'utf8');
console.log('DONE');
