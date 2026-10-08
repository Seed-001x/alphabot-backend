// REAL EXECUTION (v3.25) — real-money SOL↔token swaps.
// Entries: direct pump.fun bonding-curve buys via the official @pump-fun/pump-sdk
// (no Jupiter quote round-trip, ~200ms faster). Falls back to Jupiter v1.
// Exits: Jupiter v1 (better routing on the way out).
// Broadcast: dual-route fan-out — Helius Sender + Jito block engine + RPC chain,
// first success wins. Priority fee 0.001 SOL + 0.001 SOL Jito tip on direct buys.
//
// SECURITY:
// - Wallet key comes ONLY from REAL_WALLET_KEY env (base58 private key).
// - The key is NEVER logged, NEVER returned, NEVER committed.
// - Fail closed: any error → throws, no partial state.

import {
  Keypair, VersionedTransaction, TransactionMessage,
  ComputeBudgetProgram, SystemProgram, PublicKey,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { getKey as heliusKey, SOL_MINT } from './helius.js';
import { floorEmit } from './events.js';
import { buildPumpBuy, isPumpCurveMint } from './pumpdirect.js';

const JUP_QUOTE = 'https://api.jup.ag/swap/v1/quote';
const JUP_SWAP = 'https://api.jup.ag/swap/v1/swap';
const HELIUS_SENDER = 'https://sender.helius-rpc.com/fast';
const JITO_ENGINE = 'https://mainnet.block-engine.jito.wtf/api/v1/transactions';

// v3.25: 0.001 SOL priority fee per transaction (user-approved bump from 0.0009).
export const PRIORITY_FEE_LAMPORTS = 1000000;
// Jito tip for the dual-route path (standard tier per research).
export const JITO_TIP_LAMPORTS = 1000000;
// Jito tip account (from Jito's official examples; overridable via JITO_TIP_ACCOUNT env).
const JITO_TIP_ACCOUNT = process.env.JITO_TIP_ACCOUNT || '96gYZGLnJYVFmbjzopPSU6QiEV5fGqXkGuYc9p7fSKdZ';

// v3.24: fetch with retry — Jupiter can flake, don't fail a real trade on one bad request
async function fetchRetry(url, opts = {}, retries = 3) {
  let lastErr = null;
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, opts);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r;
    } catch (e) {
      lastErr = e;
      if (i < retries - 1) {
        await new Promise(r => setTimeout(r, 1000 * (i + 1))); // 1s, 2s backoff
      }
    }
  }
  throw lastErr || new Error('fetch failed after retries');
}

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

const FALLBACK_RPCS = [
  'https://solana-rpc.publicnode.com',
  'https://api.mainnet-beta.solana.com',
];

function rpcUrl() {
  const k = heliusKey();
  if (!k) throw new Error('realexec: HELIUS_API_KEY not set');
  return `https://mainnet.helius-rpc.com/?api-key=${k}`;
}

/** JSON-RPC POST with RPC fallback chain. Exported for pumpdirect injection. */
export async function rpcPost(method, params, timeoutMs = 15000) {
  const urls = [];
  try { urls.push(rpcUrl()); } catch {}
  urls.push(...FALLBACK_RPCS);
  let lastErr = null;
  for (const url of urls) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
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
    }
  }
  throw lastErr || new Error('rpc: all endpoints failed');
}

export async function jupQuote(inputMint, outputMint, amount, slippageBps) {
  const u = `${JUP_QUOTE}?inputMint=${inputMint}&outputMint=${outputMint}` +
    `&amount=${amount}&slippageBps=${slippageBps}&onlyDirectRoutes=false`;
  const r = await fetchRetry(u, { signal: AbortSignal.timeout(15000) });
  const q = await r.json();
  if (!q || !q.outAmount) throw new Error('jupiter: no route');
  return q;
}

async function jupSwapTx(quoteResponse, userPublicKey, prioritizationFeeLamports) {
  const r = await fetchRetry(JUP_SWAP, {
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
  const j = await r.json();
  if (!j || !j.swapTransaction) throw new Error('jupiter: no swap transaction');
  return j.swapTransaction; // base64 VersionedTransaction
}

// ------------------------------------------------------------ dual-route send
// v3.25: fan-out broadcast. The SAME signed transaction goes to:
//   1. Helius Sender (dual-routes staked validators + Jito internally)
//   2. Jito block engine directly
//   3. Standard RPC chain (Helius → publicnode → mainnet-beta)
// First success wins — same tx = same signature everywhere, so duplicates are
// harmless (the network dedupes by signature).
async function sendVia(name, url, signedB64, extraParams = {}) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'sendTransaction',
      params: [signedB64, { encoding: 'base64', maxRetries: 2, preflightCommitment: 'confirmed', ...extraParams }],
    }),
  });
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); }
  catch { throw new Error(`${name}: non-JSON response`); }
  if (j.error) throw new Error(`${name}: ${j.error.message || JSON.stringify(j.error)}`);
  if (!j.result) throw new Error(`${name}: no signature`);
  return j.result;
}

async function sendDualRoute(signedB64) {
  const attempts = [];
  // 1. Helius Sender — dual-routes staked validators + Jito. Requires the
  //    Sender add-on on the key; if the key lacks it this fails and we move on.
  if (heliusKey()) {
    attempts.push({
      name: 'helius-sender',
      fn: () => sendVia('helius-sender', `${HELIUS_SENDER}?api-key=${heliusKey()}`, signedB64),
    });
  }
  // 2. Jito block engine directly.
  attempts.push({
    name: 'jito',
    fn: () => sendVia('jito', JITO_ENGINE, signedB64),
  });
  // 3. Standard RPC chain (sequential fallbacks inside).
  attempts.push({
    name: 'rpc-chain',
    fn: async () => {
      const urls = [];
      try { urls.push(rpcUrl()); } catch {}
      urls.push(...FALLBACK_RPCS);
      let lastErr = null;
      for (const url of urls) {
        try {
          return await sendVia('rpc', url, signedB64);
        } catch (e) { lastErr = e; }
      }
      throw lastErr || new Error('rpc-chain: all failed');
    },
  });

  const results = await Promise.allSettled(attempts.map(a =>
    a.fn().then(sig => ({ name: a.name, sig }))
  ));
  const wins = results
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value);
  const fails = results
    .filter(r => r.status === 'rejected')
    .map(r => String(r.reason && r.reason.message || r.reason));
  if (wins.length) {
    console.log(`[realexec] sent via ${wins.map(w => w.name).join('+')} → ${wins[0].sig}`);
    return wins[0].sig;
  }
  throw new Error('send: all routes failed — ' + fails.join(' | ').slice(0, 300));
}

async function confirmTx(sig, timeoutMs = 45000) {
  const t0 = Date.now();
  const urls = [];
  try { urls.push(rpcUrl()); } catch {}
  urls.push(...FALLBACK_RPCS);
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

/** Priority-fee instructions: ~0.001 SOL total at 300k compute units. */
function priorityFeeIxs() {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }),
    // 1_000_000 lamports ≈ microLamports * units / 1e6 → 3_333_333 * 300_000 / 1e6 ≈ 1_000_000
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 3333333 }),
  ];
}

/** Jito tip instruction — 0.001 SOL to a Jito tip account. */
function jitoTipIx(fromPubkey, lamports = JITO_TIP_LAMPORTS) {
  return SystemProgram.transfer({
    fromPubkey,
    toPubkey: new PublicKey(JITO_TIP_ACCOUNT),
    lamports,
  });
}

async function simulateOrThrow(signedB64) {
  const res = await rpcPost('simulateTransaction', [
    signedB64,
    { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: false, commitment: 'confirmed' },
  ], 20000);
  if (res && res.err) {
    const logs = (res.logs || []).slice(-6).join(' | ');
    throw new Error('simulation failed: ' + JSON.stringify(res.err).slice(0, 200) + ' :: ' + logs.slice(0, 300));
  }
  return true;
}

/**
 * Direct pump.fun buy — builds the tx locally via the official SDK, signs,
 * simulates, and dual-route broadcasts. Throws on any problem (caller falls
 * back to Jupiter).
 */
async function buyPumpDirect(mint, solAmount, opts = {}) {
  const kp = loadKeypair();
  const userPk = kp.publicKey;
  const lamports = Math.floor(solAmount * 1e9);
  const slippagePct = Math.round(((opts.slippageBps ?? DEFAULT_SLIPPAGE_BPS) / 10000) * 100);

  const { instructions: buyIxs, expectedTokensOut } = await buildPumpBuy(
    { mint, user: userPk.toBase58(), lamports, slippagePct },
    rpcPost,
  );

  const tipLamports = opts.jitoTipLamports ?? JITO_TIP_LAMPORTS;
  const ixs = [
    ...priorityFeeIxs(),
    ...(tipLamports > 0 ? [jitoTipIx(userPk, tipLamports)] : []),
    ...buyIxs,
  ];

  const { value } = await rpcPost('getLatestBlockhash', [{ commitment: 'confirmed' }], 15000);
  const blockhash = value.blockhash;
  const msg = new TransactionMessage({
    payerKey: userPk, recentBlockhash: blockhash, instructions: ixs,
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([kp]);
  const signedB64 = Buffer.from(tx.serialize()).toString('base64');

  // Simulate first — a bad instruction layout must never hit the network
  // as a real attempt (it would still fail closed, but sim is cheaper).
  await simulateOrThrow(signedB64);

  const sig = await sendDualRoute(signedB64);
  await confirmTx(sig);
  floorEmit('real.buy', { mint, solAmount, sig, quotedOut: expectedTokensOut, route: 'pump-direct' });

  // Actual tokens received — read the user's ATA post-confirm (retries).
  let tokensOut = expectedTokensOut / 1e6;
  try {
    const { getAssociatedTokenAddressSync: getAta } = await import('@solana/spl-token');
    const { TOKEN_PROGRAM_ID: TPID } = await import('@solana/spl-token');
    const ata = getAta(new PublicKey(mint), userPk, true, TPID);
    for (let i = 0; i < 4; i++) {
      try {
        const bal = await rpcPost('getTokenAccountBalance', [ata.toBase58()], 10000);
        const raw = Number(bal?.value?.amount || 0);
        const dec = Number(bal?.value?.decimals || 6);
        if (raw > 0) { tokensOut = raw / Math.pow(10, dec); break; }
      } catch {}
      await new Promise(r => setTimeout(r, 1500));
    }
  } catch {}

  return { sig, quotedOut: Math.round(tokensOut * 1e6), fillPriceSol: solAmount / Math.max(1e-9, tokensOut), route: 'pump-direct' };
}

/**
 * Buy a token with SOL. Fail-closed: any error → throws, no partial state.
 * Route: direct pump.fun buy for bonding-curve mints, Jupiter v1 otherwise
 * (or when the direct path fails).
 * @param {string} mint - token mint
 * @param {number} solAmount - SOL to spend (not lamports)
 * @param {object} opts - { slippageBps, priorityFeeLamports, jitoTipLamports }
 * @returns {object} { sig, tokensOut, fillPriceSol, quotedOut, route }
 */
export async function buyToken(mint, solAmount, opts = {}) {
  const slippageBps = opts.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const priorityFee = opts.priorityFeeLamports ?? PRIORITY_FEE_LAMPORTS; // 0.001 SOL
  const lamports = Math.floor(solAmount * 1e9);
  if (!(lamports > 0)) throw new Error('realexec: bad solAmount');

  // v3.25: direct pump.fun buy first — no Jupiter round-trip.
  if (isPumpCurveMint(mint)) {
    try {
      const r = await buyPumpDirect(mint, solAmount, { slippageBps, jitoTipLamports: opts.jitoTipLamports });
      console.log(`[realexec] pump-direct BUY ${mint.slice(0, 8)}… ${solAmount} SOL → ${r.sig}`);
      return r;
    } catch (e) {
      console.error(`[realexec] pump-direct failed (${e.message}) — falling back to Jupiter`);
      floorEmit('real.route_fallback', { mint, from: 'pump-direct', to: 'jupiter', error: e.message });
    }
  }

  const quote = await jupQuote(SOL_MINT, mint, lamports, slippageBps);
  const quotedOut = Number(quote.outAmount);
  const swapB64 = await jupSwapTx(quote, realWalletAddress(), priorityFee);
  // Sign Jupiter's tx and dual-route broadcast.
  const kp = loadKeypair();
  const tx = VersionedTransaction.deserialize(Buffer.from(swapB64, 'base64'));
  tx.sign([kp]);
  const signed = Buffer.from(tx.serialize()).toString('base64');
  const sig = await sendDualRoute(signed);
  await confirmTx(sig);

  floorEmit('real.buy', { mint, solAmount, sig, quotedOut, route: 'jupiter' });
  // v3.24: fillPriceSol in SOL per token — quotedOut is raw units (6 decimals for pump.fun)
  const tokensOut = quotedOut / 1e6;
  return { sig, quotedOut, fillPriceSol: solAmount / Math.max(1e-9, tokensOut), route: 'jupiter' };
}

/**
 * Sell a token for SOL (Jupiter v1 — best routing on exits).
 * @param {string} mint - token mint
 * @param {string} tokenAccountAmount - raw token amount (base units) to sell
 * @param {number} decimals - token decimals
 * @returns {object} { sig, solOut, quotedOut }
 */
export async function sellToken(mint, rawAmount, decimals, opts = {}) {
  const slippageBps = opts.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const priorityFee = opts.priorityFeeLamports ?? PRIORITY_FEE_LAMPORTS; // 0.001 SOL
  if (!(Number(rawAmount) > 0)) throw new Error('realexec: bad token amount');

  const quote = await jupQuote(mint, SOL_MINT, String(rawAmount), slippageBps);
  const quotedOut = Number(quote.outAmount);
  const swapB64 = await jupSwapTx(quote, realWalletAddress(), priorityFee);
  const kp = loadKeypair();
  const tx = VersionedTransaction.deserialize(Buffer.from(swapB64, 'base64'));
  tx.sign([kp]);
  const signed = Buffer.from(tx.serialize()).toString('base64');
  const sig = await sendDualRoute(signed);
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
export async function realWalletState(mints = []) {
  const addr = realWalletAddress();
  if (!addr) throw new Error('realexec: no wallet configured');
  const solLamports = (await rpcPost('getBalance', [addr])).value;
  const tokens = {};
  for (const mint of mints) {
    try {
      const res = await rpcPost('getTokenAccountsByOwner', [
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
