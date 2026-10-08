// LIVEFEED (v3.25) — real-time price feed via Helius Enhanced WebSockets.
// Subscribes to pump.fun bonding-curve accounts for open real positions.
// Every curve trade updates virtual reserves → we recompute price/MC from
// the curve itself (~1s updates) instead of waiting for the 15s DexScreener
// poll. Fail-open: if WS drops, the polling path keeps working.
//
// Only pump.fun curve tokens (mint ends with 'pump') get WS subs — other
// tokens keep the DexScreener/pump.fun pollers.

import WebSocket from 'ws';
import {
  PUMP_SDK, bondingCurvePda, bondingCurveMarketCap,
} from '@pump-fun/pump-sdk';
import { PublicKey } from '@solana/web3.js';
import { getKey as heliusKey } from './helius.js';
import { getRealBook } from './realbook.js';
import { solPrice } from './dexscreener.js';
import { isPumpCurveMint } from './pumpdirect.js';

const WS_URL = () => `wss://mainnet.helius-rpc.com/?api-key=${heliusKey()}`;

// Per-mint live quotes from the WS: mint -> { price, mc, ts }
const liveQuotes = {};
// mint -> subscription id
const subs = new Map();

let ws = null;
let wsReady = false;
let reqId = 1;
let reconnectDelay = 5000;
let lastMsgTs = 0;
let wantStop = false;
let spxCache = { v: 150, ts: 0 };

const status = {
  connected: false,
  subscriptions: 0,
  lastMsgTs: 0,
  reconnects: 0,
  errors: 0,
};

export function liveFeedStatus() {
  return { ...status, subscriptions: subs.size, quotes: Object.keys(liveQuotes).length };
}

/** Latest WS quote for a mint (or null). */
export function liveQuote(mint) {
  return liveQuotes[mint] || null;
}

async function getSpx() {
  if (Date.now() - spxCache.ts < 120000) return spxCache.v;
  try {
    spxCache.v = await solPrice();
    spxCache.ts = Date.now();
  } catch {}
  return spxCache.v;
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: reqId++, ...obj }));
    return reqId - 1;
  }
  return null;
}

function handleAccountNotification(msg) {
  try {
    const params = msg.params;
    if (!params || params.subscription == null) return;
    const value = params.result && params.result.value;
    if (!value || !value.data) return;
    const buf = Buffer.from(value.data[0], 'base64');
    const curve = PUMP_SDK.decodeBondingCurve({ data: buf });
    if (!curve || curve.complete) return;
    if (curve.virtualTokenReserves.isZero()) return;

    // Find which mint this curve belongs to (reverse lookup).
    let mint = null;
    for (const [m, subId] of subs) {
      if (subId === params.subscription) { mint = m; break; }
    }
    if (!mint) return;

    // MC in lamports via the SDK's canonical formula.
    const mcLamports = bondingCurveMarketCap({
      mintSupply: curve.tokenTotalSupply,
      virtualQuoteReserves: curve.virtualQuoteReserves,
      virtualTokenReserves: curve.virtualTokenReserves,
    });
    const spx = spxCache.v;
    const mc = Number(mcLamports.toString()) / 1e9 * spx;
    const supplyUi = Number(curve.tokenTotalSupply.toString()) / 1e6;
    const price = supplyUi > 0 ? mc / supplyUi : null;
    if (!(mc > 0)) return;

    liveQuotes[mint] = { price, mc, ts: Date.now(), src: 'ws' };
    lastMsgTs = Date.now();
    status.lastMsgTs = lastMsgTs;
  } catch (e) {
    // A bad decode must never kill the feed.
  }
}

function connect() {
  if (wantStop) return;
  const key = heliusKey();
  if (!key) {
    console.log('[livefeed] no HELIUS_API_KEY — WS feed disabled (polling only)');
    return;
  }
  console.log('[livefeed] connecting to Helius WS…');
  try { ws = new WebSocket(WS_URL(), { handshakeTimeout: 15000 }); }
  catch (e) {
    console.error('[livefeed] WS create failed:', e.message);
    scheduleReconnect();
    return;
  }

  ws.on('open', () => {
    console.log('[livefeed] WS connected');
    wsReady = true;
    status.connected = true;
    status.reconnects += 1;
    reconnectDelay = 5000;
    // Resubscribe everything (server forgets subs on reconnect).
    const mints = [...subs.keys()];
    subs.clear();
    for (const m of mints) subscribeCurve(m);
  });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.method === 'accountNotification') {
      handleAccountNotification(msg);
      return;
    }
    // Track subscription confirmations: result = sub id, matched by request id.
    if (msg.id && msg.result != null && pendingSubs.has(msg.id)) {
      const mint = pendingSubs.get(msg.id);
      pendingSubs.delete(msg.id);
      subs.set(mint, msg.result);
      status.subscriptions = subs.size;
      console.log(`[livefeed] subscribed ${mint.slice(0, 8)}… (sub ${msg.result})`);
    }
  });

  ws.on('close', () => {
    wsReady = false;
    status.connected = false;
    console.log('[livefeed] WS closed — reconnecting');
    scheduleReconnect();
  });

  ws.on('error', (e) => {
    status.errors += 1;
    console.error('[livefeed] WS error:', e.message);
    try { ws.close(); } catch {}
  });

  // Keep-alive ping.
  const pingTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.ping(); } catch {}
    } else {
      clearInterval(pingTimer);
    }
  }, 30000);
}

const pendingSubs = new Map();

function scheduleReconnect() {
  if (wantStop) return;
  wsReady = false;
  status.connected = false;
  setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 2, 120000);
    connect();
  }, reconnectDelay);
}

function subscribeCurve(mint) {
  if (!wsReady) return;
  if (subs.has(mint) || [...pendingSubs.values()].includes(mint)) return;
  try {
    const curvePk = bondingCurvePda(new PublicKey(mint));
    const id = send({
      method: 'accountSubscribe',
      params: [curvePk.toBase58(), { encoding: 'base64', commitment: 'confirmed' }],
    });
    if (id) pendingSubs.set(id, mint);
  } catch (e) {
    console.error('[livefeed] subscribe failed for', mint.slice(0, 8), e.message);
  }
}

function unsubscribeCurve(mint) {
  const subId = subs.get(mint);
  subs.delete(mint);
  delete liveQuotes[mint];
  if (subId != null && wsReady) {
    send({ method: 'accountUnsubscribe', params: [subId] });
  }
}

/**
 * Reconcile subscriptions with the real book's open positions.
 * Called each priceTick — subscribes new pump positions, drops closed ones.
 */
export function syncLiveFeed() {
  try {
    const R = getRealBook();
    const openMints = new Set(
      ((R && R.positions) || []).map(p => p.mint).filter(isPumpCurveMint)
    );
    // Drop stale quotes for closed positions.
    for (const m of Object.keys(liveQuotes)) {
      if (!openMints.has(m)) delete liveQuotes[m];
    }
    for (const [m] of subs) {
      if (!openMints.has(m)) unsubscribeCurve(m);
    }
    for (const m of [...pendingSubs.values()]) {
      if (!openMints.has(m)) {
        for (const [id, pm] of pendingSubs) if (pm === m) pendingSubs.delete(id);
      }
    }
    if (!wsReady) return;
    for (const m of openMints) subscribeCurve(m);
  } catch (e) {
    console.error('[livefeed] sync failed:', e.message);
  }
}

/** Start the feed (idempotent). */
export function startLiveFeed() {
  if (ws) return;
  getSpx().catch(() => {});
  setInterval(() => getSpx().catch(() => {}), 120000);
  connect();
}

export function stopLiveFeed() {
  wantStop = true;
  try { ws && ws.close(); } catch {}
  ws = null;
}
