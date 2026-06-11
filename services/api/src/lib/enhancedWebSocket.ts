import WebSocket from 'ws';

/**
 * Helius Enhanced WebSocket client.
 * Uses the atlas-mainnet endpoint for transactionSubscribe (Business+ plan).
 * Provides parsed transaction data in real-time notifications — no extra RPC call needed.
 */

type TransactionNotification = {
  signature: string;
  slot: number;
  err: unknown;
  transaction?: {
    meta?: {
      err: unknown;
      fee: number;
      preBalances: number[];
      postBalances: number[];
      preTokenBalances?: Array<{
        accountIndex: number;
        mint: string;
        uiTokenAmount: { uiAmount: number | null; decimals: number; amount: string; uiAmountString?: string };
        owner?: string;
      }>;
      postTokenBalances?: Array<{
        accountIndex: number;
        mint: string;
        uiTokenAmount: { uiAmount: number | null; decimals: number; amount: string; uiAmountString?: string };
        owner?: string;
      }>;
      computeUnitsConsumed?: number;
    };
  };
};

type SubscriptionCallback = (notification: TransactionNotification) => void;

export class EnhancedWebSocketClient {
  private ws: WebSocket | null = null;
  private apiKey: string;
  private url: string;
  private subscriptions = new Map<number, SubscriptionCallback>();
  private pendingSubscriptions = new Map<number, { resolve: (subId: number) => void; reject: (err: Error) => void; callback: SubscriptionCallback }>();
  private nextId = 1;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private connected = false;
  private closing = false;
  private logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };

  constructor(params: {
    apiKey: string;
    network?: 'mainnet' | 'devnet';
    logger?: EnhancedWebSocketClient['logger'];
  }) {
    this.apiKey = params.apiKey;
    const host = params.network === 'devnet' ? 'atlas-devnet.helius-rpc.com' : 'atlas-mainnet.helius-rpc.com';
    this.url = `wss://${host}/?api-key=${this.apiKey}`;
    this.logger = params.logger ?? console;
  }

  connect(): void {
    if (this.ws) return;
    this.closing = false;

    this.ws = new WebSocket(this.url);

    this.ws.on('open', () => {
      this.connected = true;
      this.logger.info('Enhanced WebSocket connected');

      // Ping every 30s to prevent 10-min inactivity timeout (per Helius docs)
      this.pingInterval = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.ping();
        }
      }, 30_000);

      // Re-subscribe any pending subscriptions from before reconnect
      for (const [id, pending] of this.pendingSubscriptions) {
        // These were waiting to be sent when we reconnected
        this.logger.info({ id }, 'enhanced WS: resending pending subscription');
      }
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const message = JSON.parse(data.toString());

        // Subscription response
        if (message.id && message.result !== undefined) {
          const pending = this.pendingSubscriptions.get(message.id);
          if (pending) {
            this.pendingSubscriptions.delete(message.id);
            this.subscriptions.set(message.result, pending.callback);
            pending.resolve(message.result);
          }
          return;
        }

        // Subscription error
        if (message.id && message.error) {
          const pending = this.pendingSubscriptions.get(message.id);
          if (pending) {
            this.pendingSubscriptions.delete(message.id);
            pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
          }
          return;
        }

        // Notification
        if (message.method === 'transactionNotification' && message.params) {
          const subId = message.params.subscription;
          const callback = this.subscriptions.get(subId);
          if (callback) {
            callback(message.params.result);
          }
        }
      } catch (err) {
        this.logger.warn({ err }, 'enhanced WS: failed to parse message');
      }
    });

    this.ws.on('close', () => {
      this.connected = false;
      if (this.pingInterval) {
        clearInterval(this.pingInterval);
        this.pingInterval = null;
      }

      if (!this.closing) {
        this.logger.warn('Enhanced WebSocket disconnected, reconnecting in 2s');
        this.ws = null;
        this.reconnectTimeout = setTimeout(() => this.connect(), 2_000);
      }
    });

    this.ws.on('error', (err) => {
      this.logger.error({ err }, 'Enhanced WebSocket error');
    });
  }

  /**
   * Subscribe to a specific transaction by signature using transactionSubscribe.
   * Returns the subscription ID for later unsubscription.
   */
  async transactionSubscribe(
    signature: string,
    callback: SubscriptionCallback,
    commitment: 'confirmed' | 'finalized' = 'confirmed',
  ): Promise<number> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Enhanced WebSocket is not connected');
    }

    const id = this.nextId++;

    return new Promise<number>((resolve, reject) => {
      this.pendingSubscriptions.set(id, { resolve, reject, callback });

      const message = JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'transactionSubscribe',
        params: [
          { signature },
          {
            commitment,
            encoding: 'jsonParsed',
            transactionDetails: 'full',
            showRewards: false,
            maxSupportedTransactionVersion: 0,
          },
        ],
      });

      this.ws!.send(message, (err) => {
        if (err) {
          this.pendingSubscriptions.delete(id);
          reject(err);
        }
      });
    });
  }

  /**
   * Unsubscribe from a transaction subscription.
   */
  unsubscribe(subscriptionId: number): void {
    this.subscriptions.delete(subscriptionId);

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: this.nextId++,
        method: 'transactionUnsubscribe',
        params: [subscriptionId],
      }));
    }
  }

  close(): void {
    this.closing = true;
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.subscriptions.clear();
    this.pendingSubscriptions.clear();
    this.connected = false;
  }

  get isConnected(): boolean {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }
}
