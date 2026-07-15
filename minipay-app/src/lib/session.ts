const TOKEN_KEY = 'starstore_minipay_session_token';
const ADDRESS_KEY = 'starstore_minipay_session_address';

export interface MiniPaySession {
  token: string;
  address: string;
}

export function getMySession(): MiniPaySession | null {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    const address = localStorage.getItem(ADDRESS_KEY);
    if (!token || !address) return null;
    return { token, address };
  } catch {
    return null;
  }
}

export function saveSession(token: string, address: string) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(ADDRESS_KEY, address.toLowerCase());
  } catch {
    // private browsing / storage disabled — session just won't persist
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(ADDRESS_KEY);
  } catch {
    // ignore
  }
}
