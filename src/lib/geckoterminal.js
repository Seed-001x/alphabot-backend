// GeckoTerminal new-pools feed — server-side edition.
// Polls GeckoTerminal's free new_pools endpoint for the freshest Solana pools
// across ALL launchpads (Meteora DBC, PumpSwap, Raydium, ...). This is the
// non-pump.fun discovery rail: AUTON/RARI/TWEETCRAFT launched on Meteora,
// invisible to the pump.fun firehose.
//
// Free tier: 30 calls/min — we do 2 calls/min. Fail-open everywhere.

const GT = 'https://api.geckoterminal.com/api/v2';
const POLL_MS = 30000;
const SEEN_TTL = 60 * 60 * 1000;
const SEEN_CAP = 2000;
const MAX_AGE_MIN = 30; // only pools created in the last 30 min

const seen = new Map(); // mint -> ts
const stats = { polls: 0, launches: 0, errors: 0, lastPollTs: 0, lastLaunchTs: 0 };
let state = 'idle';

export function newPoolsState() { return state; }
export function getNewPoolsStats() {
  return { state, ...stats };
}

function noteSeen(mint) {
  const now = Date.now();
  if (seen.has(mint)) return false;
  seen.set(mint, now);
  if (seen.size > SEEN_CAP) {
    const keys = [...seen.keys()];
    for (let i = 0; i < keys.length - SEEN_CAP; i++) seen.delete(keys[i]);
  }
  return true;
}

function pruneSeen() {
  const now = Date.now();
  for (const [k, ts] of seen) {
    if (now - ts > SEEN_TTL) seen.delete(k);
  }
}

async function fetchPage(page) {
  const u = `${GT}/networks/solana/new_pools?page=${page}&include=base_token`;
  const r = await fetch(u, { headers: { 'user-agent': 'alphabot-backend/1.0' } });
  if (!r.ok) throw new Error('gt_' + r.status);
  return r.json();
}

function parsePools(json) {
  const out = [];
  const included = {};
  for (const x of json.included || []) {
    if (x.type === 'token') {
      const a = x.attributes || {};
      included[x.id] = { symbol: a.symbol || '???', name: a.name || 'Unknown' };
    }
  }
  for (const p of json.data || []) {
    try {
      const a = p.attributes || {};
      const rel = p.relationships || {};
      const baseId = rel.base_token && rel.base_token.data && rel.base_token.data.id;
      if (!baseId || !baseId.startsWith('solana_')) continue;
      const mint = baseId.slice(7);
      const createdAt = a.pool_created_at ? Date.parse(a.pool_created_at) : null;
      const ageMin = createdAt ? (Date.now() - createdAt) / 60000 : 999;
      if (!(ageMin <= MAX_AGE_MIN)) continue;
      const tok = included[baseId] || {};
      const dex = rel.dex && rel.dex.data && rel.dex.data.id;
      const price = a.base_token_price_usd ? Number(a.base_token_price_usd) : null;
      const fdv = a.fdv_usd ? Number(a.fdv_usd) : null;
      const mc = a.market_cap_usd ? Number(a.market_cap_usd) : null;
      out.push({
        mint,
        pool: a.address || null,
        symbol: tok.symbol || '???',
        name: tok.name || 'Unknown',
        dex: dex || null,
        price: price > 0 ? price : null,
        mc: (mc > 0 ? mc : null) || (fdv > 0 ? fdv : null),
        createdAt,
        ageMin: Math.round(ageMin * 10) / 10,
        source: 'geckoterminal',
      });
    } catch { /* one bad pool is fine */ }
  }
  return out;
}

export function startNewPoolsWatch(onLaunch) {
  console.log('[newpools] polling GeckoTerminal for fresh Solana pools (30s)');
  let alive = true;
  state = 'live';

  async function pollOnce() {
    if (!alive) return;
    try {
      pruneSeen();
      // Two pages ≈ 40 newest pools — covers bursts.
      const [j1, j2] = await Promise.all([fetchPage(1), fetchPage(2)]);
      const pools = [...parsePools(j1), ...parsePools(j2)];
      stats.polls++;
      stats.lastPollTs = Date.now();
      let fresh = 0;
      for (const pl of pools) {
        if (!pl.mint || !noteSeen(pl.mint)) continue;
        if (!(pl.price > 0) || !(pl.mc > 0)) continue;
        fresh++;
        stats.launches++;
        stats.lastLaunchTs = Date.now();
        try { onLaunch && onLaunch(pl); } catch { /* callback is nicety */ }
      }
      if (fresh > 0) console.log(`[newpools] +${fresh} fresh pools`);
    } catch (e) {
      stats.errors++;
    }
  }

  pollOnce();
  const timer = setInterval(pollOnce, POLL_MS);
  return {
    stop() { alive = false; clearInterval(timer); state = 'idle'; },
    active: true,
  };
}
