// One-shot disk edit: add owner-wallet canary scoping to the worker.
// Run: node tmp/apply-canary-wallet-scope.cjs
const fs = require('fs');
const path = require('path');

const file = path.resolve(__dirname, '..', 'services', 'worker', 'src', 'index.ts');
let src = fs.readFileSync(file, 'utf8');
const before = src;

// 1) Add the stable owner-wallet env const right after the session-id const.
const envOld = "const WORKER_ADAPTIVE_EXIT_CANARY_SESSION_ID = process.env.WORKER_ADAPTIVE_EXIT_CANARY_SESSION_ID?.trim() || null;\n";
const envNew = envOld +
  "// Sessions are ephemeral (a fresh session_wallet + session id every funding cycle), so\n" +
  "// pinning the canary to a single session id forces an env change + redeploy every time a\n" +
  "// new Noah session is created. Scoping by the stable OWNER wallet (the DaLordsForce test\n" +
  "// wallet that funds Noah) lets every new ephemeral Noah session auto-enroll as the canary\n" +
  "// with zero redeploy. Real customer wallets never match, so they are never shadow-scoped.\n" +
  "const WORKER_ADAPTIVE_EXIT_CANARY_OWNER_WALLET = process.env.WORKER_ADAPTIVE_EXIT_CANARY_OWNER_WALLET?.trim() || null;\n";

if (!src.includes("const WORKER_ADAPTIVE_EXIT_CANARY_OWNER_WALLET")) {
  if (!src.includes(envOld)) throw new Error('env anchor not found');
  src = src.replace(envOld, envNew);
}

// 2) Replace the scope function body to match session id OR owner wallet.
const fnOld =
  "const isCanaryShadowEnabled = (session: RawSession, enabled: boolean): boolean => {\n" +
  "  if (!enabled) return false;\n" +
  "  return WORKER_ADAPTIVE_EXIT_CANARY_SESSION_ID === null || WORKER_ADAPTIVE_EXIT_CANARY_SESSION_ID === session.id;\n" +
  "};";
const fnNew =
  "const isCanaryShadowEnabled = (session: RawSession, enabled: boolean): boolean => {\n" +
  "  if (!enabled) return false;\n" +
  "  // No scoping configured at all => shadow applies to every session.\n" +
  "  if (WORKER_ADAPTIVE_EXIT_CANARY_SESSION_ID === null && WORKER_ADAPTIVE_EXIT_CANARY_OWNER_WALLET === null) {\n" +
  "    return true;\n" +
  "  }\n" +
  "  // Stable owner-wallet match: every ephemeral Noah session funded by this wallet enrolls\n" +
  "  // automatically, so we never have to repoint a session id + redeploy per session.\n" +
  "  if (WORKER_ADAPTIVE_EXIT_CANARY_OWNER_WALLET !== null && session.owner_wallet === WORKER_ADAPTIVE_EXIT_CANARY_OWNER_WALLET) {\n" +
  "    return true;\n" +
  "  }\n" +
  "  // Exact session-id pin still works for one-off precision targeting.\n" +
  "  return WORKER_ADAPTIVE_EXIT_CANARY_SESSION_ID !== null && WORKER_ADAPTIVE_EXIT_CANARY_SESSION_ID === session.id;\n" +
  "};";

if (src.includes(fnNew)) {
  console.log('scope function already updated');
} else {
  if (!src.includes(fnOld)) throw new Error('scope function anchor not found');
  src = src.replace(fnOld, fnNew);
}

if (src === before) {
  console.log('no changes needed (already applied)');
} else {
  fs.writeFileSync(file, src, 'utf8');
  console.log('applied: owner-wallet canary scoping');
}
