// RESEARCH seat — server-side edition (ported from the frontend desk).
// Runs on kill-chain survivors. Server-side there is no CORS, so candidate
// websites are fetched DIRECTLY (r.jina.ai as fallback). The pump.fun API
// socials cache is checked FIRST — exact twitter/website, free.
// Output: score modifier clamped to [-10, +10]. NEVER kills. Fail-open.
// Budgets: 8s per fetch, 20s total per candidate.

import { fetchTokens } from './dexscreener.js';
import { pumpSocials } from './pumpfun.js';
import { calloutCheck } from './callouts.js';
import { floorEmit } from './events.js';
import { storage } from './storage.js';

const FETCH_MS = 8000;
const TOTAL_MS = 20000;
const SERIAL_LAUNCHES = 5;
const LEDGER_KEY = 'alphabot_creator_ledger_v1';
const LEDGER_MAX = 500;

const COPYCATS = new Set([
  'BONK', 'WIF', 'POPCAT', 'MEW', 'BOME', 'SLERF', 'PENGU', 'JUP', 'RAY',
  'PYTH', 'JTO', 'ORCA', 'GOAT', 'ACT', 'FWOG', 'MICHI', 'MUMU', 'NEIRO',
  'MOODENG', 'CHILLGUY', 'PNUT', 'FARTCOIN', 'TRUMP', 'MELANIA',
]);

const short = (a) => (a && a.length > 8 ? `${a.slice(0, 4)}…${a.slice(-4)}` : (a || '?'));
const withTimeout = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
  ]);

// ---------------------------------------------------------- creator ledger
function loadLedger() {
  try { return JSON.parse(storage.getItem(LEDGER_KEY)) || {}; }
  catch { return {}; }
}
function saveLedger(l) {
  try { storage.setItem(LEDGER_KEY, JSON.stringify(l)); }
  catch { /* nicety */ }
}
export function noteCreatorLaunch(creator, mint) {
  if (!creator) return null;
  const l = loadLedger();
  const e = l[creator] || { launches: 0, seen: {} };
  if (!e.seen[mint]) { e.seen[mint] = 1; e.launches += 1; }
  e.lastSeen = Date.now();
  l[creator] = e;
  const keys = Object.keys(l);
  if (keys.length > LEDGER_MAX) delete l[keys[0]];
  saveLedger(l);
  return e;
}
export function getCreatorLedger() { return loadLedger(); }

// ---------------------------------------------------------- sub-checks
async function linkCheck(t) {
  // 1) pump.fun API socials — exact, free (checked first).
  const ps = pumpSocials(t.address);
  if (ps && (ps.twitter || ps.website || ps.telegram)) {
    return {
      hasTwitter: !!ps.twitter, hasTelegram: !!ps.telegram,
      hasWebsite: !!ps.website, siteUrl: ps.website || null,
      source: 'pump-api',
    };
  }
  // 2) DexScreener pair info.
  const raw = await withTimeout(fetchTokens([t.address]), FETCH_MS);
  const pair = raw[t.address];
  if (!pair) throw new Error('no pair');
  const info = pair.info || {};
  const socials = info.socials || [];
  const websites = info.websites || [];
  const hasTwitter = socials.some(s =>
    /twitter/i.test(s.type || '') || /(twitter\.com|x\.com)/i.test(s.url || ''));
  const hasTelegram = socials.some(s =>
    /telegram/i.test(s.type || '') || /t\.me|telegram/i.test(s.url || ''));
  const hasWebsite = (websites || []).some(w =>
    w.url && !/dexscreener|birdeye|rugcheck|solscan/i.test(w.url));
  const siteUrl = (websites || []).map(w => w.url).find(u =>
    u && /^https?:\/\//i.test(u) && !/dexscreener|birdeye|rugcheck|solscan/i.test(u)) || null;
  return { hasTwitter, hasTelegram, hasWebsite, siteUrl, source: 'dexscreener' };
}

function metaCheck(t) {
  const sym = (t.symbol || '').toUpperCase();
  const name = t.name || '';
  const copycat = COPYCATS.has(sym);
  const sane = !copycat && sym.length >= 2 && sym.length <= 12 &&
    name.length >= 2 && name.length <= 48 && /^[A-Za-z0-9 $._-]+$/.test(sym);
  return { image: !!t.image, copycat, sane };
}

// ---------------------------------------------------------- site reader
const READ_MS = 10000;
const TRUST_KWS = ['audit', 'audited', 'liquidity lock', 'locked liquidity', 'whitepaper', 'docs', 'roadmap', 'team', 'github', 'open source'];
const RISK_KWS = ['guaranteed', '100x', '1000x', 'moon', 'elon', 'presale bonus', 'send sol', 'double your'];
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function scanKeywords(text) {
  const hits = [];
  const scan = (kw, kind) => {
    let m;
    try { m = text.match(new RegExp(`\\b${escRe(kw)}\\b`, 'gi')); }
    catch { return; }
    if (m && m.length) hits.push({ kw, kind, count: m.length });
  };
  TRUST_KWS.forEach(k => scan(k, 'trust'));
  RISK_KWS.forEach(k => scan(k, 'risk'));
  return hits;
}

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return url; }
}

// Server-side: fetch DIRECTLY (no CORS). Fall back to r.jina.ai on failure.
// Always resolves; null = skipped/failed (fail-open).
async function readPage(url) {
  const tryDirect = async () => {
    const r = await withTimeout(
      fetch(url, {
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; alphabot/1.0; research)' },
        redirect: 'follow',
      }).then(async (res) => {
        if (!res.ok) throw new Error('http_' + res.status);
        const ct = res.headers.get('content-type') || '';
        if (!/text|html|json/i.test(ct)) throw new Error('non-text');
        const txt = await res.text();
        return txt.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 6000);
      }),
      READ_MS
    );
    return r;
  };
  const tryProxy = async () => {
    const r = await withTimeout(
      fetch(`https://r.jina.ai/${url}`).then(async (res) => {
        if (!res.ok) throw new Error(`reader ${res.status}`);
        return res.text();
      }),
      READ_MS
    );
    return (r || '').split('\n').filter(l => l.trim()).slice(0, 40).join('\n').slice(0, 4000);
  };
  try { return await tryDirect(); }
  catch { try { return await tryProxy(); } catch { return null; } }
}

function keywordVerdict(text) {
  const hits = scanKeywords(text || '');
  const found = new Set(hits.map(h => h.kw));
  let delta = 0;
  const why = [];
  if (found.has('whitepaper') || found.has('docs')) { delta += 2; why.push('docs/whitepaper'); }
  if (found.has('audit')) { delta += 2; why.push('audit'); }
  const riskOcc = hits.filter(h => h.kind === 'risk').reduce((a, h) => a + h.count, 0);
  if (riskOcc >= 3) { delta -= 4; why.push(`${riskOcc} risk hits`); }
  return { delta, hits, verdict: delta !== 0 ? `${delta > 0 ? '+' : ''}${delta} · ${why.join(', ')}` : '+0 · clean read' };
}

// ---------------------------------------------------------- main entry
async function researchInner(t, dossier) {
  const deadline = Date.now() + TOTAL_MS;
  const bits = [];
  let modifier = 0;
  floorEmit('research.start', { mint: t.address, symbol: t.symbol, name: t.name });

  // (a) link discovery — pump.fun API socials first, then DexScreener.
  let links = null;
  let zeroLinks = false;
  if (Date.now() < deadline) {
    try {
      links = await linkCheck(t);
      const found = [];
      if (links.hasTwitter) { modifier += 2; found.push('twitter'); }
      if (links.hasTelegram) { modifier += 2; found.push('telegram'); }
      if (links.hasWebsite) { modifier += 2; found.push('site'); }
      zeroLinks = found.length === 0;
      bits.push(found.length ? `links: ${found.join('+')} (${links.source || 'ds'})` : 'links: none');
    } catch {
      bits.push('links: ?');
    }
  }

  // (a1) social hunt fallback: zero links → pump.fun coin page via reader.
  // Server-side the pump.fun API usually already gave us socials, so this
  // is rare. Keyword-scan the description when we get one.
  if (links && zeroLinks && Date.now() < deadline) {
    try {
      const ps = pumpSocials(t.address);
      if (ps && (ps.twitter || ps.website || ps.telegram)) {
        const found = [];
        if (ps.twitter) { modifier += 1; found.push(`possible X (unverified)`); }
        if (ps.telegram) { modifier += 1; found.push('possible tg (unverified)'); }
        if (ps.website) { modifier += 1; found.push('possible site (unverified)'); }
        bits.push(`hunt: ${found.join(' · ')}`);
      } else {
        bits.push('hunt: no socials found');
      }
    } catch { bits.push('hunt: ?'); }
  }

  // (a2) site read — direct fetch, keyword scan.
  if (links && links.siteUrl && Date.now() < deadline) {
    const text = await readPage(links.siteUrl);
    if (text) {
      const { delta, verdict } = keywordVerdict(text);
      modifier += delta;
      bits.push(`read: ${domainOf(links.siteUrl)}: ${verdict}`);
    }
  }

  // (b) creator ledger
  if (Date.now() < deadline) {
    try {
      const creator = t.creator || null;
      if (creator) {
        const e = noteCreatorLaunch(creator, t.address);
        if (e.launches > SERIAL_LAUNCHES) {
          modifier -= 4;
          bits.push(`creator: serial launcher (${e.launches} launches)`);
        } else if (e.launches > 1) {
          modifier += 2;
          bits.push(`creator: ${e.launches} launches, clean`);
        } else {
          bits.push('creator: first seen');
        }
      } else {
        bits.push('creator: ?');
      }
    } catch { bits.push('creator: ?'); }
  }

  // (c) metadata quality
  if (Date.now() < deadline) {
    const meta = metaCheck(t);
    if (meta.copycat) {
      modifier -= 4;
      bits.push('meta: copycat ticker?');
    } else {
      if (meta.image) modifier += 1;
      if (meta.sane) modifier += 1;
      bits.push(`meta: ${meta.image ? 'img' : 'no-img'}${meta.sane ? '' : ' · sketchy name'}`);
    }
  }

  // (d) callout detection
  let calloutLine = null;
  if (Date.now() < deadline) {
    try {
      const co = await calloutCheck(t);
      if (co.points > 0) {
        modifier += co.points;
        bits.push(co.line);
        calloutLine = co.calloutLine;
        floorEmit('callout.hit', {
          mint: t.address, symbol: t.symbol, name: t.name,
          channels: co.hits.map(h => h.channel), points: co.points,
        });
      } else {
        bits.push('callouts: none');
      }
    } catch { bits.push('callouts: ?'); }
  }

  modifier = Math.max(-10, Math.min(10, modifier));
  floorEmit('research.done', { mint: t.address, symbol: t.symbol, name: t.name, modifier, line: bits.join(' · ') });
  return { modifier, line: bits.join(' · '), checks: bits.length, calloutLine };
}

export async function researchToken(t, dossier) {
  try {
    return await withTimeout(researchInner(t, dossier), TOTAL_MS);
  } catch {
    floorEmit('research.done', { mint: t.address, symbol: t.symbol, name: t.name, modifier: 0, line: 'no data' });
    return { modifier: 0, line: 'no data', checks: 0, calloutLine: null };
  }
}
