// Disk-edit: fix grid chop regime detection to use SESSION-level strategy signal
// regime instead of the per-position exit signalRegime (which never reported 'flat'
// even in obvious chop, so the virtual grid stayed disabled in ranging markets).
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'services', 'worker', 'src', 'index.ts');
let src = fs.readFileSync(file, 'utf8');

// --- 1) function signature + marketRegime detection ---
const oldFn = `const buildGridChopShadow = (params: {
  session: RawSession;
  evaluations: Array<Record<string, unknown>>;
}) => {
  const enabled = isCanaryShadowEnabled(params.session, WORKER_GRID_CHOP_SHADOW_ENABLED);
  const marketRegime = enabled && params.evaluations.some((evaluation) => evaluation.signalRegime === 'flat')
    ? 'chop' as const
    : enabled
      ? 'trend' as const
      : 'unknown' as const;`;

const newFn = `const buildGridChopShadow = (params: {
  session: RawSession;
  evaluations: Array<Record<string, unknown>>;
  sessionIsChop: boolean;
}) => {
  const enabled = isCanaryShadowEnabled(params.session, WORKER_GRID_CHOP_SHADOW_ENABLED);
  // Chop detection keys off the SESSION-level strategy signal regime (the momentum /
  // mean-reversion tape read), NOT the per-position exit signalRegime. The latter
  // never reported 'flat' even in obvious chop, so the virtual grid stayed disabled
  // in the exact ranging conditions it exists for. params.sessionIsChop is computed
  // from the live session strategy signals at the call site.
  const marketRegime = !enabled
    ? 'unknown' as const
    : params.sessionIsChop
      ? 'chop' as const
      : 'trend' as const;`;

if (!src.includes(oldFn)) throw new Error('buildGridChopShadow anchor not found');
src = src.split(oldFn).join(newFn);

// --- 2) call site: compute sessionIsChop from live session signals + pass it ---
const oldCall = `    if (WORKER_EXIT_TELEMETRY_ENABLED && exitEvaluations.length > 0) {
      const adaptiveExitShadow = buildAdaptiveExitShadow({ session, evaluations: exitEvaluations });
      const gridChopShadow = buildGridChopShadow({ session, evaluations: exitEvaluations });`;

const newCall = `    if (WORKER_EXIT_TELEMETRY_ENABLED && exitEvaluations.length > 0) {
      // Session-level chop read: any active/scanned strategy signal reporting a flat
      // (ranging) regime means the market is chopping, which is when the virtual grid
      // shadow should observe. Sourced from the live session signals, not per-position.
      const sessionIsChop = Array.from(strategySignalByKey.values()).some((signal) => signal.regime === 'flat');
      const adaptiveExitShadow = buildAdaptiveExitShadow({ session, evaluations: exitEvaluations });
      const gridChopShadow = buildGridChopShadow({ session, evaluations: exitEvaluations, sessionIsChop });`;

if (!src.includes(oldCall)) throw new Error('grid call-site anchor not found');
src = src.split(oldCall).join(newCall);

fs.writeFileSync(file, src, 'utf8');
console.log('applied: grid regime fix (session-level chop detection)');
