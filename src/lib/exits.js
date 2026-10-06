// ADAPTIVE EXITS (ported from the frontend desk, v3.6).
// exitPolicy() replaces fixed thresholds. The RISK stage learns when to
// break its own TP/SL rules, from the trade journal only.
// Base params (scalp): TP +30%, SL −15%, trail −12% arms +10%, 90-min hold.
// Cold-start: ≥10 closed trades before ANY learned deviation.

import { readJournal } from './learning.js';

export const EXIT_MIN_TRADES = 10;
const RUNNER_MIN = 5;
const DEADCUT_MIN = 5;
const BUCKET_MIN = 5;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function feedOf(j) {
  const f = j.feeds || [];
  if (f.includes('movers')) return 'movers';
  if (f.includes('trending')) return 'trending';
  if (f.includes('new')) return 'new';
  return 'none';
}

function bandOf(score) {
  const s = score || 0;
  return s < 70 ? '<70' : s < 80 ? '70-80' : '80+';
}

export function bucketKeyFor(j) {
  return `${feedOf(j)}/${bandOf(j.score)}`;
}

const isRunnerProfile = (j) =>
  feedOf(j) === 'movers' && ((j.buyPressure ?? j.breakdown?.buyPressure) || 0) >= 70;

export function getExitRules(cfg) {
  const J = readJournal().filter(t => t.exitTs != null && t.pnlPct != null);
  const baseTP = cfg.takeProfit, baseSL = cfg.stopLoss;
  const rules = {
    ready: J.length >= EXIT_MIN_TRADES, n: J.length,
    runner: { active: false, n: 0 },
    deadCut: { active: false, n: 0, avg: null },
    buckets: {},
  };
  if (!rules.ready) return rules;
  try {
    const runnerWins = J.filter(j => isRunnerProfile(j) && j.pnlPct >= 2 * baseTP * 100);
    rules.runner = { active: runnerWins.length >= RUNNER_MIN, n: runnerWins.length };
    const dead = J.filter(j => (j.holdMs || 0) >= 20 * 60e3 && j.pnlPct >= -15 && j.pnlPct <= 5);
    const avg = dead.length ? dead.reduce((a, j) => a + j.pnlPct, 0) / dead.length : null;
    rules.deadCut = { active: dead.length >= DEADCUT_MIN && avg != null && avg < -2, n: dead.length, avg };
    const by = {};
    for (const j of J) {
      const k = bucketKeyFor(j);
      const e = by[k] || (by[k] = { key: k, n: 0, wins: 0 });
      e.n++;
      if (j.pnlPct > 0) e.wins++;
    }
    for (const k of Object.keys(by)) {
      const e = by[k];
      if (e.n < BUCKET_MIN) continue;
      const winRate = e.wins / e.n;
      let sl = baseSL, tp = baseTP;
      if (winRate >= 0.6) { sl = baseSL * 1.33; tp = baseTP * 1.33; }
      else if (winRate < 0.4) { sl = baseSL * 0.67; tp = baseTP * 0.67; }
      sl = clamp(sl, 0.08, 0.25);
      tp = Math.max(0.15, tp);
      rules.buckets[k] = {
        ...e, winRate,
        sl: Math.round(sl * 1000) / 1000, tp: Math.round(tp * 1000) / 1000,
        adjusted: Math.abs(sl - baseSL) > 0.001 || Math.abs(tp - baseTP) > 0.001,
      };
    }
  } catch { /* journal corrupt → base params */ }
  return rules;
}

export function exitPolicy(pos, q, cfg, rules) {
  const midMultiple = q.mc / pos.entryMc;
  if (!(midMultiple > 0)) return null;
  const pnlPct = (midMultiple - 1) * 100;
  const holdMs = Date.now() - pos.entryTs;
  const tag = (n) => `(learned, n=${n})`;

  const bkt = rules.buckets[bucketKeyFor(pos)];
  const sl = bkt ? bkt.sl : cfg.stopLoss;
  const tp = bkt ? bkt.tp : cfg.takeProfit;
  const profLearned = !!(bkt && bkt.adjusted);
  const profNote = profLearned ? ` (profiled ${bucketKeyFor(pos)}, n=${bkt.n})` : '';

  if (rules.runner.active && isRunnerProfile(pos)) {
    const n = rules.runner.n;
    if (midMultiple >= 1 + 3 * cfg.takeProfit) {
      return { reason: `runner cap 3x TP ${tag(n)}`, learned: true };
    }
    if (pos.runnerMode) {
      if (pos.peakMultiple >= 1 + cfg.trailingArmAt &&
          midMultiple <= pos.peakMultiple * (1 - cfg.trailingStop)) {
        return { reason: `runner trail −${Math.round(cfg.trailingStop * 100)}% from peak ${tag(n)}`, learned: true };
      }
      return null;
    }
    if (midMultiple >= 1 + tp) {
      pos.runnerMode = true;
      return null;
    }
  }

  if (midMultiple >= 1 + tp) return { reason: `take-profit +${Math.round(tp * 100)}%${profNote}`, learned: profLearned };
  if (midMultiple <= 1 - sl) return { reason: `stop-loss −${Math.round(sl * 100)}%${profNote}`, learned: profLearned };
  if (pos.peakMultiple >= 1 + cfg.trailingArmAt &&
      midMultiple <= pos.peakMultiple * (1 - cfg.trailingStop)) {
    return { reason: `trailing stop −${Math.round(cfg.trailingStop * 100)}% from peak`, learned: false };
  }
  if (holdMs >= cfg.maxHoldHours * 3600e3) {
    return { reason: `max hold ${cfg.maxHoldHours}h reached`, learned: false };
  }

  // SNIPER PLAYBOOK (baked, ungated): memecoin exits are about speed.
  // Order-flow death — track buys/sells flow SINCE ENTRY (24h aggregates move
  // too slowly tick-to-tick). If sell flow dominates buy flow 1.5x with
  // meaningful volume, it's distribution: get out before the floor falls out.
  const b = q.buys24h, s = q.sells24h;
  if (b != null && s != null) {
    if (pos.flowB0 == null) { pos.flowB0 = b; pos.flowS0 = s; }
    const dB = Math.max(0, b - pos.flowB0), dS = Math.max(0, s - pos.flowS0);
    if (dB + dS >= 10 && dS > dB * 1.5 && pnlPct < 15) {
      return { reason: `flow dead · +${dB} buys vs +${dS} sells since entry — distribution`, learned: false };
    }
  }
  // Stall — 20 minutes in and it hasn't moved: it's not going to. Rotate.
  // (Doesn't touch runners: TP/trailing returned above.)
  if (holdMs >= 20 * 60e3 && pnlPct > -5 && pnlPct < 10) {
    return { reason: `stalled ${Math.round(holdMs / 60000)}m · flat ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(0)}% — rotating`, learned: false };
  }

  if (rules.deadCut.active && holdMs >= 20 * 60e3 && pnlPct >= -8 && pnlPct <= 5) {
    const ev = pos.entryVol || null;
    const cv = q.vol24h || null;
    if (ev && cv && cv < ev * 0.7) {
      return { reason: `dead-money cut (flat ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(0)}%, vol decaying) ${tag(rules.deadCut.n)}`, learned: true };
    }
  }
  return null;
}
