'use client';

import { useMemo } from 'react';
import { clusterApiUrl } from '@solana/web3.js';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import {
  PhantomWalletAdapter,
  SolflareWalletAdapter,
  CoinbaseWalletAdapter,
  TrustWalletAdapter,
} from '@solana/wallet-adapter-wallets';
import { WalletError } from '@solana/wallet-adapter-base';
import '@solana/wallet-adapter-react-ui/styles.css';

const SOLANA_NETWORK = process.env.NEXT_PUBLIC_SOLANA_NETWORK === 'devnet'
  ? 'devnet'
  : process.env.NEXT_PUBLIC_SOLANA_NETWORK === 'testnet'
    ? 'testnet'
    : 'mainnet-beta';

const PUBLIC_RPC_ENDPOINT = process.env.NEXT_PUBLIC_SOLANA_RPC_URL
  ?? process.env.NEXT_PUBLIC_HELIUS_RPC_URL
  ?? clusterApiUrl(SOLANA_NETWORK);

export function RZWalletProvider({ children }: { children: React.ReactNode }) {
  const wallets = useMemo(
    () => [
      new PhantomWalletAdapter(),
      new SolflareWalletAdapter(),
      new CoinbaseWalletAdapter(),
      new TrustWalletAdapter(),
    ],
    []
  );

  const onError = (error: WalletError) => {
    console.error('Wallet error:', error);
  };

  return (
    <ConnectionProvider endpoint={PUBLIC_RPC_ENDPOINT}>
      <WalletProvider wallets={wallets} autoConnect onError={onError}>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
