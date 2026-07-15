// Thin wrapper around the injected MiniPay/Celo wallet provider. Deliberately
// dependency-free (no viem/ethers) — MiniPay only needs a handful of raw
// JSON-RPC calls, so a small bundle beats pulling in a whole web3 SDK.

declare global {
  interface Window {
    ethereum?: {
      isMiniPay?: boolean;
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
    };
  }
}

export function isMiniPayAvailable(): boolean {
  return !!(window.ethereum && window.ethereum.isMiniPay);
}

export async function connectWallet(): Promise<string> {
  if (!window.ethereum) throw new Error('No wallet provider found');
  const accounts = (await window.ethereum.request({
    method: 'eth_requestAccounts',
    params: [],
  })) as string[];
  if (!accounts?.[0]) throw new Error('No account returned by wallet');
  return accounts[0];
}

/** Prompts the wallet to sign a plain-text message (personal_sign), used to
 * prove ownership of the address for account sign-in — never used for
 * anything that moves funds. */
export async function signMessage(address: string, message: string): Promise<string> {
  if (!window.ethereum) throw new Error('No wallet provider found');
  const signature = (await window.ethereum.request({
    method: 'personal_sign',
    params: [message, address],
  })) as string;
  return signature;
}

/** ERC-20 transfer(address,uint256) calldata, hand-encoded. */
function encodeTransferData(toAddress: string, amountUnits: string): string {
  const methodId = 'a9059cbb';
  const addr = toAddress.toLowerCase().replace('0x', '').padStart(64, '0');
  const amountHex = BigInt(amountUnits).toString(16).padStart(64, '0');
  return '0x' + methodId + addr + amountHex;
}

export async function sendStablecoinPayment(opts: {
  fromAddress: string;
  tokenAddress: string;
  tokenSymbol: string;
  toAddress: string;
  amountUnits: string;
}): Promise<string> {
  if (!window.ethereum) throw new Error('No wallet provider found');
  const txParams: Record<string, string> = {
    from: opts.fromAddress,
    to: opts.tokenAddress,
    data: encodeTransferData(opts.toAddress, opts.amountUnits),
  };
  // MiniPay's fee-abstraction (pay gas in the stablecoin itself) currently
  // only reliably supports cUSD as the fee currency.
  if (opts.tokenSymbol === 'cUSD') {
    txParams.feeCurrency = opts.tokenAddress;
  }
  const txHash = (await window.ethereum.request({
    method: 'eth_sendTransaction',
    params: [txParams],
  })) as string;
  return txHash;
}
