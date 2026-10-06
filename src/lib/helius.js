// Helius client — server-side edition. Key comes from HELIUS_API_KEY env
// (never baked in, never logged). Powers the smart-flow watcher + richer
// on-chain reads. Dormant without a key — everything fail-open.

const BASE = 'https://api.helius.xyz';
const RPC = 'https://mainnet.helius-rpc.com/';
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT = 'Es9vMFrzaCERmJfrFYD4KCoNkY11McCe8BenwNYB';
export const STABLE_MINTS = new Set([USDC_MINT, USDT_MINT]);

export function getKey() {
  return (process.env.HELIUS_API_KEY || '').trim();
}

export async function fetchWalletTxns(address, key, limit = 40) {
  const url = `${BASE}/v0/addresses/${address}/transactions?api-key=${encodeURIComponent(key)}&limit=${limit}`;
  const r = await fetch(url);
  if (r.status === 401 || r.status === 403) throw new Error('bad_key');
  if (!r.ok) throw new Error('helius_' + r.status);
  return r.json();
}

export function parseSwaps(txns, wallet) {
  const buys = [], sells = [];
  for (const tx of txns || []) {
    if (tx.type !== 'SWAP') continue;
    const ts = (tx.timestamp || 0) * 1000;
    if (!ts) continue;
    const sig = tx.signature;
    const tIn = (tx.tokenTransfers || []).filter(t => t.toUserAccount === wallet && t.mint !== SOL_MINT && (t.tokenAmount || 0) > 0);
    const tOut = (tx.tokenTransfers || []).filter(t => t.fromUserAccount === wallet && (t.tokenAmount || 0) > 0);
    const solOut = (tx.nativeTransfers || []).filter(t => t.fromUserAccount === wallet).reduce((s, t) => s + (t.amount || 0), 0) / 1e9;
    if (!tIn.length) continue;
    const per = tIn.length;
    for (const t of tIn) {
      const usdcOut = tOut.find(x => x.mint === USDC_MINT);
      buys.push({
        mint: t.mint, ts, sig,
        tokensIn: t.tokenAmount,
        solSpent: solOut / per,
        usdcSpent: usdcOut ? usdcOut.tokenAmount / per : 0,
      });
    }
    for (const t of tOut) {
      if (t.mint === USDC_MINT || t.mint === SOL_MINT) continue;
      sells.push({ mint: t.mint, ts, sig, tokensOut: t.tokenAmount });
    }
  }
  return { buys, sells };
}

export async function rpcCall(key, method, params, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${RPC}?api-key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error('rpc_' + r.status);
    const j = await r.json();
    if (j.error) throw new Error('rpc_err');
    return j.result;
  } finally { clearTimeout(to); }
}

export async function fetchParsedTxn(key, sig, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${BASE}/v0/transactions?api-key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transactions: [sig] }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error('helius_' + r.status);
    return r.json();
  } finally { clearTimeout(to); }
}
