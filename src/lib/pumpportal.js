// PumpPortal free websocket feed — wss://pumpportal.fun/api/data.
// Server-side edition using the `ws` package. Same protocol as the frontend:
// send {"method":"subscribeNewToken"} → receive { txType:"create", ... }.
// Mints buffer into the NEW feed. Fail-open with exponential backoff.

import WebSocket from 'ws';

const WS_URL = 'wss://pumpportal.fun/api/data';
const CONNECT_MS = 10000;
const LISTEN_MS = 20000;
const BUF_CAP = 60;
const RETRY_BASE = 30000;
const RETRY_MAX = 10 * 60 * 1000;

let ws = null;
let state = 'idle'; // idle | probing | live | dead
let retryAt = 0;
let backoffMs = RETRY_BASE;
const buf = [];
const seen = new Set();

export function pumpPortalState() { return state; }

export function getPumpPortalMints() {
  const now = Date.now();
  while (buf.length && now - buf[0].ts > 15 * 60 * 1000) {
    const old = buf.shift();
    seen.delete(old.mint);
  }
  return buf.slice();
}

function note(mint, symbol, name, creator) {
  if (!mint || typeof mint !== 'string' || mint.length < 32 || seen.has(mint)) return;
  seen.add(mint);
  buf.push({ mint, symbol: symbol || null, name: name || null, creator: creator || null, ts: Date.now() });
  if (buf.length > BUF_CAP) {
    const old = buf.shift();
    seen.delete(old.mint);
  }
}

function scheduleRetry() {
  state = 'dead';
  try { ws && ws.close(); } catch { /* noop */ }
  ws = null;
  retryAt = Date.now() + backoffMs;
  backoffMs = Math.min(backoffMs * 2, RETRY_MAX);
}

export function probePumpPortal() {
  if (state === 'live' || state === 'probing') return;
  if (Date.now() < retryAt) return;
  state = 'probing';
  let settled = false;
  const to = setTimeout(() => finish(false), CONNECT_MS + LISTEN_MS);
  const finish = (ok) => {
    if (settled) return;
    settled = true;
    clearTimeout(to);
    if (ok) {
      state = 'live';
      backoffMs = RETRY_BASE;
      console.log('[pumpportal] live — new-token stream connected');
    } else {
      scheduleRetry();
    }
  };
  try {
    ws = new WebSocket(WS_URL, { handshakeTimeout: CONNECT_MS });
  } catch {
    finish(false);
    return;
  }
  ws.on('open', () => {
    try { ws.send(JSON.stringify({ method: 'subscribeNewToken' })); }
    catch { finish(false); }
  });
  ws.on('message', (data) => {
    let d = null;
    try { d = JSON.parse(data.toString()); } catch { return; }
    if (!d || d.txType !== 'create' || !d.mint) return;
    note(d.mint, d.symbol, d.name, d.traderPublicKey);
    finish(true);
  });
  ws.on('error', () => finish(false));
  ws.on('close', () => {
    if (!settled) finish(false);
    else if (state === 'live') scheduleRetry();
  });
}
