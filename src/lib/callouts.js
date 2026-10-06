// CALLOUT DETECTION — server-side edition (ported from the frontend desk).
// Public Telegram callout channels via t.me/s previews. Server-side the
// previews are fetched directly first, then via r.jina.ai as fallback.
// Channels verified live 2026-10-06. Fail-open everywhere.
// Signal: +3 per distinct channel, max +6, marked "callout mention
// (unverified)". Never kills, never gates — additive only.

export const CALLOUT_CHANNELS = ['repotrenches', 'solanacallspumps'];

const FETCH_MS = 10000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const STAGGER_MS = 800;
const MAX_POINTS = 6;
const PTS_PER_CHANNEL = 3;

let cache = null;
let inflight = null;

async function fetchChannel(name) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), FETCH_MS);
  const get = async (url) => {
    const r = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; alphabot/1.0)' },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error('http_' + r.status);
    const text = await r.text();
    if (!text || text.length < 1500) throw new Error('thin');
    return text;
  };
  try {
    let text = null;
    try { text = await get(`https://t.me/s/${name}`); }
    catch { text = await get(`https://r.jina.ai/https://t.me/s/${name}`); }
    return { name, text, fetchedAt: Date.now() };
  } catch {
    return null;
  } finally {
    clearTimeout(to);
  }
}

export function getCalloutCache() {
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) {
    return Promise.resolve(cache.channels);
  }
  if (inflight) return inflight;
  inflight = (async () => {
    const channels = {};
    for (const name of CALLOUT_CHANNELS.slice(0, 5)) {
      const c = await fetchChannel(name);
      if (c) channels[name] = c;
      await new Promise(r => setTimeout(r, STAGGER_MS));
    }
    cache = { ts: Date.now(), channels };
    inflight = null;
    return channels;
  })();
  return inflight;
}

export function warmCalloutCache() {
  try { getCalloutCache().catch(() => {}); } catch { /* noop */ }
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function matchCallouts(t, channels) {
  const hits = [];
  const sym = (t.symbol || '').trim();
  const mint8 = (t.address || '').slice(0, 8);
  for (const [name, ch] of Object.entries(channels || {})) {
    const text = ch.text || '';
    let hit = false;
    if (mint8.length >= 8 && text.includes(mint8)) hit = true;
    if (!hit && sym) {
      const re = sym.length >= 3
        ? new RegExp(`\\b${escRe(sym)}\\b`, 'i')
        : new RegExp(`\\$${escRe(sym)}\\b`, 'i');
      if (re.test(text)) hit = true;
    }
    if (hit) hits.push({ channel: name, at: ch.fetchedAt || Date.now() });
  }
  return hits;
}

export async function calloutCheck(t) {
  const none = { points: 0, hits: [], line: null, calloutLine: null };
  try {
    const channels = await getCalloutCache();
    const hits = matchCallouts(t, channels);
    if (!hits.length) return none;
    const points = Math.min(MAX_POINTS, hits.length * PTS_PER_CHANNEL);
    const names = hits.map(h => h.channel).join(', ');
    const newest = Math.max(...hits.map(h => h.at));
    return {
      points,
      hits,
      line: `callouts +${points} — mentioned in ${hits.length} channel${hits.length > 1 ? 's' : ''} (${names}) · unverified`,
      calloutLine: `mentioned in ${names} · preview ${fmtAgoShort(newest)} · callout mention (unverified)`,
    };
  } catch {
    return none;
  }
}

function fmtAgoShort(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
