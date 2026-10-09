// jupTrending.js (v3.46) — volume-ranked "trending" rail across ALL Solana pools.
//
// Why: the terminal's Trending tab is ranked by recent volume/txns and is mostly
// coins that are hours to weeks old ($80K–$3M MC, 6h–1mo). The bot's old
// "trending" set was pump.fun /coins sorted by market cap (top 60 → multi-million
// caps only) plus DexScreener profiles/boosts (paid promotion), so mid-cap
// runners were never in it.
//
// Source: Jupiter Tokens API v2 ranked lists. The bot already depends on Jupiter
// for execution (realexec.js). NOTE: written from the documented API shape and
// NOT live-verified from the build environment — it is strictly fail-open
// (any error / unexpected shape → []), and tolerant of field-name variants.
// Check `GET /api/state` → feeds.trending after deploy to confirm it populates.

const BASE = process.env.JUP_TOKENS_BASE || 'https://lite-api.jup.ag/tokens/v2';
const TTL_MS = 20 * 1000;
let cache = { ts: 0, rows: [] };

async function getList(path) {
  try {
    const r = await fetch(`${BASE}/${path}`, {
      headers: { accept: 'application/json', 'user-agent': 'alphabot-backend/1.0' },
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return [];
    const j = await r.json();
    const arr = Array.isArray(j) ? j : (j && (j.data || j.tokens)) || [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function norm(t, source) {
  const mint = t && (t.id || t.address || t.mint);
  if (!mint || typeof mint !== 'string') return null;
  const s1h = t.stats1h || {};
  const vol = (Number(s1h.buyVolume) || 0) + (Number(s1h.sellVolume) || 0);
  return {
    address: mint,
    symbol: t.symbol || '???',
    name: t.name || 'Unknown',
    usdMc: Number(t.mcap || t.fdv) || null,
    liquidity: Number(t.liquidity) || null,
    volH1: vol || null,
    source,
  };
}

/** Top trending + top traded (1h), de-duplicated, trending first. */
export async function fetchJupTrending(limit = 80) {
  if (Date.now() - cache.ts < TTL_MS) return cache.rows.slice(0, limit);
  const [trending, traded] = await Promise.all([
    getList(`toptrending/1h?limit=${limit}`),
    getList(`toptraded/1h?limit=${limit}`),
  ]);
  const seen = new Set();
  const rows = [];
  for (const [list, src] of [[trending, 'jup-trending'], [traded, 'jup-traded']]) {
    for (const t of list) {
      const n = norm(t, src);
      if (!n || seen.has(n.address)) continue;
      seen.add(n.address);
      rows.push(n);
    }
  }
  cache = { ts: Date.now(), rows };
  return rows.slice(0, limit);
}
