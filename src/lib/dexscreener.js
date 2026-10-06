// DexScreener client — token discovery + metadata. No key.
// Ported from the frontend desk; identical behavior, no localStorage.

const BASE = 'https://api.dexscreener.com/tokens/v1/solana';
const API = 'https://api.dexscreener.com';

const tokenCache = new Map(); // mint -> { pair, ts }
const CACHE_TTL = 60000;

export async function fetchTokens(mints) {
  const out = {};
  const uniq = [...new Set(mints)].filter(Boolean);
  const now = Date.now();
  const fresh = [];
  for (const m of uniq) {
    const c = tokenCache.get(m);
    if (c && now - c.ts < CACHE_TTL && c.pair) { out[m] = c.pair; }
    else fresh.push(m);
  }
  for (let i = 0; i < fresh.length; i += 30) {
    const chunk = fresh.slice(i, i + 30);
    try {
      const r = await fetch(`${BASE}/${chunk.join(',')}`);
      if (!r.ok) continue;
      const pairs = await r.json();
      for (const p of pairs || []) {
        const m = p.baseToken && p.baseToken.address;
        if (!m) continue;
        const liq = (p.liquidity && p.liquidity.usd) || 0;
        if (!out[m] || liq > ((out[m].liquidity && out[m].liquidity.usd) || 0)) out[m] = p;
      }
    } catch { /* one chunk failing shouldn't kill the batch */ }
  }
  for (const m of fresh) {
    if (out[m]) tokenCache.set(m, { pair: out[m], ts: now });
  }
  return out;
}

let solCache = { price: null, ts: 0 };
export async function solPrice() {
  if (Date.now() - solCache.ts < 120000 && solCache.price) return solCache.price;
  try {
    const r = await fetch(`${BASE}/So11111111111111111111111111111111111111112`);
    const pairs = await r.json();
    const p = (pairs || [])[0];
    if (p && p.priceUsd) { solCache = { price: +p.priceUsd, ts: Date.now() }; return solCache.price; }
  } catch {}
  return solCache.price || 150;
}

export async function fetchLatestProfiles(limit = 60) {
  try {
    const r = await fetch(`${API}/token-profiles/latest/v1`);
    if (!r.ok) return [];
    const arr = await r.json();
    const out = [];
    for (const t of arr || []) {
      if (t.chainId === 'solana' && t.tokenAddress) {
        out.push({ address: t.tokenAddress, source: 'profiles' });
        if (out.length >= limit) break;
      }
    }
    return out;
  } catch { return []; }
}

export async function fetchLatestBoosts(limit = 60) {
  for (const path of ['/token-boosts/latest/v1', '/token-boosts/top/v1']) {
    try {
      const r = await fetch(`${API}${path}`);
      if (!r.ok) continue;
      const arr = await r.json();
      const out = [];
      for (const t of arr || []) {
        if (t.chainId === 'solana' && t.tokenAddress) {
          out.push({ address: t.tokenAddress, source: 'boosts' });
          if (out.length >= limit) break;
        }
      }
      if (out.length) return out;
    } catch { /* try next path */ }
  }
  return [];
}

export function tokenView(pair) {
  if (!pair) return null;
  const price = +(pair.priceUsd || 0) || null;
  const fdv = +(pair.fdv || 0) || null;
  const mc = +(pair.marketCap || 0) || fdv;
  const liq = pair.liquidity && pair.liquidity.usd != null ? +pair.liquidity.usd : null;
  const vol24h = pair.volume && pair.volume.h24 != null ? +pair.volume.h24 : null;
  const tx = pair.txns && pair.txns.h24 ? pair.txns.h24 : null;
  return {
    address: pair.baseToken.address,
    name: pair.baseToken.name || 'Unknown',
    symbol: pair.baseToken.symbol || '???',
    image: (pair.info && pair.info.imageUrl) || null,
    price, fdv: fdv || null, mc: mc || null,
    supply: price && fdv ? fdv / price : null,
    liquidity: liq,
    vol24h,
    buys24h: tx ? tx.buys : null,
    sells24h: tx ? tx.sells : null,
    createdAt: pair.pairCreatedAt || null,
    dex: pair.dexId || null,
    url: pair.url || null,
    priceChange: pair.priceChange || null,
  };
}
