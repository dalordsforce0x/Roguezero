from pathlib import Path

path = Path('services/worker/src/index.ts')
text = path.read_text(encoding='utf-8')

def replace_once(src: str, dst: str, label: str):
    global text
    count = text.count(src)
    if count != 1:
        raise RuntimeError(f'{label}: expected 1 match, found {count}')
    text = text.replace(src, dst, 1)

if 'WORKER_INVENTORY_RECONCILE_ENABLED' not in text:
    replace_once(
        "const WORKER_EXIT_SHADOW_HISTORY_ENABLED = process.env.WORKER_EXIT_SHADOW_HISTORY_ENABLED !== 'false';\nconst WORKER_ADAPTIVE_EXIT_CANARY_SESSION_ID = process.env.WORKER_ADAPTIVE_EXIT_CANARY_SESSION_ID?.trim() || null;",
        "const WORKER_EXIT_SHADOW_HISTORY_ENABLED = process.env.WORKER_EXIT_SHADOW_HISTORY_ENABLED !== 'false';\nconst WORKER_INVENTORY_RECONCILE_ENABLED = process.env.WORKER_INVENTORY_RECONCILE_ENABLED !== 'false';\nconst WORKER_INVENTORY_RECONCILE_MS = Number(process.env.WORKER_INVENTORY_RECONCILE_MS ?? 60_000);\nconst WORKER_ADAPTIVE_EXIT_CANARY_SESSION_ID = process.env.WORKER_ADAPTIVE_EXIT_CANARY_SESSION_ID?.trim() || null;",
        'inventory flags',
    )

if 'lastInventoryReconcileAtBySession' not in text:
    replace_once(
        "const latestJupiterUsdByMint = new Map<string, number>();\nconst previousJupiterUsdByMint = new Map<string, number>();\nconst latestJupiterDecimalsByMint = new Map<string, number>();",
        "const latestJupiterUsdByMint = new Map<string, number>();\nconst previousJupiterUsdByMint = new Map<string, number>();\nconst latestJupiterDecimalsByMint = new Map<string, number>();\nconst lastInventoryReconcileAtBySession = new Map<string, number>();",
        'inventory throttle map',
    )

if 'type WalletTokenInventory' not in text:
    replace_once(
        "type TokenBalanceLookupSnapshot = {\n  balanceAtomic: number;\n  programId: string | null;\n  tokenAccount: string | null;\n  source: 'associated_token_account' | 'owner_scan' | 'none';\n  attemptedPrograms: string[];\n};",
        "type TokenBalanceLookupSnapshot = {\n  balanceAtomic: number;\n  programId: string | null;\n  tokenAccount: string | null;\n  source: 'associated_token_account' | 'owner_scan' | 'none';\n  attemptedPrograms: string[];\n};\n\ntype WalletTokenInventory = {\n  mint: string;\n  symbol: string;\n  balanceAtomic: number;\n  tokenDecimals: number | null;\n  programId: string;\n  tokenAccounts: string[];\n};\n\ntype RecoveredEntryBasis = {\n  entryPriceUsd: number | null;\n  entryStrategy: SessionPositionState['entryStrategy'];\n  entryAt: string | null;\n};",
        'inventory types',
    )

helpers = r'''
const getOnChainMintDecimals = async (mint: PublicKey, programId: PublicKey): Promise<number | null> => {
  const cached = latestJupiterDecimalsByMint.get(mint.toBase58());
  if (typeof cached === 'number' && Number.isFinite(cached)) {
    return cached;
  }

  try {
    const mintAccount = await rlGetMint(mint, programId);
    return mintAccount.decimals;
  } catch {
    return null;
  }
};

const listWalletTokenInventory = async (owner: PublicKey): Promise<WalletTokenInventory[]> => {
  const byMint = new Map<string, WalletTokenInventory>();
  const programs = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];

  for (const programId of programs) {
    let tokenAccounts: Awaited<ReturnType<typeof rlGetTokenAccountsByOwner>>;
    try {
      tokenAccounts = await rlGetTokenAccountsByOwner(owner, programId);
    } catch {
      continue;
    }

    for (const tokenAccount of tokenAccounts.value) {
      let account: SplTokenAccount;
      try {
        account = unpackAccount(tokenAccount.pubkey, tokenAccount.account, programId);
      } catch {
        continue;
      }

      const balanceAtomic = Number(account.amount);
      if (!Number.isFinite(balanceAtomic) || balanceAtomic <= 0) {
        continue;
      }

      const mint = account.mint.toBase58();
      if (mint === USDC_MINT) {
        continue;
      }

      const existing = byMint.get(mint);
      if (existing) {
        existing.balanceAtomic += balanceAtomic;
        existing.tokenAccounts.push(tokenAccount.pubkey.toBase58());
        continue;
      }

      byMint.set(mint, {
        mint,
        symbol: resolveTokenSymbol(mint),
        balanceAtomic,
        tokenDecimals: await getOnChainMintDecimals(account.mint, programId),
        programId: programId.toBase58(),
        tokenAccounts: [tokenAccount.pubkey.toBase58()],
      });
    }
  }

  return [...byMint.values()];
};

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' ? value as Record<string, unknown> : null
);

const getExecutionAmountAtomic = (row: { amount?: unknown; build_response?: unknown }, key: 'inAmount' | 'outAmount') => {
  const build = asRecord(row.build_response);
  const fromBuild = build?.[key];
  const parsedBuild = typeof fromBuild === 'string' || typeof fromBuild === 'number'
    ? Number(fromBuild)
    : NaN;
  if (Number.isFinite(parsedBuild) && parsedBuild > 0) {
    return parsedBuild;
  }

  if (key === 'inAmount') {
    const amount = Number(row.amount ?? 0);
    return Number.isFinite(amount) && amount > 0 ? amount : 0;
  }

  return 0;
};

const getConfirmationTokenDeltaAtomic = (
  confirmation: unknown,
  params: { mint: string; owner: string },
): number | null => {
  const snapshot = asRecord(confirmation);
  if (!snapshot) return null;
  const meta = asRecord(snapshot.meta);
  const preTokenBalances = Array.isArray(snapshot.preTokenBalances)
    ? snapshot.preTokenBalances
    : (Array.isArray(meta?.preTokenBalances) ? meta.preTokenBalances : []);
  const postTokenBalances = Array.isArray(snapshot.postTokenBalances)
    ? snapshot.postTokenBalances
    : (Array.isArray(meta?.postTokenBalances) ? meta.postTokenBalances : []);
  const matchingIndexes = new Set<number>();

  const matches = (entry: unknown) => {
    const record = asRecord(entry);
    if (!record || record.mint !== params.mint) return false;
    if (typeof record.owner === 'string' && record.owner !== params.owner) return false;
    return Number.isInteger(record.accountIndex);
  };

  for (const entry of preTokenBalances) {
    if (matches(entry)) matchingIndexes.add(Number(asRecord(entry)?.accountIndex));
  }
  for (const entry of postTokenBalances) {
    if (matches(entry)) matchingIndexes.add(Number(asRecord(entry)?.accountIndex));
  }

  if (matchingIndexes.size === 0) return null;

  const amountOf = (entry: unknown) => {
    const record = asRecord(entry);
    const uiTokenAmount = asRecord(record?.uiTokenAmount);
    const amount = Number(uiTokenAmount?.amount ?? '0');
    return Number.isFinite(amount) ? amount : 0;
  };

  let delta = 0;
  for (const accountIndex of matchingIndexes) {
    const pre = preTokenBalances.find((entry) => Number(asRecord(entry)?.accountIndex) === accountIndex);
    const post = postTokenBalances.find((entry) => Number(asRecord(entry)?.accountIndex) === accountIndex);
    delta += amountOf(post) - amountOf(pre);
  }

  return delta;
};

const parseExecutionStrategy = (value: unknown): SessionPositionState['entryStrategy'] => (
  value === 'momentum' || value === 'mean_reversion' || value === 'supertrend' ? value : null
);

const findRecoveredEntryBasis = async (
  session: RawSession,
  inventory: WalletTokenInventory,
): Promise<RecoveredEntryBasis> => {
  const result = await getPool().query<{
    input_mint: string;
    output_mint: string;
    amount: string | number | null;
    build_response: unknown;
    confirmation: unknown;
    metadata: unknown;
    confirmed_at: Date | null;
    created_at: Date;
  }>(
    `SELECT input_mint, output_mint, amount, build_response, confirmation, metadata, confirmed_at, created_at
       FROM swap_executions
      WHERE taker = $1
        AND status = 'confirmed'
        AND output_mint = $2
        AND input_mint IN ($3, $4)
      ORDER BY confirmed_at DESC NULLS LAST, created_at DESC
      LIMIT 10`,
    [session.session_wallet, inventory.mint, USDC_MINT, SOL_MINT],
  );

  for (const row of result.rows) {
    const observedOutAtomic = getConfirmationTokenDeltaAtomic(row.confirmation, {
      mint: inventory.mint,
      owner: session.session_wallet,
    });
    const outAtomic = observedOutAtomic !== null && observedOutAtomic > 0
      ? observedOutAtomic
      : getExecutionAmountAtomic(row, 'outAmount');
    const outUi = toUiAmount(inventory.mint, outAtomic, inventory.tokenDecimals);
    if (!(outUi > 0)) continue;

    let inputUsd: number | null = null;
    if (row.input_mint === USDC_MINT) {
      inputUsd = getExecutionAmountAtomic(row, 'inAmount') / 1_000_000;
    } else if (row.input_mint === SOL_MINT) {
      const solUsd = lastPythSolSample?.usdPrice ?? lastJupiterSolSample?.usdPrice ?? null;
      const inLamports = getExecutionAmountAtomic(row, 'inAmount');
      inputUsd = solUsd && solUsd > 0 ? (inLamports / 1_000_000_000) * solUsd : null;
    }

    const metadata = asRecord(row.metadata);
    const entryPriceUsd = inputUsd && inputUsd > 0 ? inputUsd / outUi : null;
    if (entryPriceUsd && entryPriceUsd > 0) {
      return {
        entryPriceUsd,
        entryStrategy: parseExecutionStrategy(metadata?.entryStrategy ?? metadata?.scannerStrategy),
        entryAt: (row.confirmed_at ?? row.created_at)?.toISOString?.() ?? null,
      };
    }
  }

  return {
    entryPriceUsd: null,
    entryStrategy: null,
    entryAt: new Date().toISOString(),
  };
};

const reconcileWalletInventoryPositions = async (
  session: RawSession,
  owner: PublicKey,
  positionsState: SessionPositionsState,
): Promise<SessionPositionsState> => {
  if (!WORKER_INVENTORY_RECONCILE_ENABLED) return positionsState;

  const now = Date.now();
  const lastRunAt = lastInventoryReconcileAtBySession.get(session.id) ?? 0;
  if (now - lastRunAt < WORKER_INVENTORY_RECONCILE_MS) {
    return positionsState;
  }
  lastInventoryReconcileAtBySession.set(session.id, now);

  const inventory = await listWalletTokenInventory(owner);
  if (inventory.length === 0) return positionsState;

  const nextPositions = { ...positionsState.positions };
  const recovered: string[] = [];
  const quantitySynced: string[] = [];

  for (const holding of inventory) {
    const existing = nextPositions[holding.mint] ?? null;
    const markPriceUsd = latestJupiterUsdByMint.get(holding.mint) ?? existing?.lastMarkedPriceUsd ?? null;

    if (existing && isLongPositionStatus(existing.status)) {
      const trackedQuantityAtomic = Number(existing.quantityAtomic ?? 0);
      if (Number.isFinite(trackedQuantityAtomic) && trackedQuantityAtomic !== holding.balanceAtomic) {
        nextPositions[holding.mint] = {
          ...existing,
          quantityAtomic: String(holding.balanceAtomic),
          tokenDecimals: existing.tokenDecimals ?? holding.tokenDecimals,
          positionSymbol: existing.positionSymbol ?? holding.symbol,
          lastMarkedPriceUsd: markPriceUsd,
          lastMarkedAt: markPriceUsd ? new Date().toISOString() : existing.lastMarkedAt,
        };
        quantitySynced.push(`${holding.symbol}:${trackedQuantityAtomic}->${holding.balanceAtomic}`);
      }
      continue;
    }

    const basis = await findRecoveredEntryBasis(session, holding);
    nextPositions[holding.mint] = {
      status: holding.mint === SOL_MINT ? 'long_sol' : 'long',
      positionMint: holding.mint,
      positionSymbol: holding.symbol,
      entryStrategy: basis.entryStrategy,
      entryPriceUsd: basis.entryPriceUsd,
      entryAt: basis.entryAt,
      quantityAtomic: String(holding.balanceAtomic),
      tokenDecimals: holding.tokenDecimals,
      highWaterPriceUsd: markPriceUsd ?? basis.entryPriceUsd,
      lastMarkedPriceUsd: markPriceUsd ?? basis.entryPriceUsd,
      lastMarkedAt: markPriceUsd || basis.entryPriceUsd ? new Date().toISOString() : null,
      lastComputedAtrUsd: null,
      lastComputedAtrBps: null,
      atrComputedAt: null,
      maxFavorableBps: null,
      maxFavorableAt: null,
      maxAdverseBps: null,
      maxAdverseAt: null,
      entryQualityScore: null,
      entryQualityBand: null,
      pendingExitReason: basis.entryPriceUsd === null ? 'stop_loss' : null,
      exitReason: null,
      partialExitDone: false,
    };
    recovered.push(`${holding.symbol}:${holding.balanceAtomic}`);
  }

  if (recovered.length === 0 && quantitySynced.length === 0) {
    return positionsState;
  }

  const reconciled = await persistPositionsState(session, {
    activePositionMint: positionsState.activePositionMint && nextPositions[positionsState.activePositionMint]
      ? positionsState.activePositionMint
      : (Object.keys(nextPositions)[0] ?? null),
    positions: nextPositions,
  });

  log(
    'warn',
    session.id,
    `wallet inventory reconciled into positionsState recovered=[${recovered.join(',')}] quantitySynced=[${quantitySynced.join(',')}]`,
  );

  return reconciled;
};

'''

if 'const listWalletTokenInventory' not in text:
    replace_once(
        'const getSessionProfitHandling = (session: RawSession) => (',
        helpers + 'const getSessionProfitHandling = (session: RawSession) => (',
        'inventory reconciliation helpers',
    )

if 'await reconcileWalletInventoryPositions(session, keypair.publicKey, positionsState)' not in text:
    replace_once(
        '  let positionsState = await refreshPositionsMarks(session, getPositionsState(session));\n  let positionState = summarizePositionsState(positionsState, session.service_control.positionState ?? undefined);',
        "  let positionsState = getPositionsState(session);\n  positionsState = await reconcileWalletInventoryPositions(session, keypair.publicKey, positionsState).catch((err) => {\n    log('warn', session.id, `wallet inventory reconciliation skipped: ${String(err)}`);\n    return positionsState;\n  });\n  positionsState = await refreshPositionsMarks(session, positionsState);\n  let positionState = summarizePositionsState(positionsState, session.service_control.positionState ?? undefined);",
        'wire active loop',
    )

if 'positionState.pendingExitReason && (positionState.entryPriceUsd === null || markPriceUsd === null)' not in text:
    replace_once(
        '  const thresholds = computeDynamicExitThresholds(session, positionState, signalSnapshot);\n\n  if (pnlBps !== null && pnlBps >= thresholds.takeProfitBps) {',
        "  const thresholds = computeDynamicExitThresholds(session, positionState, signalSnapshot);\n\n  if (positionState.pendingExitReason && (positionState.entryPriceUsd === null || markPriceUsd === null)) {\n    return {\n      shouldExit: true,\n      reason: positionState.pendingExitReason,\n      markPriceUsd,\n      pnlBps,\n      trailingDrawdownBps,\n      thresholds,\n    };\n  }\n\n  if (pnlBps !== null && pnlBps >= thresholds.takeProfitBps) {",
        'pending unknown-basis exit trigger',
    )

path.write_text(text, encoding='utf-8')
print('inventory recovery patch applied to disk')
