// v3.29 TOKEN REGISTRY — lightweight lifecycle tracking for discovered tokens.
// A token shouldn't disappear just because it didn't meet entry criteria when
// it first appeared. It might become interesting five minutes later.
//
// Lifecycle: DISCOVERED → TRACKING → (vetted) → WATCHLIST/ENTRY CANDIDATE...
// This registry covers DISCOVERED/TRACKING: it remembers every mint the
// scanner has seen, when it was last vetted, and at what MC.
//
// Rules:
//  - Never vetted → vet it.
//  - Vetted + rejected < 5 min ago → skip (cooldown), UNLESS MC moved >20%
//    since the last vet (it might be a runner now → re-vet immediately).
//  - Vetted + rejected ≥ 5 min ago → vet again (fresh look).
//  - Entries are pruned after 24h of no sightings.

const VET_COOLDOWN_MS = 5 * 60 * 1000;
const MC_MOVE_PCT = 20;
const PRUNE_AFTER_MS = 24 * 3600 * 1000;

const reg = new Map(); // mint -> { firstSeen, lastSeen, lastVetTs, lastMc, vetCount, lastVerdict }

/** Record that the scanner saw this mint at this MC. */
export function registryTouch(mint, mc) {
  if (!mint) return;
  const now = Date.now();
  const e = reg.get(mint);
  if (e) {
    e.lastSeen = now;
    if (mc > 0) e.lastMc = mc;
  } else {
    reg.set(mint, { firstSeen: now, lastSeen: now, lastVetTs: 0, lastMc: mc > 0 ? mc : 0, vetCount: 0, lastVerdict: null });
  }
  if (reg.size > 5000) {
    // prune oldest lastSeen
    let oldest = null, oldestTs = Infinity;
    for (const [k, v] of reg) {
      if (v.lastSeen < oldestTs) { oldestTs = v.lastSeen; oldest = k; }
    }
    if (oldest) reg.delete(oldest);
  }
}

/** Should this mint go through the vet kill chain right now? */
export function registryShouldVet(mint, mc) {
  if (!mint) return false;
  const e = reg.get(mint);
  if (!e) return true; // never seen → vet
  if (!e.lastVetTs) return true; // seen but never vetted → vet
  const now = Date.now();
  // MC moved >20% since last vet → runner candidate, re-vet immediately.
  if (e.lastMc > 0 && mc > 0) {
    const movePct = Math.abs(mc - e.lastMc) / e.lastMc * 100;
    if (movePct > MC_MOVE_PCT) return true;
  }
  // Otherwise respect the cooldown.
  return (now - e.lastVetTs) >= VET_COOLDOWN_MS;
}

/** Record a vet outcome so future cycles can decide on re-vetting. */
export function registryRecordVet(mint, verdict, mc) {
  if (!mint) return;
  registryTouch(mint, mc);
  const e = reg.get(mint);
  if (e) {
    e.lastVetTs = Date.now();
    e.vetCount += 1;
    e.lastVerdict = verdict || null;
  }
}

/** Drop entries not seen in 24h. Call once per scan cycle. */
export function registryPrune() {
  const now = Date.now();
  for (const [k, v] of reg) {
    if (now - v.lastSeen > PRUNE_AFTER_MS) reg.delete(k);
  }
}

/** For diagnostics: how many tokens tracked. */
export function registrySize() {
  return reg.size;
}
