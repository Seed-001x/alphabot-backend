// flowWatch — silent smart-money flow watcher, server-side edition.
// Watches the curated FLOW_ADDRS set for fresh SOL→token buys and injects
// the mint into the DD pipeline. Discovery only — never scores, never
// decides. Dormant without HELIUS_API_KEY. Fail-open on every error.
// Credit discipline: 20 addresses per loop, one loop per ~3 min
// (~400 sig-list calls/hour + parses only on real activity).

import { FLOW_ADDRS } from './flowAddrs.js';
import { parseSwaps, STABLE_MINTS, SOL_MINT, getKey, rpcCall, fetchParsedTxn } from './helius.js';
import { storage } from './storage.js';

const BATCH = 20;
const LOOP_MS = 180000;
const SIG_LIMIT = 3;

const LS_CURSOR = 'alphabot_flow_cursor';
const LS_SIGS = 'alphabot_flow_sigs';
const LS_REQS = 'alphabot_flow_reqs';

function loadSigMap() {
  try {
    const m = JSON.parse(storage.getItem(LS_SIGS) || '{}');
    return (m && typeof m === 'object') ? m : {};
  } catch { return {}; }
}
function saveSigMap(m) {
  try {
    const keys = Object.keys(m);
    if (keys.length > FLOW_ADDRS.length + 10) {
      for (const k of keys.slice(0, keys.length - FLOW_ADDRS.length - 10)) delete m[k];
    }
    storage.setItem(LS_SIGS, JSON.stringify(m));
  } catch { /* nicety */ }
}

export function getFlowStats() {
  return {
    requests: Number(storage.getItem(LS_REQS) || 0) || 0,
    batch: BATCH, loopMin: Math.round(LOOP_MS / 60000),
    active: Boolean(getKey()),
  };
}

function bumpReqs(n = 1) {
  try { storage.setItem(LS_REQS, String((Number(storage.getItem(LS_REQS) || 0) || 0) + n)); } catch { /* nicety */ }
}

export function startFlowWatch(onMint) {
  const key = getKey();
  if (!key) {
    console.log('[flow] dormant — no HELIUS_API_KEY');
    return { stop() {}, active: false };
  }
  console.log(`[flow] watching ${FLOW_ADDRS.length} wallets (${BATCH}/loop, ~${Math.round(LOOP_MS / 60000)}min loop)`);
  let alive = true;
  let timer = 0;

  async function loopOnce() {
    if (!alive) return;
    const sigs = loadSigMap();
    let cursor = Number(storage.getItem(LS_CURSOR) || 0) || 0;
    const batch = [];
    for (let i = 0; i < BATCH; i++) batch.push(FLOW_ADDRS[(cursor + i) % FLOW_ADDRS.length]);
    cursor = (cursor + BATCH) % FLOW_ADDRS.length;
    storage.setItem(LS_CURSOR, String(cursor));

    for (const addr of batch) {
      if (!alive) break;
      try {
        bumpReqs(1);
        const list = await rpcCall(key, 'getSignaturesForAddress', [addr, { limit: SIG_LIMIT }]);
        if (!Array.isArray(list) || !list.length) continue;
        const newest = list[0] && list[0].signature;
        if (!newest || sigs[addr] === newest) continue;
        sigs[addr] = newest;
        try {
          bumpReqs(1);
          const txns = await fetchParsedTxn(key, newest);
          const { buys } = parseSwaps(txns, addr);
          for (const b of buys) {
            if (!b || !b.mint || b.mint === SOL_MINT || STABLE_MINTS.has(b.mint)) continue;
            try { onMint(b.mint); } catch {}
          }
        } catch { /* parse failure: skip silently */ }
      } catch { /* one address failing never kills the loop */ }
    }
    saveSigMap(sigs);
  }

  (async () => {
    await new Promise(r => setTimeout(r, 15000));
    if (!alive) return;
    await loopOnce().catch(() => {});
    if (alive) timer = setInterval(() => { loopOnce().catch(() => {}); }, LOOP_MS);
  })();

  return {
    active: true,
    stop() { alive = false; if (timer) clearInterval(timer); },
  };
}
