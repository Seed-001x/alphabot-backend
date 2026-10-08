// REAL EXECUTION (v3.24) — real-money SOL↔token swaps via Jupiter.
// One integration point: Jupiter's swap API routes across pump.fun,
// Raydium, Meteora, etc. Helius RPC sends with priority fees.
//
// SECURITY:
// - Wallet key comes ONLY from REAL_WALLET_KEY env (base58 private key).
// - The key is NEVER logged, NEVER returned, NEVER committed.
// - If Jupiter is unreachable → fail closed (no trade), never fall back
//   to a different route silently.

import { Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { getKey as heliusKey, SOL_MINT } from './helius.js';
import { floorEmit } from './events.js';

const JUP_QUOTE = 'https://quote-api.jup.ag/v6/quote';
const JUP_SWAP = 'https://quote-api.jup.ag/v6/swap';

// User's paper default — real trades use the same slippage tolerance.
const DEFAULT_SLIPPAGE_BPS = 2000; // 20%

let _keypair = null;
let _pubkeyStr = null;

function loadKeypair() {
  if (_keypair) return _keypair;
  const raw = (process.env.REAL_WALLET_KEY || '').trim();
  if (!raw) throw new Error('realexec: REAL_WALLET_KEY not set');
  try {
    const secret = bs58.decode(raw);
    _keypair = Keypair.fromSecretKey(secret);
    _pubkeyStr = _keypair.publicKey.toBase58();
  } catch {
    throw new Error('realexec: REAL_WALLET_KEY is not a valid base58 private key');
  }
  return _keypair;
}

/** Public wallet address (safe to expose — never the private key). */
export function realWalletAddress() {
  try {
    loadKeypair();
    return _pubkeyStr;
  } catch {
    return null;
  }
}

export function realExecReady() {
  return !!(process.env.REAL_WALLET_KEY || '').trim() && !!heliusKey();
}

function rpcUrl() {
  const k = heliusKey();
  if (!k) throw new Error('realexec: HELIUS_API_KEY not set');
  return `https://mainnet.helius-rpc.com/?api-key=${k}`;
}

async function jupQuote(inputMint, outputMint, amount, slippageBps) {
  const u = `${JUP_QUOTE}?inputMint=${inputMint}&outputMint=${outputMint}` +
    `&amount=${amount}&slippageBps=${slippageBps}&onlyDirectRoutes=false`;
  const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`jupiter quote failed: ${r.status}`);
  const q = await r.json();
  if (!q || !q.outAmount) throw new Error('jupiter: no route');
  return q;
}

async function jupSwapTx(quoteResponse, userPublicKey, prioritizationFeeLamports) {
  const r = await fetch(JUP_SWAP, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(20000),
    body: JSON.stringify({
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: true,
      prioritizationFeeLamports,
      dynamicComputeUnitLimit: true,
    }),
  });
  if (!r.ok) throw new Error(`jupiter swap failed: ${r.status}`);
  const j = await r.json();
  if (!j || !j.swapTransaction) throw new Error('jupiter: no swap transaction');
  return j.swapTransaction; // base64 VersionedTransaction
}

async function sendSigned(base64Tx) {
  const kp = loadKeypair();
  const buf = Buffer.from(base64Tx, 'base64');
  const tx = VersionedTransaction.deserialize(buf);
  tx.sign([kp]);
  const signed = Buffer.from(tx.serialize()).toString('base64');
  const urls = [rpcUrl(), ...FALLBACK_RPCS];
  let lastErr = null;
  for (const url of urls) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(30000),
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'sendTransaction',
          params: [signed, { encoding: 'base64', maxRetries: 2, preflightCommitment: 'confirmed' }],
        }),
      });
      if (!r.ok) throw new Error(`rpc send failed: ${r.status}`);
      const text = await r.text();
      let j;
      try { j = JSON.parse(text); }
      catch { throw new Error('rpc: non-JSON response (' + text.slice(0, 60) + ')'); }
      if (j.error) throw new Error(`rpc error: ${j.error.message || JSON.stringify(j.error)}`);
      return j.result; // signature
    } catch (e) {
      lastErr = e;
      console.error(`[realexec] send via ${url.slice(8, 32)}... failed: ${e.message} — trying fallback`);
    }
  }
  throw lastErr || new Error('rpc send: all endpoints failed');
}

async function confirmTx(sig, timeoutMs = 45000) {
  const t0 = Date.now();
  const urls = [rpcUrl(), ...FALLBACK_RPCS];
  while (Date.now() - t0 < timeoutMs) {
    for (const url of urls) {
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(10000),
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'getSignatureStatuses',
            params: [[sig], { searchTransactionHistory: true }],
          }),
        });
        const j = await r.json();
        const st = j?.result?.value?.[0];
        if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) {
          if (st.err) throw new Error('tx failed on-chain: ' + JSON.stringify(st.err));
          return true;
        }
        break; // endpoint worked, tx just not confirmed yet — wait and retry
      } catch (e) {
        if (e.message && e.message.startsWith('tx failed')) throw e;
        // try next fallback RPC
      }
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('tx confirmation timeout: ' + sig);
}

/**
 * Buy a token with SOL. Fail-closed: any error → throws, no partial state.
 * @param {string} mint - token mint
 * @param {number} solAmount - SOL to spend (not lamports)
 * @param {object} opts - { slippageBps, priorityFeeLamports }
 * @returns {object} { sig, tokensOut, fillPriceSol, quotedOut }
 */
export async function buyToken(mint, solAmount, opts = {}) {
  const slippageBps = opts.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const priorityFee = opts.priorityFeeLamports ?? 500000; // 0.0005 SOL — fast inclusion preset
  const lamports = Math.floor(solAmount * 1e9);
  if (!(lamports > 0)) throw new Error('realexec: bad solAmount');

  const quote = await jupQuote(SOL_MINT, mint, lamports, slippageBps);
  const quotedOut = Number(quote.outAmount);
  const swapB64 = await jupSwapTx(quote, realWalletAddress(), priorityFee);
  const sig = await sendSigned(swapB64);
  await confirmTx(sig);

  // Fill price from the quote's output (actual on-chain may vary slightly;
  // the confirmed tx is the source of truth — signature recorded).
  const tokensOut = quotedOut / 1e9; // NOTE: assumes 9 decimals — refined below
  void tokensOut;

  floorEmit('real.buy', { mint, solAmount, sig, quotedOut });
  return { sig, quotedOut, fillPriceSol: lamports / Math.max(1, quotedOut) };
}

/**
 * Sell a token for SOL.
 * @param {string} mint - token mint
 * @param {string} tokenAccountAmount - raw token amount (base units) to sell
 * @param {number} decimals - token decimals
 * @returns {object} { sig, solOut, quotedOut }
 */
export async function sellToken(mint, rawAmount, decimals, opts = {}) {
  const slippageBps = opts.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const priorityFee = opts.priorityFeeLamports ?? 500000; // 0.0005 SOL — fast inclusion preset
  if (!(Number(rawAmount) > 0)) throw new Error('realexec: bad token amount');

  const quote = await jupQuote(mint, SOL_MINT, String(rawAmount), slippageBps);
  const quotedOut = Number(quote.outAmount);
  const swapB64 = await jupSwapTx(quote, realWalletAddress(), priorityFee);
  const sig = await sendSigned(swapB64);
  await confirmTx(sig);

  floorEmit('real.sell', { mint, sig, quotedOut });
  return { sig, quotedOut, solOut: quotedOut / 1e9 };
}

/**
 * Get the real wallet's SOL balance + token balances for open positions.
 * Used by the real book for equity + kill-switch checks.
 * v3.24: RPC fallback chain — Helius free tier can hit "max usage reached",
 * so fall through to public RPCs instead of failing the entire real path.
 */
const FALLBACK_RPCS = [
  'https://solana-rpc.publicnode.com',
  'https://api.mainnet-beta.solana.com',
];

export async function realWalletState(mints = []) {
  const addr = realWalletAddress();
  if (!addr) throw new Error('realexec: no wallet configured');
  const urls = [rpcUrl(), ...FALLBACK_RPCS];
  const post = async (method, params) => {
    let lastErr = null;
    for (const url of urls) {
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(15000),
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        });
        const text = await r.text();
        let j;
        try { j = JSON.parse(text); }
        catch { throw new Error('rpc: non-JSON response (' + text.slice(0, 60) + ')'); }
        if (j.error) throw new Error('rpc: ' + (j.error.message || 'unknown'));
        return j.result;
      } catch (e) {
        lastErr = e;
        console.error(`[realexec] RPC ${url.slice(8, 32)}... failed: ${e.message} — trying fallback`);
      }
    }
    throw lastErr || new Error('rpc: all endpoints failed');
  };
  const solLamports = (await post('getBalance', [addr])).value;
  const tokens = {};
  for (const mint of mints) {
    try {
      const res = await post('getTokenAccountsByOwner', [
        addr, { mint }, { encoding: 'jsonParsed' },
      ]);
      const accs = res.value || [];
      let raw = 0, decimals = 0;
      for (const a of accs) {
        const info = a.account?.data?.parsed?.info?.tokenAmount;
        if (info) { raw += Number(info.amount || 0); decimals = info.decimals || decimals; }
      }
      tokens[mint] = { raw, decimals };
    } catch { tokens[mint] = { raw: 0, decimals: 0 }; }
  }
  return { sol: solLamports / 1e9, tokens, address: addr };
}
