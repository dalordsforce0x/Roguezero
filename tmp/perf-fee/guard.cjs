const fs = require('fs');
const target = require('path').join('services', 'worker', 'src', 'index.ts');
let raw = fs.readFileSync(target, 'utf8');
const hadCRLF = raw.includes('\r\n');
let s = raw.replace(/\r\n/g, '\n');

const oldStr = `    const fundedBaselineLamports = Number(session.funding?.startingBalanceAtomic ?? '0');
    const realizedProfitLamports = solToSend - fundedBaselineLamports;
    if (Number.isFinite(fundedBaselineLamports) && realizedProfitLamports > 0) {`;
const newStr = `    const fundedBaselineLamports = Number(session.funding?.startingBalanceAtomic ?? '0');
    const realizedProfitLamports = solToSend - fundedBaselineLamports;
    // Require a known positive funded baseline: if it is 0/unknown we cannot tell
    // principal from profit, so we skip the fee rather than risk skimming principal.
    if (Number.isFinite(fundedBaselineLamports) && fundedBaselineLamports > 0 && realizedProfitLamports > 0) {`;

const count = s.split(oldStr).length - 1;
if (count !== 1) throw new Error(`expected 1 match, found ${count}`);
s = s.replace(oldStr, newStr);
fs.writeFileSync(target, hadCRLF ? s.replace(/\n/g, '\r\n') : s, 'utf8');
console.log('baseline guard applied');
