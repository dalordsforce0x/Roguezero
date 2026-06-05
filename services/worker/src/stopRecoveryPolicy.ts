export type WalletSweepSnapshot = {
  solBalance: number;
  tokenProgramAccounts: string[];
  token2022Accounts: string[];
};

export const getResidualTokenAccounts = (snapshot: WalletSweepSnapshot): string[] => [
  ...snapshot.tokenProgramAccounts,
  ...snapshot.token2022Accounts,
];

export const hasResidualWalletState = (snapshot: WalletSweepSnapshot): boolean =>
  snapshot.solBalance > 0
  || snapshot.tokenProgramAccounts.length > 0
  || snapshot.token2022Accounts.length > 0;

export const isBrickedResidualWallet = (
  snapshot: WalletSweepSnapshot,
  txFeeLamports: number,
): boolean => snapshot.solBalance < txFeeLamports && getResidualTokenAccounts(snapshot).length > 0;

export const computeSessionSolSweepLamports = ({
  solBalance,
  ownerAtaCreationCost,
  txFeeLamports,
  mayLeaveResidualState,
}: {
  solBalance: number;
  ownerAtaCreationCost: number;
  txFeeLamports: number;
  mayLeaveResidualState: boolean;
}): number => {
  if (mayLeaveResidualState) {
    return 0;
  }

  return Math.max(0, solBalance - ownerAtaCreationCost - txFeeLamports);
};
