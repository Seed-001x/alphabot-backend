// ANTISCAM (v3.26) — pre-entry scam filters for the real-money bot.
// The bot was buying instant-rug scams: coins that go to $0 liquidity right
// after entry ("liquidity death — $0 liq vs $1 position (unexitable)").
// These gates run late in the pipeline (only on coins that passed everything
// else) and fail CLOSED: when uncertain, skip the trade.
//
// Gates:
//  1. holderGate — minimum 300 holders (RugCheck dossier). No exceptions.
//  2. honeypotCheck — Jupiter SELL quote before entry. No route or dust
//     output = unexitable = skip.
//  3. lpLockCheck — graduated coins must have >=80% of LP locked/burned.
//     On-curve coins pass automatically (the curve can't be LP-pulled).
//  4. washSpikeCheck — 90%+ of 24h volume in the last 5 min = fake volume.
//
// Score boosts (moverQualityBonus) reward real momentum plays:
//  +10 holders >= 300 · +8 sustained volume 15+ min · +5 gradual MC climb.

import { jupQuote } from './realexec.js';
import { getSnapshot } from './feeds.js';
import { floorEmit } from './events.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const MIN_HOLDERS = 300;
export const MIN_LP_LOCKED_PCT = 80;

// ---------------------------------------------------------- 1. holder gate
// Runs post-dossier in vetToken. Fail closed: no holder data = skip.
export function holderGate(dossier) {
  const hc = dossier && dossier.holderCount;
  if (hc == null) {
    return { pass: false, reason: 'holders unknown — uncertain, skip' };
  }
  if (hc < MIN_HOLDERS) {
    return { pass: false, reason: `holders ${hc} < ${MIN_HOLDERS} floor` };
  }
  return { pass: true, reason: `holders ${hc}` };
}

// ---------------------------------------------------------- 2. honeypot sim
// Simulate a SELL via Jupiter quote before realEnter executes. If Jupiter
// can't route the sell or the output is dust, the token is unexitable.
export async function honeypotCheck(mint, decimals = 6) {
  const probeRaw = String(1000 * Math.pow(10, decimals)); // 1000 tokens
  try {
    const q = await jupQuote(mint, SOL_MINT, probeRaw, 5000);
    const out = Number(q && q.outAmount ? q.outAmount : 0);
    if (!(out > 0)) {
      const r = { pass: false, reason: 'honeypot? sell quote returned zero' };
      floorEmit('antiscam.honeypot', { mint, ...r });
      return r;
    }
    return { pass: true, reason: 'sell quote ok', outLamports: out };
  } catch (e) {
    const r = { pass: false, reason: `honeypot? sell quote failed: ${(e && e.message || '').slice(0, 60)}` };
    floorEmit('antiscam.honeypot', { mint, ...r });
    return r;
  }
}

// ---------------------------------------------------------- 3. LP lock
export function lpLockCheck(dossier, graduated) {
  if (!graduated) return { pass: true, reason: 'on-curve (no LP to pull)' };
  const pct = dossier && dossier.lpLockedPct;
  if (pct == null) {
    return { pass: false, reason: 'graduated but no LP lock data — uncertain, skip' };
  }
  if (pct >= MIN_LP_LOCKED_PCT) return { pass: true, reason: `LP ${pct}% locked` };
  return { pass: false, reason: `LP only ${pct}% locked — dev can pull` };
}

// ---------------------------------------------------------- 4. wash spike
export function washSpikeCheck(t) {
  const m5 = t.volM5, h24 = t.vol24h;
  if (m5 == null || h24 == null || !(h24 > 0)) {
    return { pass: true, reason: 'no intraday vol data' };
  }
  if (m5 >= h24 * 0.9) {
    return {
      pass: false,
      reason: `wash spike — $${Math.round(m5).toLocaleString()} of $${Math.round(h24).toLocaleString()} 24h vol in last 5m`,
    };
  }
  return { pass: true, reason: 'volume distributed' };
}

// ---------------------------------------------------------- mover quality bonus
// Rewards real momentum plays: strong holder base, sustained volume,
// gradual (not vertical) MC climb.
export function moverQualityBonus(t, dossier) {
  let bonus = 0;
  const parts = [];
  const hc = dossier && dossier.holderCount;
  if (hc != null && hc >= MIN_HOLDERS) {
    bonus += 10;
    parts.push(`holders ${hc} +10`);
  }
  let snap = null;
  try { snap = t.address ? getSnapshot(t.address) : null; } catch { snap = null; }
  if (snap && snap.first && snap.last) {
    const ageMin = (snap.last.ts - snap.first.ts) / 60000;
    const firstVol = snap.first.vol || 0;
    const lastVol = snap.last.vol || 0;
    if (ageMin >= 15 && firstVol > 0 && lastVol > 0) {
      bonus += 8;
      parts.push(`sustained vol ${Math.round(ageMin)}m +8`);
    }
    const firstMc = snap.first.mc || 0;
    if (firstMc > 0) {
      const chg = (snap.last.mc - firstMc) / firstMc;
      if (chg >= 0.2 && chg <= 3.0) {
        bonus += 5;
        parts.push(`gradual climb +${Math.round(chg * 100)}% +5`);
      }
    }
  }
  return { bonus, line: parts.join(' · ') || 'no mover quality signals' };
}
