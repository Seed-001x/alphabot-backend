// v3.21: Wallet trade history auto-pull via Helius.
// Fetches a wallet's swap history and groups into per-token trades
// for the Learning Room style analyzer.

import { getKey } from './helius.js';

const HELIUS_ENHANCED = 'https://api.helius.xyz/v0/addresses';

// Fetch parsed swap transactions for a wallet (paginated).
export async function fetchWalletSwaps(wallet, limit = 100) {
  const key = getKey();
  if (!key) throw new Error('no HELIUS_API_KEY');
  if (!wallet) throw new Error('no wallet');

  const out = [];
  let before = null;
  let pages = 0;

  while (out.length < limit && pages < 12) {
    pages++;
    const params = new URLSearchParams({
      'api-key': key,
      limit: Math.min(100, limit - out.length).toString(),
      type: 'SWAP',
    });
    if (before) params.set('before', before);

    const r = await fetch(`${HELIUS_ENHANCED}/${wallet}/transactions?${params}`, {
      headers: { 'accept': 'application/json' },
    });
    if (!r.ok) throw new Error(`helius_${r.status}`);
    const txns = await r.json();
    if (!txns || !txns.length) break;

    out.push(...txns);
    before = txns[txns.length - 1].signature;
    if (txns.length < 100) break; // last page
  }

  return out;
}

// Group swaps by token mint into trade structures for analyzeStyle().
// Each trade: { symbol, buys: [{amount, mcap, ts}], sells: [...], pnl, pnlPct }
export async function buildTradeHistory(wallet, maxTxns = 200) {
  const txns = await fetchWalletSwaps(wallet, maxTxns);
  const byMint = new Map();

  for (const tx of txns) {
    const ts = (tx.timestamp || 0) * 1000;
    if (!ts) continue;

    // Token in (buy): wallet received tokens
    for (const t of (tx.tokenTransfers || [])) {
      if (t.toUserAccount !== wallet) continue;
      if (!t.mint || t.mint === 'So11111111111111111111111111111111111111112') continue;
      const amt = t.tokenAmount || 0;
      if (!(amt > 0)) continue;

      if (!byMint.has(t.mint)) {
        byMint.set(t.mint, {
          mint: t.mint,
          symbol: t.mint.slice(0, 8), // resolved later if possible
          buys: [], sells: [],
        });
      }
      const entry = byMint.get(t.mint);

      // Estimate USD spent: SOL out + USDC out
      const solOut = (tx.nativeTransfers || [])
        .filter(x => x.fromUserAccount === wallet)
        .reduce((s, x) => s + (x.amount || 0), 0) / 1e9;
      // Rough USD: use SOL price ~$120 if needed, or 0
      const usdSpent = solOut * 120; // approx

      entry.buys.push({ amount: usdSpent, tokens: amt, ts, mcap: 0 });
    }

    // Token out (sell): wallet sent tokens
    for (const t of (tx.tokenTransfers || [])) {
      if (t.fromUserAccount !== wallet) continue;
      if (!t.mint || t.mint === 'So11111111111111111111111111111111111111112') continue;
      const amt = t.tokenAmount || 0;
      if (!(amt > 0)) continue;

      if (!byMint.has(t.mint)) {
        byMint.set(t.mint, { mint: t.mint, symbol: t.mint.slice(0, 8), buys: [], sells: [] });
      }
      const entry = byMint.get(t.mint);

      const solIn = (tx.nativeTransfers || [])
        .filter(x => x.toUserAccount === wallet)
        .reduce((s, x) => s + (x.amount || 0), 0) / 1e9;
      const usdReceived = solIn * 120;

      entry.sells.push({ amount: usdReceived, tokens: amt, ts, mcap: 0 });
    }
  }

  // Calculate P&L per token and resolve symbols via DexScreener (batch)
  const trades = [];
  const mints = [...byMint.keys()];
  
  // Try to resolve symbols (best effort, batch)
  const symbols = {};
  try {
    if (mints.length) {
      const chunks = [];
      for (let i = 0; i < mints.length; i += 30) chunks.push(mints.slice(i, i + 30));
      for (const chunk of chunks) {
        const r = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${chunk.join(',')}`);
        if (r.ok) {
          const data = await r.json();
          for (const p of data) {
            if (p.baseToken) symbols[p.baseToken.address] = p.baseToken.symbol;
          }
        }
      }
    }
  } catch {}

  for (const [mint, t] of byMint) {
    if (!t.buys.length && !t.sells.length) continue;
    const buyTotal = t.buys.reduce((s, b) => s + (b.amount || 0), 0);
    const sellTotal = t.sells.reduce((s, x) => s + (x.amount || 0), 0);
    const pnl = sellTotal - buyTotal;
    const pnlPct = buyTotal > 0 ? (pnl / buyTotal) * 100 : 0;

    trades.push({
      symbol: symbols[mint] || t.symbol,
      mint,
      buys: t.buys.map(b => ({ amount: Math.round(b.amount * 100) / 100, ts: b.ts })),
      sells: t.sells.map(s => ({ amount: Math.round(s.amount * 100) / 100, ts: s.ts })),
      pnl: Math.round(pnl * 100) / 100,
      pnlPct: Math.round(pnlPct * 10) / 10,
    });
  }

  // Sort by absolute P&L (most significant first)
  trades.sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));
  return trades;
}
