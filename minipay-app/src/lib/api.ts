export type TokenSymbol = 'cUSD' | 'USDC' | 'USDT';

export interface CreateOrderRequest {
  username: string;
  stars?: number;
  isPremium?: boolean;
  premiumDuration?: number;
  token: TokenSymbol;
}

export interface CreateOrderResponse {
  success: boolean;
  orderId: string;
  recipientWallet: string;
  tokenSymbol: TokenSymbol;
  tokenAddress: string;
  tokenDecimals: number;
  amountUsd: number;
  amountUnits: string;
  chainId: number;
  error?: string;
}

export interface OrderStatusResponse {
  success: boolean;
  orderId: string;
  status: string;
  transactionVerified: boolean;
  fulfillmentStatus: 'none' | 'queued' | 'in_progress' | 'completed' | 'failed';
  fulfillmentError: string | null;
  stars: number | null;
  isPremium: boolean;
  premiumDuration: number | null;
  error?: string;
}

async function parseOrThrow<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.success === false) {
    throw new Error(data?.error || `Request failed (${res.status})`);
  }
  return data as T;
}

export async function createOrder(req: CreateOrderRequest): Promise<CreateOrderResponse> {
  const res = await fetch('/api/minipay/create-order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  return parseOrThrow<CreateOrderResponse>(res);
}

export async function submitTx(orderId: string, txHash: string, senderAddress: string): Promise<void> {
  const res = await fetch('/api/minipay/submit-tx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId, txHash, senderAddress }),
  });
  await parseOrThrow(res);
}

export async function getOrderStatus(orderId: string): Promise<OrderStatusResponse> {
  const res = await fetch(`/api/minipay/status/${encodeURIComponent(orderId)}`);
  return parseOrThrow<OrderStatusResponse>(res);
}
