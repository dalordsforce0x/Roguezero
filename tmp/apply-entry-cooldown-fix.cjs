const fs = require('fs');
const path = require('path');
const file = path.resolve('services/worker/src/index.ts');
let text = fs.readFileSync(file, 'utf8');

function replaceOnce(label, oldText, newText) {
  const count = text.split(oldText).length - 1;
  if (count !== 1) {
    throw new Error(`${label}: expected 1 match, found ${count}`);
  }
  text = text.replace(oldText, newText);
}

replaceOnce(
  'constant',
  `const WORKER_STOP_LOSS_LOCK_MS = Number(process.env.WORKER_STOP_LOSS_LOCK_MS ?? 10 * 60_000);\n// In a flat tape there is no persistent bullish candidate; only a routed-fallback`,
  `const WORKER_STOP_LOSS_LOCK_MS = Number(process.env.WORKER_STOP_LOSS_LOCK_MS ?? 10 * 60_000);\n// Post-prepare entry reject cooldown. If a candidate passes the cheap scout but\n// then fails a cost/economics/route gate, do not let it monopolize the next few\n// cycles. This is intentionally short and in-memory: prices move every minute,\n// so the token can re-enter consideration quickly without pinning selection.\nconst WORKER_ENTRY_REJECT_COOLDOWN_MS = Number(process.env.WORKER_ENTRY_REJECT_COOLDOWN_MS ?? 3 * 60_000);\n// In a flat tape there is no persistent bullish candidate; only a routed-fallback`,
);

replaceOnce(
  'helpers',
  `const measuredExitImpactBpsByMint = new Map<string, number>();\n\nconst computeExitCostFloorBps = (`,
  `const measuredExitImpactBpsByMint = new Map<string, number>();\n\nconst entryRejectCooldowns = new Map<string, { expiresAtMs: number; reason: string }>();\nconst ENTRY_REJECT_COOLDOWN_REASONS = new Set([\n  'entry_edge_below_cost',\n  'entry_leg_cost_too_high',\n  'entry_quality_below_threshold',\n  'exit_impact_too_high',\n  'exit_route_not_found',\n  'exit_probe_entry_route_not_found',\n  'price_impact_too_high',\n  'route_stability_impact_too_high',\n  'route_stability_impact_unstable',\n  'route_stability_output_unstable',\n]);\n\nconst getEntryRejectCooldownKey = (sessionId: string, mint: string) => \`${'${sessionId}'}:${'${mint}'}\`;\n\nconst getActiveEntryRejectCooldownMints = (sessionId: string, nowMs: number): Set<string> => {\n  const active = new Set<string>();\n  for (const [key, cooldown] of entryRejectCooldowns.entries()) {\n    const separatorIdx = key.indexOf(':');\n    const keySessionId = separatorIdx >= 0 ? key.slice(0, separatorIdx) : '';\n    const mint = separatorIdx >= 0 ? key.slice(separatorIdx + 1) : '';\n    if (cooldown.expiresAtMs <= nowMs || !mint) {\n      entryRejectCooldowns.delete(key);\n      continue;\n    }\n    if (keySessionId === sessionId) {\n      active.add(mint);\n    }\n  }\n  return active;\n};\n\nconst recordEntryRejectCooldown = (session: RawSession, mint: string | null | undefined, reason: string | null | undefined): void => {\n  if (WORKER_ENTRY_REJECT_COOLDOWN_MS <= 0 || !mint || !reason || !ENTRY_REJECT_COOLDOWN_REASONS.has(reason)) {\n    return;\n  }\n  if (mint === USDC_MINT || mint === SOL_MINT) {\n    return;\n  }\n  const expiresAtMs = Date.now() + WORKER_ENTRY_REJECT_COOLDOWN_MS;\n  entryRejectCooldowns.set(getEntryRejectCooldownKey(session.id, mint), { expiresAtMs, reason });\n  log(\n    'info',\n    session.id,\n    \`entry candidate cooldown: ${'${resolveTokenSymbol(mint)'} } (${'${mint}'}) reason=${'${reason}'} ms=${'${WORKER_ENTRY_REJECT_COOLDOWN_MS}'}\`,\n  );\n};\n\nconst recordTradePlanEntryRejectCooldown = (\n  session: RawSession,\n  tradePlan: TradeExecutionPlan | null,\n  reason: string | null | undefined,\n): void => {\n  if (tradePlan?.direction !== 'enter_long') {\n    return;\n  }\n  recordEntryRejectCooldown(session, tradePlan.inventory.outputMint, reason);\n};\n\nconst computeExitCostFloorBps = (`,
);

// Fix a template-string typo introduced by nested script escaping.
text = text.replace("`entry candidate cooldown: ${resolveTokenSymbol(mint) } (${mint}) reason=${reason} ms=${WORKER_ENTRY_REJECT_COOLDOWN_MS}`", "`entry candidate cooldown: ${resolveTokenSymbol(mint)} (${mint}) reason=${reason} ms=${WORKER_ENTRY_REJECT_COOLDOWN_MS}`");

replaceOnce(
  'scout exclusions',
  `      const lockedClusters = getActiveStopLossLockedClusters(session, Date.now());\n      const excludedClusters = new Set<string>([...cappedClusters, ...lockedClusters]);\n\n      const scout = await scoutEntryUniverse({`,
  `      const lockedClusters = getActiveStopLossLockedClusters(session, Date.now());\n      const excludedClusters = new Set<string>([...cappedClusters, ...lockedClusters]);\n      const entryRejectCooldownMints = getActiveEntryRejectCooldownMints(session.id, Date.now());\n      const excludedScoutMints = new Set<string>([...openPositionMints, ...entryRejectCooldownMints]);\n      if (entryRejectCooldownMints.size > 0) {\n        log(\n          'info',\n          session.id,\n          \`universe scout excluding ${'${entryRejectCooldownMints.size}'} recent rejected candidate(s): ${'${[...entryRejectCooldownMints].map((mint) => resolveTokenSymbol(mint)).join(\',\')}'}\`,\n        );\n      }\n\n      const scout = await scoutEntryUniverse({`,
);

replaceOnce(
  'excluded mints',
  `        excludedMints: openPositionMints,`,
  `        excludedMints: excludedScoutMints,`,
);

replaceOnce(
  'route stability cooldown',
  `    if (!routeStability.stable) {\n      await persistTradeDecision(session, 'blocked', routeStability.reason);`,
  `    if (!routeStability.stable) {\n      recordEntryRejectCooldown(session, selectedEntryMint, routeStability.reason);\n      await persistTradeDecision(session, 'blocked', routeStability.reason);`,
);

replaceOnce(
  'exit liquidity cooldown',
  `    if (!exitLiquidity.ok) {\n      await persistTradeDecision(session, 'blocked', exitLiquidity.reason);`,
  `    if (!exitLiquidity.ok) {\n      recordEntryRejectCooldown(session, selectedEntryMint, exitLiquidity.reason);\n      await persistTradeDecision(session, 'blocked', exitLiquidity.reason);`,
);

replaceOnce(
  'quality cooldown',
  `      if (!qualityOk) {\n        await persistTradeDecision(session, 'blocked', 'entry_quality_below_threshold');`,
  `      if (!qualityOk) {\n        recordEntryRejectCooldown(session, selectedEntryMint, 'entry_quality_below_threshold');\n        await persistTradeDecision(session, 'blocked', 'entry_quality_below_threshold');`,
);

replaceOnce(
  'preprepare cooldown',
  `  if (prePrepareEntryGate && !prePrepareEntryGate.allowed) {\n    await persistTradeDecision(session, 'blocked', prePrepareEntryGate.reason);`,
  `  if (prePrepareEntryGate && !prePrepareEntryGate.allowed) {\n    recordTradePlanEntryRejectCooldown(session, tradePlan, prePrepareEntryGate.reason);\n    await persistTradeDecision(session, 'blocked', prePrepareEntryGate.reason);`,
);

replaceOnce(
  'economics cooldown',
  `  if (!forceExitExecution && economics && (!economics.economicallyViable || !economics.withinRiskBudget)) {\n    await persistTradeDecision(session, 'blocked', sizingReason ?? 'economics_blocked');`,
  `  if (!forceExitExecution && economics && (!economics.economicallyViable || !economics.withinRiskBudget)) {\n    recordTradePlanEntryRejectCooldown(session, tradePlan, sizingReason ?? 'economics_blocked');\n    await persistTradeDecision(session, 'blocked', sizingReason ?? 'economics_blocked');`,
);

replaceOnce(
  'tradegate cooldown',
  `  if (tradeGate && !tradeGate.allowed) {\n    await persistTradeDecision(session, 'blocked', tradeGate.reason);`,
  `  if (tradeGate && !tradeGate.allowed) {\n    recordTradePlanEntryRejectCooldown(session, tradePlan, tradeGate.reason);\n    await persistTradeDecision(session, 'blocked', tradeGate.reason);`,
);

replaceOnce(
  'price impact cooldown',
  `  if (sizingReason === 'price_impact_too_high') {\n    await persistTradeDecision(session, 'blocked', sizingReason);`,
  `  if (sizingReason === 'price_impact_too_high') {\n    recordTradePlanEntryRejectCooldown(session, tradePlan, sizingReason);\n    await persistTradeDecision(session, 'blocked', sizingReason);`,
);

fs.writeFileSync(file, text);
console.log('entry cooldown patch applied');
