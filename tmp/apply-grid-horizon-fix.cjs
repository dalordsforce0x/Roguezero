const fs = require('fs');

function editFile(path, edits) {
  let src = fs.readFileSync(path, 'utf8');
  for (const [label, oldStr, newStr] of edits) {
    const count = src.split(oldStr).length - 1;
    if (count !== 1) {
      throw new Error(`[${label}] expected exactly 1 match in ${path}, found ${count}`);
    }
    src = src.split(oldStr).join(newStr);
    console.log(`[${label}] applied`);
  }
  fs.writeFileSync(path, src, 'utf8');
}

// 1) runtime-config: raise shared market tape retention so the grid has enough history
//    to measure the real chop cycle (~60 min) instead of an 8-min keyhole.
//    SAFE for entry signals: momentum/ATR/supertrend/mean-reversion each slice their OWN
//    short lookback from the tail; raising the cap only retains more old history they never read.
editFile('packages/runtime-config/src/index.ts', [
  [
    'tape-size',
    `const sharedTapeSize = Number(env.WORKER_SHARED_MARKET_TAPE_SIZE ?? 120);`,
    `const sharedTapeSize = Number(env.WORKER_SHARED_MARKET_TAPE_SIZE ?? 900);`,
  ],
]);

// 2) worker: widen the grid range window to ~30 min and scale the breakout lookback to ~1 min,
//    so the virtual grid can SEE a full chop swing (tokens swing 100-325 bps over ~30-60 min,
//    but the old 4-min window only ever saw 28-41 bps of it).
editFile('services/worker/src/index.ts', [
  [
    'grid-window',
    `const GRID_RANGE_WINDOW = Number(process.env.WORKER_GRID_RANGE_WINDOW ?? 60);`,
    `const GRID_RANGE_WINDOW = Number(process.env.WORKER_GRID_RANGE_WINDOW ?? 450);`,
  ],
  [
    'grid-recent-lookback',
    `const GRID_RECENT_MOVE_LOOKBACK = Number(process.env.WORKER_GRID_RECENT_MOVE_LOOKBACK ?? 3);`,
    `const GRID_RECENT_MOVE_LOOKBACK = Number(process.env.WORKER_GRID_RECENT_MOVE_LOOKBACK ?? 15);`,
  ],
]);

console.log('DONE: grid horizon widened to real chop-cycle length');
