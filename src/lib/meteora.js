// Meteora DBC (Dynamic Bonding Curve) launch feed — server-side edition.
// Watches the DBC program via Helius logsSubscribe for new pool creations,
// computes live MC from on-chain curve state, and injects launches into the
// pipeline's NEW feed. This is the non-pump.fun launchpad rail: AUTON,
// RARI, TWEETCRAFT all launched here (or graduated from here).
//
// Fail-open everywhere: WS drops, parse failures, and RPC errors never
// touch the rest of the pipeline.

import WebSocket from 'ws';
import { BorshCoder } from '@coral-xyz/anchor';
import {
  DynamicBondingCurveIdl,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  getPriceFromSqrtPrice,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { getKey, rpcCall, SOL_MINT, USDC_MINT } from './helius.js';
import { solPrice } from './dexscreener.js';

export const DBC_PROGRAM_ID = DYNAMIC_BONDING_CURVE_PROGRAM_ID.toString();

const WS_URL = 'wss://mainnet.helius-rpc.com/';
const RETRY_BASE = 15000;
const RETRY_MAX = 5 * 60 * 1000;
const SEEN_TTL = 30 * 60 * 1000;
const SEEN_CAP = 500;

let ws = null;
let subId = null;
let reqId = 1;
let state = 'idle'; // idle | probing | live | dead
let retryAt = 0;
let backoffMs = RETRY_BASE;
let onLaunchCb = null;
const seen = new Map(); // mint -> ts
const stats = { launches: 0, errors: 0, lastLaunchTs: 0 };

export function dbcState() { return state; }
export function getDbcStats() {
  return { state, launches: stats.launches, errors: stats.errors, lastLaunchTs: stats.lastLaunchTs };
}

let coder = null;
function getCoder() {
  if (!coder) coder = new BorshCoder(DynamicBondingCurveIdl);
  return coder;
}

function noteSeen(mint) {
  const now = Date.now();
  if (seen.has(mint)) return false;
  seen.set(mint, now);
  if (seen.size > SEEN_CAP) {
    const oldest = [...seen.entries()].sort((a, b) => a[1] - b[1])[0];
    if (oldest) seen.delete(oldest[0]);
  }
  // prune expired
  for (const [k, ts] of seen) {
    if (now - ts > SEEN_TTL) seen.delete(k);
    else break;
  }
  return true;
}

function scheduleRetry() {
  state = 'dead';
  try { ws && ws.close(); } catch { /* noop */ }
  ws = null; subId = null;
  retryAt = Date.now() + backoffMs;
  backoffMs = Math.min(backoffMs * 2, RETRY_MAX);
}

// --- on-chain reads -------------------------------------------------------

async function rpc(key, method, params) {
  return rpcCall(key, method, params, 12000);
}

// Extract (pool, quoteMint) from a pool-init transaction.
// The init instruction has 15 accounts: [config, pool_authority, creator,
// base_mint, quote_mint, pool, ...] — pool is index 5, quote mint index 4.
function findInitAccounts(tx) {
  try {
    const msg = tx && tx.transaction && tx.transaction.message;
    const ixs = (msg && msg.instructions) || [];
    for (const ix of ixs) {
      if (ix.programId !== DBC_PROGRAM_ID) continue;
      const accs = ix.accounts || [];
      if (accs.length >= 6) return { pool: accs[5], quoteMint: accs[4] };
    }
    // inner instructions (CPI path)
    const inners = (tx.meta && tx.meta.innerInstructions) || [];
    for (const grp of inners) {
      for (const ix of grp.instructions || []) {
        if (ix.programId !== DBC_PROGRAM_ID) continue;
        const accs = ix.accounts || [];
        if (accs.length >= 6) return { pool: accs[5], quoteMint: accs[4] };
      }
    }
  } catch { /* fall through */ }
  return null;
}

async function fetchPoolState(key, pool) {
  const info = await rpc(key, 'getAccountInfo', [pool, { encoding: 'base64' }]);
  const b64 = info && info.value && info.value.data && info.value.data[0];
  if (!b64) throw new Error('no pool data');
  const buf = Buffer.from(b64, 'base64');
  const decoded = getCoder().accounts.decode('VirtualPool', buf);
  return decoded.pool_state || decoded;
}

async function fetchMintMeta(key, mint) {
  // Helius DAS for name/symbol; fallback to unknowns.
  let name = 'Unknown', symbol = '???';
  try {
    const asset = await rpc(key, 'getAsset', [mint]);
    const c = (asset && asset.content) || {};
    const md = c.metadata || {};
    if (md.name) name = String(md.name).slice(0, 64);
    if (md.symbol) symbol = String(md.symbol).slice(0, 16);
  } catch { /* nicety */ }
  let supply = null, decimals = null;
  try {
    const ts = await rpc(key, 'getTokenSupply', [mint]);
    const v = ts && ts.value;
    if (v) {
      decimals = Number(v.decimals);
      supply = Number(v.amount) / Math.pow(10, decimals);
    }
  } catch { /* nicety */ }
  return { name, symbol, supply, decimals };
}

async function handleLaunch(key, signature) {
  // 1. tx → pool + quote mint
  const tx = await rpc(key, 'getTransaction', [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
  if (!tx || (tx.meta && tx.meta.err)) return;
  const found = findInitAccounts(tx);
  if (!found || !found.pool) return;

  // 2. pool state → price inputs
  const st = await fetchPoolState(key, found.pool);
  const baseMint = (st.base_mint && st.base_mint.toString()) || null;
  if (!baseMint || !noteSeen(baseMint)) return;
  const sqrtPrice = st.sqrt_price != null ? st.sqrt_price.toString() : null;
  if (!sqrtPrice) return;

  // 3. mint meta → supply/decimals/name
  const meta = await fetchMintMeta(key, baseMint);
  if (!(meta.decimals != null) || !(meta.supply > 0)) return;

  // 4. price → MC
  const quoteMint = found.quoteMint || USDC_MINT;
  const quoteDecimals = quoteMint === SOL_MINT ? 9 : 6;
  let price = null;
  try {
    price = Number(getPriceFromSqrtPrice(sqrtPrice, meta.decimals, quoteDecimals));
  } catch { /* bad math */ }
  if (!(price > 0)) return;
  let priceUsd = price;
  if (quoteMint === SOL_MINT) {
    try { priceUsd = price * (await solPrice()); } catch { return; }
  }
  const mc = priceUsd * meta.supply;
  if (!(mc > 0)) return;

  stats.launches++;
  stats.lastLaunchTs = Date.now();
  console.log(`[dbc] launch ${meta.symbol} ${baseMint.slice(0, 8)}… MC $${mc.toFixed(0)}`);
  try {
    onLaunchCb && onLaunchCb({
      mint: baseMint, pool: found.pool,
      name: meta.name, symbol: meta.symbol,
      price: priceUsd, mc, supply: meta.supply,
      quoteMint, ts: Date.now(), source: 'meteora-dbc',
    });
  } catch (e) { stats.errors++; }
}

// --- watcher --------------------------------------------------------------

export function startDbcWatch(onLaunch) {
  const key = getKey();
  if (!key) {
    console.log('[dbc] dormant — no HELIUS_API_KEY');
    return { stop() {}, active: false };
  }
  onLaunchCb = onLaunch;
  console.log('[dbc] watching Meteora DBC program for new pools');
  let alive = true;

  function connect() {
    if (!alive || Date.now() < retryAt) return;
    if (state === 'live' || state === 'probing') return;
    state = 'probing';
    try {
      ws = new WebSocket(`${WS_URL}?api-key=${encodeURIComponent(key)}`);
    } catch {
      scheduleRetry(); return;
    }
    const openTo = setTimeout(() => { try { ws && ws.close(); } catch {} }, 15000);

    ws.on('open', () => {
      clearTimeout(openTo);
      try {
        ws.send(JSON.stringify({
          jsonrpc: '2.0', id: reqId++,
          method: 'logsSubscribe',
          params: [{ mentions: [DBC_PROGRAM_ID] }, { commitment: 'confirmed' }],
        }));
      } catch { scheduleRetry(); }
    });

    ws.on('message', (data) => {
      let d = null;
      try { d = JSON.parse(data.toString()); } catch { return; }
      // subscription confirmation
      if (d.id && d.result != null && subId == null) {
        subId = d.result;
        state = 'live';
        backoffMs = RETRY_BASE;
        console.log('[dbc] live — DBC launch stream connected');
        return;
      }
      const v = d.params && d.params.result && d.params.result.value;
      if (!v || v.err) return;
      const logs = (v.logs || []).join('\n').toLowerCase();
      if (!logs.includes('initializevirtualpool') && !logs.includes('initialize_virtual_pool')) return;
      const sig = v.signature;
      if (!sig) return;
      handleLaunch(key, sig).catch(() => { stats.errors++; });
    });

    ws.on('close', () => { if (alive) scheduleRetry(); });
    ws.on('error', () => { try { ws && ws.close(); } catch {} });
  }

  connect();
  const timer = setInterval(connect, 10000);
  return {
    stop() { alive = false; clearInterval(timer); try { ws && ws.close(); } catch {} },
    active: true,
  };
}

// Live price/MC refresh for open DBC positions (pre-DexScreener).
export async function fetchDbcPrices(key, pools) {
  const out = {};
  let spx = null;
  for (const { mint, pool, quoteMint } of pools) {
    try {
      const st = await fetchPoolState(key, pool);
      const baseMint = (st.base_mint && st.base_mint.toString()) || mint;
      const sqrtPrice = st.sqrt_price != null ? st.sqrt_price.toString() : null;
      if (!sqrtPrice) continue;
      const meta = await fetchMintMeta(key, baseMint);
      if (!(meta.decimals != null) || !(meta.supply > 0)) continue;
      const qm = quoteMint || SOL_MINT;
      const quoteDecimals = qm === SOL_MINT ? 9 : 6;
      let price = Number(getPriceFromSqrtPrice(sqrtPrice, meta.decimals, quoteDecimals));
      if (!(price > 0)) continue;
      let priceUsd = price;
      if (qm === SOL_MINT) {
        if (spx == null) { try { spx = await solPrice(); } catch { break; } }
        priceUsd = price * spx;
      }
      out[mint] = { price: priceUsd, mc: priceUsd * meta.supply };
    } catch { /* one pool failing is fine */ }
  }
  return out;
}
