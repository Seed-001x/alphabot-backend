// ALPHABOT backend pipeline: SCAN → VET (kill chain, ascending cost) → SCORE.
// Ported from the frontend desk. Server-side, SCAN gains first-class
// pump.fun API sources (no CORS): /coins sorted by created_timestamp (NEW)
// and market_cap (TRENDING), plus the existing RugCheck firehose and
// DexScreener profiles/boosts. "Code fetches, the model judges, code decides."

import { fetchTokens, fetchLatestProfiles, fetchLatestBoosts, tokenView } from './dexscreener.js';
import {
  fetchFreshPumpCoins, fetchPumpLatest, fetchPumpTop, fetchPumpMovers, fetchPumpSwapGraduated, fetchRugReport,
  curveProgress, isOnCurve, PUMP_SUFFIX,
} from './pumpfun.js';
import { buildFeeds, momentumScore } from './feeds.js';
import { fetchJupTrending } from './jupTrending.js';
import { washSpikeCheck, holderGate, lpLockCheck } from './antiscam.js';
import { AGGRESSIVE_MOMENTUM_WEIGHT } from './config.js';
import { getAdaptiveWeights } from './learning.js';
import { getPumpPortalMints, probePumpPortal } from './pumpportal.js';
import { STABLE_MINTS } from './helius.js';
import { fmtUsd } from './fmt.js';
import { floorEmit } from './events.js';

export const SCORE_WEIGHTS = { liquidity: 15, holders: 20, bundle: 10, buyPressure: 30, curve: 15, age: 15, momentum: 10 };

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
  const [pumpLatest, pumpTop, pumpMovers, pumpGraduated, fresh, profiles, boosts, jupTrend] = await Promise.all([
    fetchPumpLatest(40),
    fetchPumpTop(60),
    fetchPumpMovers(60),
    fetchPumpSwapGraduated(40),
    fetchFreshPumpCoins(40),
    fetchLatestProfiles(60),
    fetchLatestBoosts(60),
    fetchJupTrending(80).catch(() => []),   // v3.46: volume-ranked trending, all ages
  ]);
  // v3.46: mover snapshots are now recorded AFTER DexScreener enrichment (see
  // below) so they carry real market cap + volume. The old block recorded raw
  // pump.fun rows: pumpTop rows had no `usd_market_cap` key (normalised to
  // `usdMc`) so they were silently dropped, and no row carried volume, so the
  // movers `avgVol > 5000` gate could never pass.
  // v3.30: touch the token registry for every discovered mint so nothing
  // disappears after one look. Graduated PumpSwap coins update the EXISTING
  // record's venue (no duplicate identities across venues).
  try {
    const { registryTouch, registrySetVenue, registryPrune } = await import('./registry.js');
    const feedTags = [
      [pumpLatest, 'pump-latest', 'bonding_curve'],
      [pumpTop, 'pump-top', 'bonding_curve'],
      [pumpMovers, 'pump-movers', 'bonding_curve'],
      [pumpGraduated, 'pumpswap', 'pumpswap'],
      [fresh, 'rugcheck-fresh', 'bonding_curve'],
    ];
    for (const [feed, source, venue] of feedTags) {
      for (const f of (feed || [])) {
        if (!f || !f.address) continue;
        registryTouch(f.address, f.usdMc || f.usd_market_cap || 0, {
          symbol: f.symbol, name: f.name, source, venue,
        });
      }
    }
    // Graduation transitions: a mint seen on pumpswap that was previously
    // tracked as bonding_curve gets its venue updated (new evidence → re-vet).
    for (const f of (pumpGraduated || [])) {
      if (f && f.address) registrySetVenue(f.address, 'pumpswap').catch(() => {});
    }
    registryPrune();
  } catch { /* registry is additive */ }
  const meta = new Map();
  for (const f of [...pumpLatest, ...fresh]) meta.set(f.address, f);
  for (const f of pumpTop) if (!meta.has(f.address)) meta.set(f.address, f);
  for (const f of pumpMovers) if (!meta.has(f.address)) {
    meta.set(f.address, { ...f, moverFeed: true });
  }
  // v3.29: graduated PumpSwap coins — tagged so the pipeline knows they're
  // post-graduation runners, not bonding-curve launches.
  for (const f of pumpGraduated) if (!meta.has(f.address)) {
    meta.set(f.address, { ...f, graduatedFeed: true });
  }
  let ppMints = [];
  try { ppMints = getPumpPortalMints(); } catch { ppMints = []; }
  for (const m of ppMints) {
    if (m.mint && !meta.has(m.mint)) {
      meta.set(m.mint, { source: 'pumpportal', creator: m.creator || null, createdAt: m.ts });
    }
  }
  for (const s of [...profiles, ...boosts]) {
    if (s.address && !meta.has(s.address)) meta.set(s.address, { source: s.source });
  }
  // v3.46: QUOTA batch instead of addrs.slice(0, 120).
  // `meta` is filled newest-launch-first: pumpLatest + fresh (fresh alone replays
  // up to ~120 remembered mints from the 90-min cache) ahead of top / movers /
  // graduated / PumpPortal / boosts. Once the bot had been up a while, the first
  // 120 slots were ALL brand-new launches and everything after — the movers
  // list, graduated PumpSwap runners, boosts — was cut off before DexScreener
  // was ever asked about it. Each source now gets its own quota.
  const picked = new Set();
  const take = (list, n) => {
    let c = 0;
    for (const x of list || []) {
      const a = x && (x.address || x.mint);
      if (!a || picked.has(a)) continue;
      picked.add(a);
      if (++c >= n) break;
    }
  };
  take(jupTrend, 80);                   // volume-ranked trending (hours-to-weeks-old runners)
  take(pumpMovers, 50);                 // pump.fun movers tab proxy (recent trades)
  take(pumpGraduated, 50);              // PumpSwap graduated runners (QOAT-style)
  take(pumpTop, 40);                    // trending by MC
  take(profiles, 15); take(boosts, 15); // DexScreener profiles / boosts
  take(ppMints, 25);                    // PumpPortal live mints
  take(pumpLatest, 30);                 // newest launches
  take(fresh, 30);                      // RugCheck firehose
  // anything watched by the mover store (so a coin we saw earlier keeps being
  // refreshed and can trigger the 'pop' detector)
  try {
    const { getWatchlist } = await import('./movers.js');
    take(getWatchlist(60).map(m => ({ address: m })), 60);
  } catch { /* additive */ }
  const batch = [...picked].slice(0, 260);
  if (!batch.length) return { candidates: [], discovered: 0 };

  const raw = await fetchTokens(batch);
  const enriched = new Map();
  for (const a of batch) {
    const pair = raw[a];
    if (!pair) continue;
    const t = tokenView(pair);
    if (t) enriched.set(a, { ...t, chainId: pair.chainId || null });
  }
  // v3.46: record movers snapshots from enriched data (real MC + volume windows).
  try {
    const { recordMoverSnapshot } = await import('./movers.js');
    recordMoverSnapshot([...enriched.values()].map(t => ({
      address: t.address, symbol: t.symbol, mc: t.mc,
      vol24h: t.vol24h || 0, volH1: t.volH1, volM5: t.volM5,
    })));
  } catch { /* movers is additive */ }
  // NEW = pump.fun API latest + firehose + PumpPortal; TRENDING = pump.fun
  // API top + DexScreener boosts/profiles; MOVERS = local momentum.
  const { tags, movers, rows } = buildFeeds({
    fresh, pumpLatest, pumpTop, profiles, boosts: [...boosts, ...jupTrend], enriched,
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
    const t0 = enriched.get(a);
    const m = meta.get(a) || {};
    // v3.17: pump.fun fallback — DexScreener hasn't indexed fresh coins yet,
    // but pump.fun's own API reports live usd_market_cap. Use it instead of
    // dropping them. Volume floor is skipped for these (a 10-min-old coin has
    // no meaningful 24h volume — its MC IS the buying evidence).
    let t = t0;
    if (!t0 || !t0.price || !t0.mc) {
      const pfMc = m.usdMc;
      if (!pfMc || pfMc <= 0) continue;
      t = { address: a, symbol: m.symbol || '???', name: m.name || 'Unknown', mc: pfMc, price: null, vol24h: null, buys24h: null, sells24h: null, liquidity: 0, _pfFallback: true };
    }
    if (!t || !t.mc) continue;
    const graduated = !isOnCurve(pair);
    const turnover = t.vol24h && t.mc ? t.vol24h / t.mc : 0;
    const mv = movers.get(a);
    candidates.push({
      ...t,
      source: m.source || 'pump',
      creator: m.creator || t.creator || null,
      twitter: m.twitter || t.twitter || null,
      website: m.website || t.website || null,
      telegram: m.telegram || t.telegram || null,
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
  // v3.45: vet movers/trending FIRST. User: "do I have to share my screen
  // so he can see the Pumpfun movers I see" — the bot was burying movers
  // under high-turnover tiny coins. Movers/trending/whale tags sort first,
  // then turnover within each tier.
  const feedRank = (c) => {
    const f = c.feeds || [];
    if (f.includes('movers')) return 3;
    if (f.includes('trending')) return 2;
    if (c.moverFeed || c.graduatedFeed) return 1;
    return 0;
  };
  candidates.sort((a, b) => (feedRank(b) - feedRank(a)) || (b.turnover - a.turnover));
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
  // v3.18: aggressive mode skips mint/freeze kills — paper money can afford the lesson.
  if (!cfg.skipMintFreezeKill) {
    if (t.mintAuthOpen === true) return 'mint authority OPEN · dev can mint';
    if (t.freezeAuthOpen === true) return 'freeze authority OPEN · dev can freeze';
  }
  const liq = t.liquidity || 0;
  // On-curve pump.fun coins report $0 DEX liquidity — the bonding curve IS
  // their liquidity (always sellable into the curve). Gate those on volume
  // instead; keep the LP floor for graduated coins with real DEX pools.
  if (t.graduated && !(liq >= cfg.minLiquidityUsd)) return `liq ${fmtUsd(liq)} < ${fmtUsd(cfg.minLiquidityUsd)} floor`;
  // v3.17: skip volume floor for pump.fun-fallback coins (too new for 24h vol).
  // v3.20: same for Meteora DBC launches and GeckoTerminal new pools.
  if (!t._pfFallback && !t._dbc && !t._gt) {
    const vol = t.vol24h || 0;
    if (!(vol >= cfg.minVol24hUsd)) return `vol24h ${fmtUsd(vol)} < ${fmtUsd(cfg.minVol24hUsd)} floor`;
  }
  // v3.17: social link required — kills random dev extract launches with no
  // twitter/website/telegram attached. v3.18: skipped in aggressive mode.
  // v3.20: GeckoTerminal new pools don't carry social metadata (too new) —
  // the RugCheck dossier still runs, so skip the social gate for _gt only.
  if (!cfg.skipSocialCheck && !t._gt && !t.twitter && !t.website && !t.telegram) return 'no socials · dev extract risk';
  const mc = t.mc || 0;
  const lo = t.graduated ? cfg.minMc : cfg.pumpMinMc;
  const hi = t.graduated ? cfg.maxMc : cfg.pumpMaxMc;
  if (mc < lo) return `MC ${fmtUsd(mc)} < ${fmtUsd(lo)} floor`;
  if (mc > hi) return `MC ${fmtUsd(mc)} > ${fmtUsd(hi)} cap`;
  // v3.26 ANTISCAM: wash-spike detection — 90%+ of 24h volume in the last
  // 5 minutes = fake volume (wash trading), not real interest.
  try {
    const ws = washSpikeCheck(t);
    if (!ws.pass) return ws.reason;
  } catch { /* fail-open */ }
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
  // v3.18: aggressive mode skips rug kills entirely — let it get rugged and learn.
  if (cfg.skipRugKill) return { reason: null, dossier: null };
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
  if (t.moverSetup === 'pop') h += 100;          // v3.46: pops always research/score first
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
  // v3.20: bundle awareness — heavy undisclosed bundles drag the score,
  // but don't kill (user wants loose gates). A distributing bundle (pct
  // dropping over time) is actually bullish — tracked separately.
  let bundle = null;
  if (dossier && dossier.bundleScore != null && dossier.bundleScore > 0) {
    // 0-30: mild, 30-60: moderate drag, 60+: heavy drag.
    bundle = clamp(100 - dossier.bundleScore * 0.8, 0, 100);
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
  const { weights: W0, adapted } = getAdaptiveWeights(SCORE_WEIGHTS);
  // v3.18: aggressive mode — momentum matters more (catch the runners).
  const W = cfg.aggressiveMode ? { ...W0, momentum: AGGRESSIVE_MOMENTUM_WEIGHT } : W0;
  const parts = { liquidity, holders, bundle, buyPressure, curve, age, momentum };
  let num = 0, den = 0;
  for (const k of Object.keys(W)) {
    if (parts[k] != null) { num += W[k] * parts[k]; den += W[k]; }
  }
  const score = den > 0 ? Math.round(num / den) : 0;
  return { score, breakdown: parts, adapted, weights: W };
}

// v3.20: copycat registry — symbol (uppercased) → { mint, mc, firstSeen }.
// Kills younger/lower-MC duplicates riding a real coin's name (e.g. fake
// TWEETCRAFT with a vanity "moon" mint). The highest-MC mint wins the symbol.
const seenSymbols = new Map();
export function copycatKill(t) {
  const sym = (t.symbol || '').toUpperCase().trim();
  if (!sym || sym.length < 2) return null;
  const mc = t.mc || 0;
  const prev = seenSymbols.get(sym);
  if (prev && prev.mint !== t.address) {
    // Different mint, same symbol. Higher MC wins.
    if (mc <= prev.mc * 1.5) {
      return `copycat · ${sym} already tracked at ${prev.mint.slice(0, 8)} (${fmtUsd(prev.mc)} MC)`;
    }
    // New one is decisively bigger — it takes the symbol.
    seenSymbols.set(sym, { mint: t.address, mc, firstSeen: Date.now() });
    return null;
  }
  if (!prev) seenSymbols.set(sym, { mint: t.address, mc, firstSeen: Date.now() });
  else if (mc > prev.mc) prev.mc = mc; // refresh MC for the tracked mint
  return null;
}

export async function vetToken(t, cfg) {
  // v3.39 APE MODE per user ("fuck all the restriction bullshit") — the ENTIRE
  // vet kill chain is disabled. Every discovered coin flows to scoring and the
  // entry path. Remaining safety: honeypot simulation in realtrade.js (before
  // every buy), wallet balance + max positions. Exits: 40% SL / 2x TP.
  // const fk = freeKill(t, cfg);
  // if (fk) {
  //   floorEmit('vet.kill', { mint: t.address, symbol: t.symbol, name: t.name, killPass: 'free', killReason: fk });
  //   return { verdict: 'KILLED', killReason: fk, killPass: 'free', t };
  // }
  // v3.20: copycat check REMOVED per user 2026-10-07 — no more copycat killer.
  // const tk = tradeKill(t, cfg);
  // if (tk) {
  //   floorEmit('vet.kill', { mint: t.address, symbol: t.symbol, name: t.name, killPass: 'trade', killReason: tk });
  //   return { verdict: 'KILLED', killReason: tk, killPass: 'trade', t };
  // }
  // const { reason, dossier } = await rugKill(t, cfg);
  // if (dossier) floorEmit('dossier.ready', {
  //   mint: t.address, symbol: t.symbol, name: t.name,
  //   devPct: dossier.devPct, topPct: dossier.topPct, top10Pct: dossier.top10Pct,
  //   holderCount: dossier.holderCount, rugged: dossier.rugged, risks: dossier.risks || [],
  // });
  // if (reason) {
  //   floorEmit('vet.kill', { mint: t.address, symbol: t.symbol, name: t.name, killPass: 'rug', killReason: reason });
  //   return { verdict: 'KILLED', killReason: reason, killPass: 'rug', dossier, t };
  // }
  // v3.26 ANTISCAM holder floor (300 holders) — DISABLED v3.39 (ape mode).
  // {
  //   const hg = holderGate(dossier);
  //   if (!hg.pass) {
  //     floorEmit('vet.kill', { mint: t.address, symbol: t.symbol, name: t.name, killPass: 'holders', killReason: hg.reason });
  //     return { verdict: 'KILLED', killReason: hg.reason, killPass: 'holders', dossier, t };
  //   }
  // }
  // v3.26 ANTISCAM LP lock — DISABLED v3.39 (ape mode).
  // {
  //   const lp = lpLockCheck(dossier, t.graduated);
  //   if (!lp.pass) {
  //     floorEmit('vet.kill', { mint: t.address, symbol: t.symbol, name: t.name, killPass: 'lplock', killReason: lp.reason });
  //     return { verdict: 'KILLED', killReason: lp.reason, killPass: 'lplock', dossier, t };
  //   }
  // }
  const dossier = null;
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
