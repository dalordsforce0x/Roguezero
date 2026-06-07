export const atomicToUiAmount = (quantityAtomic: number, decimals: number): number => {
  if (!Number.isFinite(quantityAtomic) || quantityAtomic <= 0 || !Number.isInteger(decimals) || decimals < 0) {
    return 0;
  }

  return quantityAtomic / (10 ** decimals);
};

export const computeSolInputEntryPriceUsd = (params: {
  spentLamports: number;
  outputAtomic: number;
  outputDecimals: number;
  solUsdPrice: number;
}): number | null => {
  const solSpent = atomicToUiAmount(params.spentLamports, 9);
  const outputUiAmount = atomicToUiAmount(params.outputAtomic, params.outputDecimals);

  if (solSpent <= 0 || outputUiAmount <= 0 || !Number.isFinite(params.solUsdPrice) || params.solUsdPrice <= 0) {
    return null;
  }

  return (solSpent * params.solUsdPrice) / outputUiAmount;
};

export const computeTokenToSolRealizedPnlUsd = (params: {
  receivedLamports: number;
  soldAtomic: number;
  soldDecimals: number;
  entryPriceUsd: number;
  solUsdPrice: number;
}): number | null => {
  const solReceived = atomicToUiAmount(params.receivedLamports, 9);
  const quantityUi = atomicToUiAmount(params.soldAtomic, params.soldDecimals);

  if (
    solReceived <= 0
    || quantityUi <= 0
    || !Number.isFinite(params.entryPriceUsd)
    || params.entryPriceUsd < 0
    || !Number.isFinite(params.solUsdPrice)
    || params.solUsdPrice <= 0
  ) {
    return null;
  }

  return solReceived * params.solUsdPrice - quantityUi * params.entryPriceUsd;
};

export const computeTokenToUsdcRealizedPnlUsd = (params: {
  receivedUsdcAtomic: number;
  soldAtomic: number;
  soldDecimals: number;
  entryPriceUsd: number;
}): number | null => {
  const usdcReceived = atomicToUiAmount(params.receivedUsdcAtomic, 6);
  const quantityUi = atomicToUiAmount(params.soldAtomic, params.soldDecimals);

  if (
    usdcReceived <= 0
    || quantityUi <= 0
    || !Number.isFinite(params.entryPriceUsd)
    || params.entryPriceUsd < 0
  ) {
    return null;
  }

  return usdcReceived - quantityUi * params.entryPriceUsd;
};
