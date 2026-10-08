// PUMP.DIRECT (v3.25) — direct pump.fun bonding-curve buys via the official
// @pump-fun/pump-sdk. Skips the Jupiter quote round-trip (~200ms saved on entries).
//
// FAIL-CLOSED: every error throws and the caller (realexec) falls back to
// Jupiter. A failed direct buy costs nothing — it never sends.
//
// What it does:
//  1. Fetches global + bonding-curve + fee-config + user volume accumulator
//     + user ATA in one getMultipleAccounts call (RPC fallback chain).
//  2. Refuses graduated curves (complete=true), non-SOL quotes, mayhem coins.
//  3. Computes expected tokens out with the SDK's exact fee math.
//  4. Builds the buy instruction via the SDK (handles the post-2026-04-28
//     account layout: bondingCurveV2 PDA + buybackFeeRecipient automatically).
//  5. Prepends init_user_volume_accumulator when the PDA doesn't exist yet.

import {
  PUMP_SDK,
  PUMP_PROGRAM_ID,
  PUMP_FEE_CONFIG_PDA,
  PUMP_EVENT_AUTHORITY_PDA,
  GLOBAL_PDA,
  bondingCurvePda,
  userVolumeAccumulatorPda,
  getBuyTokenAmountFromSolAmount,
  normalizeQuoteMint,
  isSolLikeQuoteMint,
} from '@pump-fun/pump-sdk';
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import BN from 'bn.js';
import { getKey as heliusKey } from './helius.js';

const FALLBACK_RPCS = [
  'https://solana-rpc.publicnode.com',
  'https://api.mainnet-beta.solana.com',
];

function rpcUrls() {
  const k = heliusKey();
  const urls = [];
  if (k) urls.push(`https://mainnet.helius-rpc.com/?api-key=${k}`);
  return [...urls, ...FALLBACK_RPCS];
}

// Minimal JSON-RPC POST with the same fallback chain as realexec.
async function rpcPost(method, params) {
  let lastErr = null;
  for (const url of rpcUrls()) {
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
      catch { throw new Error('rpc: non-JSON response'); }
      if (j.error) throw new Error('rpc: ' + (j.error.message || 'unknown'));
      return j.result;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('rpc: all endpoints failed');
}

// init_user_volume_accumulator discriminator (from the pump.fun IDL).
const INIT_UVA_DISC = Buffer.from([94, 6, 202, 115, 255, 96, 232, 183]);

function toAccountInfo(raw) {
  if (!raw) return null;
  return { ...raw, data: Buffer.from(raw.data[0], 'base64') };
}

/** True when this mint is a pump.fun bonding-curve token. */
export function isPumpCurveMint(mint) {
  return typeof mint === 'string' && mint.endsWith('pump');
}

/**
 * Build the instruction list for a direct pump.fun buy.
 * @param {object} o - { mint, user, lamports, slippagePct }
 * @param {function} o.rpcPost - injectable RPC (defaults to internal fallback chain)
 * @returns {object} { instructions, expectedTokensOut, curveMc }
 * @throws on any condition that should fall back to Jupiter.
 */
export async function buildPumpBuy({ mint, user, lamports, slippagePct = 20 }, rpc = rpcPost) {
  if (!isPumpCurveMint(mint)) throw new Error('pumpdirect: not a pump mint');
  if (!(lamports > 0)) throw new Error('pumpdirect: bad lamports');

  const mintPk = new PublicKey(mint);
  const userPk = new PublicKey(user);
  const curvePk = bondingCurvePda(mintPk);
  const uvaPk = userVolumeAccumulatorPda(userPk);
  const ataPk = getAssociatedTokenAddressSync(mintPk, userPk, true, TOKEN_PROGRAM_ID);

  // One batched fetch: global, curve, feeConfig, userVolumeAccumulator, userATA.
  // Retry once on nulls — public RPCs occasionally return empty values.
  let rawGlobal, rawCurve, rawFeeConfig, rawUva, rawAta;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await rpc('getMultipleAccounts', [
      [GLOBAL_PDA.toBase58(), curvePk.toBase58(), PUMP_FEE_CONFIG_PDA.toBase58(), uvaPk.toBase58(), ataPk.toBase58()],
      { encoding: 'base64' },
    ]);
    [rawGlobal, rawCurve, rawFeeConfig, rawUva, rawAta] = (res && res.value) || [];
    if (rawCurve && rawGlobal && rawFeeConfig) break;
    if (attempt === 0) await new Promise(r => setTimeout(r, 1500));
  }
  if (!rawCurve) throw new Error('pumpdirect: no bonding curve (graduated or unknown) — use Jupiter');

  const globalInfo = toAccountInfo(rawGlobal);
  const curveInfo = toAccountInfo(rawCurve);
  const feeConfigInfo = toAccountInfo(rawFeeConfig);
  if (!globalInfo || !feeConfigInfo) throw new Error('pumpdirect: missing global/feeConfig');

  const global = PUMP_SDK.decodeGlobal(globalInfo);
  const curve = PUMP_SDK.decodeBondingCurve(curveInfo);
  const feeConfig = PUMP_SDK.decodeFeeConfig(feeConfigInfo);

  // Guard: graduated curves live on PumpSwap — Jupiter handles those.
  if (curve.complete) throw new Error('pumpdirect: curve complete (graduated) — use Jupiter');
  // Guard: only SOL-quoted curves. (USDC etc. quotes → Jupiter.)
  let quoteMint;
  try {
    quoteMint = normalizeQuoteMint(curve.quoteMint);
  } catch {
    throw new Error('pumpdirect: exotic quote mint — use Jupiter');
  }
  if (!isSolLikeQuoteMint(quoteMint)) throw new Error('pumpdirect: non-SOL quote — use Jupiter');
  if (!curve.virtualTokenReserves || curve.virtualTokenReserves.isZero()) {
    throw new Error('pumpdirect: empty curve — use Jupiter');
  }
  // Guard: mayhem-mode coins need reserved fee recipients the SDK helper
  // doesn't select — fail closed to Jupiter rather than send a bad tx.
  if (curve.isMayhemMode) throw new Error('pumpdirect: mayhem mode — use Jupiter');

  // Expected tokens out — SDK's exact fee math, conservative fallback.
  const lamportsBN = new BN(Math.floor(lamports));
  let expectedTokens;
  try {
    expectedTokens = getBuyTokenAmountFromSolAmount({
      global,
      feeConfig,
      mintSupply: curve.tokenTotalSupply,
      bondingCurve: curve,
      amount: lamportsBN,
      quoteMint,
      quoteControl: null,
      creatorFeeBps: curve.creatorFeeBps,
      pumpQuote: null,
    });
  } catch {
    expectedTokens = null;
  }
  if (!expectedTokens || expectedTokens.isZero()) {
    // Conservative constant-product estimate (5% haircut covers fees).
    const vT = curve.virtualTokenReserves;
    const vQ = curve.virtualQuoteReserves;
    expectedTokens = lamportsBN.mul(vT).div(vQ.add(lamportsBN)).muln(95).divn(100);
  }
  if (expectedTokens.isZero()) throw new Error('pumpdirect: zero expected output');
  // Safety haircut: ask for 97% of expected so cost stays under max_sol_cost.
  const amountTokens = expectedTokens.muln(97).divn(100);
  if (amountTokens.isZero()) throw new Error('pumpdirect: dust output');

  const instructions = [];

  // Init the user volume accumulator on first buy (idempotent check).
  if (!rawUva) {
    instructions.push(new TransactionInstruction({
      programId: PUMP_PROGRAM_ID,
      keys: [
        { pubkey: userPk, isSigner: true, isWritable: true },   // payer
        { pubkey: userPk, isSigner: false, isWritable: false },  // user
        { pubkey: uvaPk, isSigner: false, isWritable: true },    // user_volume_accumulator
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: PUMP_EVENT_AUTHORITY_PDA, isSigner: false, isWritable: false },
        { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: INIT_UVA_DISC,
    }));
  }

  // The buy itself — SDK builds the full 18-account layout (16 + V2 PDA +
  // buybackFeeRecipient as remainingAccounts) and creates the user ATA when
  // associatedUserAccountInfo is null.
  const buyIxs = await PUMP_SDK.buyInstructions({
    global,
    bondingCurveAccountInfo: curveInfo,
    bondingCurve: curve,
    associatedUserAccountInfo: rawAta ? toAccountInfo(rawAta) : null,
    mint: mintPk,
    user: userPk,
    amount: amountTokens,
    solAmount: lamportsBN,
    slippage: slippagePct, // SDK takes percent (20 = 20%)
    tokenProgram: TOKEN_PROGRAM_ID,
  });
  instructions.push(...buyIxs);

  // Approx curve MC for the book (virtualSol * supply / virtualToken).
  let curveMc = null;
  try {
    if (!curve.virtualTokenReserves.isZero()) {
      curveMc = Number(curve.virtualQuoteReserves.mul(curve.tokenTotalSupply).div(curve.virtualTokenReserves)) / 1e9;
    }
  } catch { /* nicety */ }

  return {
    instructions,
    expectedTokensOut: Number(amountTokens.toString()),
    curveMc,
  };
}
