/*
 * Reduce Railway log flood: per-tick kind="price"/kind="signal" telemetry was emitting many
 * lines/sec (hitting Railway's 500 logs/sec cap and DROPPING messages). Throttle both central
 * emitters to at most one line per WORKER_TICK_LOG_MIN_INTERVAL_MS (default 5000ms). Trade
 * decision + partial-tp logs use the separate log() path and are unaffected.
 * Disk-edit (worker file served stale by buffer tools). split/join only.
 */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'services', 'worker', 'src', 'index.ts');
let src = fs.readFileSync(file, 'utf8');

function apply(label, oldStr, newStr) {
  const count = src.split(oldStr).length - 1;
  if (count !== 1) {
    throw new Error(`[${label}] expected exactly 1 match, found ${count}`);
  }
  src = src.split(oldStr).join(newStr);
  console.log('applied', label);
}

apply(
  'throttle-helpers',
  `const logSignalEvent = (event: object) => {
  console.log(JSON.stringify({
    service: 'roguezero-worker',
    kind: 'signal',
    ts: new Date().toISOString(),
    ...event,
  }));
};

const logPriceEvent = (event: object) => {
  console.log(JSON.stringify({
    service: 'roguezero-worker',
    kind: 'price',
    ts: new Date().toISOString(),
    ...event,
  }));
};`,
  `// Per-tick price/signal telemetry is high-frequency; throttle to stay well under Railway's
// 500 logs/sec replica cap (which was dropping messages). 0 disables throttling.
const WORKER_TICK_LOG_MIN_INTERVAL_MS = Number(process.env.WORKER_TICK_LOG_MIN_INTERVAL_MS ?? 5000);
let lastSignalLogMs = 0;
let lastPriceLogMs = 0;

const logSignalEvent = (event: object) => {
  const nowMs = Date.now();
  if (WORKER_TICK_LOG_MIN_INTERVAL_MS > 0 && (nowMs - lastSignalLogMs) < WORKER_TICK_LOG_MIN_INTERVAL_MS) {
    return;
  }
  lastSignalLogMs = nowMs;
  console.log(JSON.stringify({
    service: 'roguezero-worker',
    kind: 'signal',
    ts: new Date().toISOString(),
    ...event,
  }));
};

const logPriceEvent = (event: object) => {
  const nowMs = Date.now();
  if (WORKER_TICK_LOG_MIN_INTERVAL_MS > 0 && (nowMs - lastPriceLogMs) < WORKER_TICK_LOG_MIN_INTERVAL_MS) {
    return;
  }
  lastPriceLogMs = nowMs;
  console.log(JSON.stringify({
    service: 'roguezero-worker',
    kind: 'price',
    ts: new Date().toISOString(),
    ...event,
  }));
};`,
);

fs.writeFileSync(file, src, 'utf8');
console.log('done');
