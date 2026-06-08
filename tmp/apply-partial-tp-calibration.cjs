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

// Calibrate partial-TP triggers to MEASURED per-class peak (MFE) distribution.
// Rule: trigger must stay ABOVE the honest break-even (net always positive) but at/below the
// class median peak (so it actually fires on normal winners). Measured 12h MFE by class:
//   long_tail  median 69 / p75 82  -> trigger 60 already fires (keep)         net +19
//   major(SOL) median 61 / top 83  -> trigger 100 NEVER fired; lower to 57    net +11, sell more (doesn't run)
//   sol_beta   median 43 / p75 77  -> trigger 70 missed half; lower to 58     net +8
//   trend_liquid median 21 / p75 41 -> peaks BELOW the 50 floor; keep high so it never banks a loss (honest)
apply(
  'partial-tp-margins',
  `  const profile =
    tokenClass === 'major'
      ? { marginBps: 50, sellBps: 3000 }
      : tokenClass === 'sol_beta'
        ? { marginBps: 20, sellBps: 3500 }
        : tokenClass === 'trend_liquid'
          ? { marginBps: 15, sellBps: 4000 }
          : { marginBps: 10, sellBps: 5000 };`,
  `  const profile =
    tokenClass === 'major'
      ? { marginBps: 7, sellBps: 4000 }
      : tokenClass === 'sol_beta'
        ? { marginBps: 8, sellBps: 3500 }
        : tokenClass === 'trend_liquid'
          ? { marginBps: 15, sellBps: 4000 }
          : { marginBps: 10, sellBps: 5000 };`,
);

fs.writeFileSync(path, src, 'utf8');
console.log('DONE: partial-TP triggers calibrated to measured per-class peaks');
