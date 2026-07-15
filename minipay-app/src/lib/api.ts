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

export interface ValidateUsernameResponse {
  success: boolean;
  valid: boolean;
  username?: string;
  firstName?: string | null;
  lastName?: string | null;
  photoUrl?: string | null;
  reason?: string;
}

// Deliberately doesn't throw on a 400/503 — "not found" and "retry later"
// are expected, ordinary outcomes here, not exceptional failures.
export async function validateUsername(username: string): Promise<ValidateUsernameResponse> {
  const res = await fetch('/api/minipay/validate-username', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
  });
  const data = await res.json().catch(() => ({}));
  return {
    success: !!data.success,
    valid: !!data.valid,
    username: data.username,
    firstName: data.firstName ?? null,
    lastName: data.lastName ?? null,
    photoUrl: data.photoUrl ?? null,
    reason: data.reason,
  };
}

export interface MiniPayOrderSummary {
  orderId: string;
  status: string;
  transactionVerified: boolean;
  fulfillmentStatus: 'none' | 'queued' | 'in_progress' | 'completed' | 'failed';
  fulfillmentError: string | null;
  stars: number | null;
  isPremium: boolean;
  premiumDuration: number | null;
  amountUsd: number;
  token: string;
  dateCreated: string;
}

export async function requestAuthNonce(address: string): Promise<string> {
  const res = await fetch('/api/minipay/auth/nonce', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address }),
  });
  const data = await parseOrThrow<{ message: string }>(res);
  return data.message;
}

export async function verifyAuthSignature(address: string, signature: string): Promise<string> {
  const res = await fetch('/api/minipay/auth/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, signature }),
  });
  const data = await parseOrThrow<{ token: string }>(res);
  return data.token;
}

export async function getMyOrders(token: string): Promise<MiniPayOrderSummary[]> {
  const res = await fetch('/api/minipay/orders', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await parseOrThrow<{ orders: MiniPayOrderSummary[] }>(res);
  return data.orders;
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
