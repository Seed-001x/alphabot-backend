// ALPHABOT backend pipeline: SCAN → VET (kill chain, ascending cost) → SCORE.
// Ported from the frontend desk. Server-side, SCAN gains first-class
// pump.fun API sources (no CORS): /coins sorted by created_timestamp (NEW)
// and market_cap (TRENDING), plus the existing RugCheck firehose and
// DexScreener profiles/boosts. "Code fetches, the model judges, code decides."

import { fetchTokens, fetchLatestProfiles, fetchLatestBoosts, tokenView } from './dexscreener.js';
import {
  fetchFreshPumpCoins, fetchPumpLatest, fetchPumpTop, fetchRugReport,
  curveProgress, isOnCurve, PUMP_SUFFIX,
} from './pumpfun.js';
import { buildFeeds, momentumScore } from './feeds.js';
import { getAdaptiveWeights } from './learning.js';
import { getPumpPortalMints, probePumpPortal } from './pumpportal.js';
import { STABLE_MINTS } from './helius.js';
import { fmtUsd } from './fmt.js';
import { floorEmit } from './events.js';

export const SCORE_WEIGHTS = { liquidity: 15, holders: 25, buyPressure: 30, curve: 15, age: 15, momentum: 10 };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const logScale = (v, lo, hi) => {
  if (!(v > 0)) return 0;
  const l = Math.log10(Math.max(v, 1));
  return clamp(((l - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))) * 100, 0, 100);
};

const isPumpOrigin = (address, pair) =>
  (address && address.endsWith(PUMP_SUFFIX)) || isOnCurve(pair);

// ---------------------------------------------------------- SCAN
export async function scanTokens() {
  probePumpPortal();
  const [pumpLatest, pumpTop, fresh, profiles, boosts] = await Promise.all([
    fetchPumpLatest(40),
    fetchPumpTop(40),
    fetchFreshPumpCoins(40),
    fetchLatestProfiles(60),
    fetchLatestBoosts(60),
  ]);
  const meta = new Map();
  for (const f of [...pumpLatest, ...fresh]) meta.set(f.address, f);
  for (const f of pumpTop) if (!meta.has(f.address)) meta.set(f.address, f);
  let ppMints = [];
  try { ppMints = getPumpPortalMints(); } catch { ppMints = []; }
  for (const m of ppMints) {
    if (m.mint && !meta.has(m.mint)) {
      meta.set(m.mint, { source: 'pumpportal', creator: m.creator || null, createdAt: m.ts });
    }
  }
  const addrs = [...meta.keys()];
  for (const s of [...profiles, ...boosts]) {
    if (s.address && !meta.has(s.address)) { meta.set(s.address, { source: s.source }); addrs.push(s.address); }
  }
  const batch = addrs.slice(0, 120);
  if (!batch.length) return { candidates: [], discovered: 0 };

  const raw = await fetchTokens(batch);
  const enriched = new Map();
  for (const a of batch) {
    const pair = raw[a];
    if (!pair) continue;
    const t = tokenView(pair);
    if (t) enriched.set(a, { ...t, chainId: pair.chainId || null });
  }
  // NEW = pump.fun API latest + firehose + PumpPortal; TRENDING = pump.fun
  // API top + DexScreener boosts/profiles; MOVERS = local momentum.
  const { tags, movers, rows } = buildFeeds({
    fresh, pumpLatest, pumpTop, profiles, boosts, enriched,
    ppMints: ppMints.map(m => m.mint).filter(Boolean),
  });
  try { floorEmit('feeds.ready', rows); } catch { /* fail-open */ }
  const candidates = [];
  for (const a of batch) {
    const pair = raw[a];
    const tagList = tags.get(a) || [];
    const fromFeed = tagList.includes('trending') || tagList.includes('movers');
    const chainOk = !pair || !pair.chainId || pair.chainId === 'solana';
    if (!isPumpOrigin(a, pair) && !(fromFeed && chainOk)) continue;
    if (STABLE_MINTS.has(a)) continue;
    const t = enriched.get(a);
    if (!t || !t.price || !t.mc) continue;
    const m = meta.get(a) || {};
    const graduated = !isOnCurve(pair);
    const turnover = t.vol24h && t.mc ? t.vol24h / t.mc : 0;
    const mv = movers.get(a);
    candidates.push({
      ...t,
      source: m.source || 'pump',
      creator: m.creator || t.creator || null,
      mintAuthOpen: m.mintAuthOpen != null ? m.mintAuthOpen : null,
      freezeAuthOpen: m.freezeAuthOpen != null ? m.freezeAuthOpen : null,
      createdAt: m.createdAt || t.createdAt,
      graduated,
      curvePct: graduated ? 100 : curveProgress(t.mc),
      feeds: tagList,
      trendScore: tagList.includes('trending')
        ? (t.vol24h || 0) * ((t.buys24h || 0) + (t.sells24h || 0)) : null,
      moverPct: mv ? mv.moverPct : null,
      volAccel: mv ? mv.volAccel : null,
      turnover,
    });
  }
  candidates.sort((a, b) => b.turnover - a.turnover);
  return { candidates, discovered: batch.length, feedRows: rows };
}

// ---------------------------------------------------------- VET (unchanged logic)
export function freeKill(t, cfg) {
  const ageMs = t.createdAt ? Date.now() - t.createdAt : null;
  if (ageMs == null) return 'age unknown';
  // No minimum age: the $20k MC floor is the newness filter. Newborns are
  // vetted on merit, never killed for being young.
  if (cfg.minAgeMin > 0 && ageMs < cfg.minAgeMin * 60000) return `age ${Math.max(1, Math.round(ageMs / 60000))}m < ${cfg.minAgeMin}m floor`;
  const maxAgeMs = t.graduated ? cfg.maxAgeDays * 864e5 : cfg.maxPumpAgeHrs * 3600000;
  if (ageMs > maxAgeMs) return t.graduated
    ? `age ${(ageMs / 864e5).toFixed(1)}d > ${cfg.maxAgeDays}d max`
    : `age ${(ageMs / 3600000).toFixed(1)}h > ${cfg.maxPumpAgeHrs}h pump max`;
  if (t.mintAuthOpen === true) return 'mint authority OPEN · dev can mint';
  if (t.freezeAuthOpen === true) return 'freeze authority OPEN · dev can freeze';
  const liq = t.liquidity || 0;
  // On-curve pump.fun coins report $0 DEX liquidity — the bonding curve IS
  // their liquidity (always sellable into the curve). Gate those on volume
  // instead; keep the LP floor for graduated coins with real DEX pools.
  if (t.graduated && !(liq >= cfg.minLiquidityUsd)) return `liq ${fmtUsd(liq)} < ${fmtUsd(cfg.minLiquidityUsd)} floor`;
  const vol = t.vol24h || 0;
  if (!(vol >= cfg.minVol24hUsd)) return `vol24h ${fmtUsd(vol)} < ${fmtUsd(cfg.minVol24hUsd)} floor`;
  const mc = t.mc || 0;
  const lo = t.graduated ? cfg.minMc : cfg.pumpMinMc;
  const hi = t.graduated ? cfg.maxMc : cfg.pumpMaxMc;
  if (mc < lo) return `MC ${fmtUsd(mc)} < ${fmtUsd(lo)} floor`;
  if (mc > hi) return `MC ${fmtUsd(mc)} > ${fmtUsd(hi)} cap`;
  return null;
}

export function tradeKill(t, cfg) {
  const buys = t.buys24h, sells = t.sells24h;
  // v3.10 parity: unknown trade counts flow to scoring (buyPressure goes
  // null and renormalizes out) instead of killing.
  if (buys == null || sells == null) return null;
  if (!(buys >= cfg.minBuys24h)) return `buys24h ${buys} < ${cfg.minBuys24h} floor`;
  if (cfg.requireSells && !(sells > 0)) return 'sells24h = 0 · no exit evidence';
  return null;
}

export async function rugKill(t, cfg) {
  const dossier = await fetchRugReport(t.address);
  // v3.10 parity: no dossier → flows to scoring (all dossier reads are
  // null-safe) instead of killing. Holder-count floor dropped — concentration
  // is punished in the score's holders component.
  if (!dossier) return { reason: null, dossier: null };
  if (dossier.rugged) return { reason: 'RugCheck flags RUGGED', dossier };
  if (dossier.devPct != null && dossier.devPct > cfg.maxDevPct)
    return { reason: `dev holds ${dossier.devPct.toFixed(1)}% > ${cfg.maxDevPct}% cap`, dossier };
  if (dossier.topPct != null && dossier.topPct > cfg.maxTopHolderPct)
    return { reason: `top holder ${dossier.topPct.toFixed(1)}% > ${cfg.maxTopHolderPct}% cap`, dossier };
  if (dossier.top10Pct != null && dossier.top10Pct > cfg.maxTop10Pct)
    return { reason: `top-10 ${dossier.top10Pct.toFixed(1)}% > ${cfg.maxTop10Pct}% cap`, dossier };
  return { reason: null, dossier };
}

// ---------------------------------------------------------- SCORE
// Heat triage — how "alive" a candidate is right now, from data already in
// hand (no API calls). Drives research-queue order: hot coins get the
// expensive research first, cold ones wait at the back.
export function heatOf(t) {
  let h = 0;
  const turnover = (t.vol24h && t.mc) ? t.vol24h / t.mc : 0;
  h += Math.min(turnover * 10, 30);
  if (t.buys24h != null && t.sells24h != null && t.buys24h + t.sells24h > 0) {
    h += (t.buys24h / (t.buys24h + t.sells24h)) * 30;
  }
  if (t.mc < 200000 && turnover >= 1) h += 20;   // low-MC high-turnover = hot
  return h;
}

export function scoreToken(t, dossier, cfg) {
  const ageH = t.createdAt ? (Date.now() - t.createdAt) / 3600000 : null;
  const liquidity = logScale(t.liquidity, cfg.minLiquidityUsd, 1e6);
  let holders = null;
  if (dossier && (dossier.topPct != null || dossier.top10Pct != null || dossier.devPct != null)) {
    const topS = dossier.topPct != null ? clamp(100 - (dossier.topPct / cfg.maxTopHolderPct) * 100, 0, 100) : null;
    const devS = dossier.devPct != null ? clamp(100 - (dossier.devPct / cfg.maxDevPct) * 100, 0, 100) : null;
    const parts = [topS, devS].filter(v => v != null);
    holders = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
  }
  let buyPressure = null;
  if (t.buys24h != null && t.sells24h != null && t.buys24h + t.sells24h > 0) {
    const r = t.buys24h / (t.buys24h + t.sells24h);
    buyPressure = clamp(r * 160 - 30, 0, 100);
  }
  let curve = null;
  if (t.graduated) {
    curve = 70;
  } else if (t.curvePct != null) {
    const p = t.curvePct;
    curve = p < 15 ? (p / 15) * 60 : p <= 85 ? 60 + 40 * ((p - 15) / 70) : 100 - ((p - 85) / 15) * 50;
    curve = clamp(curve, 0, 100);
  }
  let age = null;
  if (ageH != null) {
    const maxH = t.graduated ? cfg.maxAgeDays * 24 : cfg.maxPumpAgeHrs;
    age = ageH <= 6 ? 70 + 30 * (ageH / 6) : clamp(100 - ((ageH - 6) / Math.max(maxH - 6, 1)) * 100, 0, 100);
  }
  const momentum = momentumScore(t);
  const { weights: W, adapted } = getAdaptiveWeights(SCORE_WEIGHTS);
  const parts = { liquidity, holders, buyPressure, curve, age, momentum };
  let num = 0, den = 0;
  for (const k of Object.keys(W)) {
    if (parts[k] != null) { num += W[k] * parts[k]; den += W[k]; }
  }
  const score = den > 0 ? Math.round(num / den) : 0;
  return { score, breakdown: parts, adapted, weights: W };
}

export async function vetToken(t, cfg) {
  const fk = freeKill(t, cfg);
  if (fk) {
    floorEmit('vet.kill', { mint: t.address, symbol: t.symbol, name: t.name, killPass: 'free', killReason: fk });
    return { verdict: 'KILLED', killReason: fk, killPass: 'free', t };
  }
  const tk = tradeKill(t, cfg);
  if (tk) {
    floorEmit('vet.kill', { mint: t.address, symbol: t.symbol, name: t.name, killPass: 'trade', killReason: tk });
    return { verdict: 'KILLED', killReason: tk, killPass: 'trade', t };
  }
  const { reason, dossier } = await rugKill(t, cfg);
  if (dossier) floorEmit('dossier.ready', {
    mint: t.address, symbol: t.symbol, name: t.name,
    devPct: dossier.devPct, topPct: dossier.topPct, top10Pct: dossier.top10Pct,
    holderCount: dossier.holderCount, rugged: dossier.rugged, risks: dossier.risks || [],
  });
  if (reason) {
    floorEmit('vet.kill', { mint: t.address, symbol: t.symbol, name: t.name, killPass: 'rug', killReason: reason });
    return { verdict: 'KILLED', killReason: reason, killPass: 'rug', dossier, t };
  }
  const { score, breakdown, adapted, weights } = scoreToken(t, dossier, cfg);
  floorEmit('vet.scored', {
    mint: t.address, symbol: t.symbol, name: t.name, score, breakdown,
    adapted: !!adapted,
    holderCount: dossier && dossier.holderCount != null ? dossier.holderCount : null,
    buys24h: t.buys24h != null ? t.buys24h : null,
    sells24h: t.sells24h != null ? t.sells24h : null,
    vol24h: t.vol24h != null ? t.vol24h : null,
  });
  return { verdict: 'SCORED', score, breakdown, dossier, adapted: !!adapted, weights, t };
}
