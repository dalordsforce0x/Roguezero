const fs = require('fs');
const FILE = 'services/worker/src/index.ts';
const raw = fs.readFileSync(FILE, 'latin1');
const hadCRLF = raw.includes('\r\n');
let src = raw.replace(/\r\n/g, '\n');

function replaceOnce(haystack, oldStr, newStr, label) {
  const count = haystack.split(oldStr).length - 1;
  if (count !== 1) {
    throw new Error(`ANCHOR "${label}" matched ${count} times (expected 1)`);
  }
  return haystack.replace(oldStr, newStr);
}

// --- Edit 1: add feature flag after the token-class-exit flag ---
const flagAnchor =
`const WORKER_TOKEN_CLASS_EXIT_PROFILES_ENABLED = process.env.WORKER_TOKEN_CLASS_EXIT_PROFILES_ENABLED === 'true';`;
const flagInsert = flagAnchor +
`
// Major cost-floor reachability gate (Noah-only until graduated, ON by default for
// the canary). SOL (and any 'major') entries bypass the trending-shape and
// entry-quality gates, but live data proved their ATR-based take-profit target
// (atr*1.4 ~ 14-26bps) cannot clear the round-trip cost floor (~120bps): 0/27 SOL
// positions ever reached take-profit. When the realistic target can't clear cost,
// the take-profit is floored to an unreachable level and the position can only
// stop-out or tiny-trail. This gate blocks the entry when reachableTP < costFloor;
// it is CONDITIONAL on live ATR, so it self-opens when the major turns volatile.
const WORKER_MAJOR_COST_FLOOR_GATE_ENABLED = process.env.WORKER_MAJOR_COST_FLOOR_GATE_ENABLED !== 'false';`;
src = replaceOnce(src, flagAnchor, flagInsert, 'flag');

// --- Edit 2: insert the gate before the entry-quality block ---
const gateAnchor =
`
    // Entry-quality score + LIVE GATE. The score is computed for every entry and
    // stashed for the shadow score->MAE correlation log. The GATE then blocks`;
const gateInsert =
`
    // COST-FLOOR REACHABILITY GATE (majors / SOL base rotation). SOL 'major'
    // entries bypass the trending-shape and entry-quality gates, but live data
    // proved their ATR-based take-profit target cannot clear the round-trip cost
    // floor (0/27 SOL positions ever reached take-profit; peak ~47bps vs ~120bps
    // floor). When the realistic target can't clear cost the take-profit is floored
    // unreachable and the trade can only stop-out or tiny-trail. Gate the entry so
    // capital waits for a move that can actually pay for itself. Mirrors the exact
    // exit-engine TP formula so it never mis-gates a major whose target clears cost.
    if (
      WORKER_MAJOR_COST_FLOOR_GATE_ENABLED
      && isFeatureActiveForSession(session, WORKER_MAJOR_COST_FLOOR_GATE_ENABLED, 'major_cost_floor_gate')
      && getTokenTradeClass(selectedEntryMint, resolveTokenSymbol(selectedEntryMint)) === 'major'
    ) {
      const majorCandidateAtr = computeAtrFromTape(
        selectedEntryMint === SOL_MINT ? sharedMarketTape.solUsdPyth : getCandleBackedPriceTape(selectedEntryMint),
        strategyConfig.supertrend,
      );
      const majorCandidateAtrBps = majorCandidateAtr?.atrBps ?? null;
      if (majorCandidateAtrBps !== null && majorCandidateAtrBps > 0) {
        const exitProfilesActiveForGate = isFeatureActiveForSession(
          session,
          WORKER_TOKEN_CLASS_EXIT_PROFILES_ENABLED,
          'token_class_exit',
        );
        const majorTakeProfitMult = exitProfilesActiveForGate
          ? getTokenClassExitProfile(getTokenTradeClass(selectedEntryMint, resolveTokenSymbol(selectedEntryMint))).takeProfitMult
          : positionExitPolicy.atrTakeProfitMultiplier;
        const majorSignalStrengthBps = Math.abs(tokenEntrySignal.momentumBps ?? 0);
        const majorSignalStrengthBoost = Math.min(0.5, majorSignalStrengthBps / 200);
        const reachableTakeProfitBps = Math.round(majorCandidateAtrBps * majorTakeProfitMult * (1 + majorSignalStrengthBoost));
        const majorCostFloorBps = computeExitCostFloorBps(session);
        if (reachableTakeProfitBps < majorCostFloorBps) {
          const reason = 'entry_target_below_cost_floor';
          await persistTradeDecision(session, 'blocked', reason);
          await persistLastTradeGate(session, {
            at: new Date().toISOString(),
            decision: 'blocked',
            reason,
            expectedEdgeBps: reachableTakeProfitBps,
            estimatedCostBps: majorCostFloorBps,
            safetyBufferBps: strategyConfig.momentum.edgeSafetyBufferBps,
          });
          log(
            'info',
            session.id,
            \`entry blocked: major cost-floor gate for \${resolveTokenSymbol(selectedEntryMint)} (\${selectedEntryMint}) reachableTpBps=\${reachableTakeProfitBps} costFloorBps=\${majorCostFloorBps} atrBps=\${majorCandidateAtrBps} tpMult=\${majorTakeProfitMult}\`,
          );
          return;
        }
      }
    }

    // Entry-quality score + LIVE GATE. The score is computed for every entry and
    // stashed for the shadow score->MAE correlation log. The GATE then blocks`;
src = replaceOnce(src, gateAnchor, gateInsert, 'gate');

const out = hadCRLF ? src.replace(/\n/g, '\r\n') : src;
fs.writeFileSync(FILE, out, 'latin1');
console.log('OK: both edits applied');
