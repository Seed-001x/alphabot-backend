# REGISTRY_PLAN.md — Persistent Postgres Token Registry

## Phase 1 findings (what the code actually does)

### Current registry (`src/lib/registry.js`)
Pure in-memory `Map`, 5 sync functions, ~5000-entry cap, 24h prune:
- `registryTouch(mint, mc)` — record sighting
- `registryShouldVet(mint, mc)` — gate: never-seen→vet; rejected <5min→skip unless MC moved >20%; else vet
- `registryRecordVet(mint, verdict, mc)` — record vet outcome
- `registryPrune()` / `registrySize()` — housekeeping

### Call sites (3 total)
1. `src/lib/pipeline.js:63-71` — touches every discovered mint per scan cycle, prunes. Wrapped in try/catch ("registry is additive").
2. `src/pipeline/loop.js:153-157` — gates scan candidates via `registryShouldVet()` before pushing to the vet queue. Falls back to the old `seenMints` 90-min dedupe if the registry import fails.
3. `src/pipeline/loop.js:205-210` — records vet outcomes after each kill-chain run.

All call sites use **sync** function signatures. The loop calls `registryShouldVet` in a hot for-loop over candidates.

### Postgres setup (`src/db/`)
- `pool.js`: optional `DATABASE_URL`, `pg.Pool` max 5, `hasDb` flag. Without it, everything runs in-memory.
- `migrate.js`: applies `schema.sql` as `000_base_schema`, then `migrations/*.sql` in sorted order, tracked in `ab_schema_migrations` (namespaced — shared DB hosts other apps).
- Conventions: tables prefixed `ab_`, `--` comments only (never `//`), `CREATE TABLE IF NOT EXISTS`, idempotent upserts via `ON CONFLICT`, fire-and-forget writes with `.catch(() => {})`.
- Existing tables: `ab_kv`, `ab_desk_state`, `ab_trade_journal`, `ab_kill_ledger`, `ab_creator_ledger`, `ab_learned_weights`, `ab_activity_log`. New migration: `003_token_registry.sql` (001 and 002 exist).
- Start script: `npm run db:migrate && node src/api/server.js` — migrations run before boot.
- Established pattern for this exact problem: `src/lib/storage.js` — sync in-memory API + boot hydration from `ab_kv` + write-through persistence (fire-and-forget). The registry will follow this pattern.

### Workers / concurrency
**Single process.** `startLoop()` in `src/pipeline/loop.js` runs one 45s scan cycle. No multi-worker, no clustering. No distributed-lock concerns — but the design must still use idempotent upserts (deploy overlap during Render restarts can briefly run two instances).

### Boot sequence (`startLoop`, loop.js ~line 432)
1. `initStorage()` → hydrates `ab_kv`
2. `initLearning()` → learning ledgers
3. `initRealBook()` → real book + fills restore

`initRegistry()` will slot in as step 2.5 (after storage, before the loop starts).

### Test suite
**None.** No test script, no test framework in package.json. Verification = `node --check` + live endpoint checks + a deploy-survival test (write token → deploy → confirm still present).

### Safety analysis (DB failure mode)
The registry gates **whether to vet**, never **whether to trade**. Trading decisions use fresh per-cycle market data. Failure modes:
- DB down at boot → cache starts empty → `registryShouldVet` returns true (fail-open: vet everything, same as today without registry). Safe direction.
- DB writes fail mid-run → in-memory cache still authoritative for this process lifetime. Logged, not silent.
- Stale cache after unclean shutdown → rehydrates from DB on boot; worst case re-vets some tokens. No trading on stale data possible because the registry never feeds prices into entry decisions.

## Implementation plan

### Migration `003_token_registry.sql`
Three tables, `ab_` prefix, `--` comments, `IF NOT EXISTS` everywhere:

1. **`ab_tokens`** — one canonical row per mint:
   - `mint TEXT PRIMARY KEY`
   - `symbol TEXT, name TEXT`
   - `first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()`
   - `last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()`
   - `discovery_sources TEXT[] NOT NULL DEFAULT '{}'`
   - `venue TEXT NOT NULL DEFAULT 'bonding_curve'` (bonding_curve | pumpswap | unknown)
   - `lifecycle_state TEXT NOT NULL DEFAULT 'DISCOVERED'`
   - `last_mc NUMERIC, last_liquidity_usd NUMERIC, last_vol24h NUMERIC`
   - `risk_status TEXT NOT NULL DEFAULT 'unverified'` (unverified | passed | failed)
   - `watch BOOLEAN NOT NULL DEFAULT TRUE`
   - `last_evaluated_at TIMESTAMPTZ`
   - `rejection_reason TEXT`
   - `next_reeval_at TIMESTAMPTZ`
   - `vet_count INT NOT NULL DEFAULT 0`
   - `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
   - Indexes: `lifecycle_state`, `next_reeval_at` (partial: `WHERE watch`), `last_seen`

2. **`ab_token_observations`** — timestamped market snapshots for momentum math (24h retention, cleaned by a periodic DELETE):
   - `id SERIAL PRIMARY KEY, mint TEXT NOT NULL, ts TIMESTAMPTZ NOT NULL DEFAULT NOW()`
   - `mc NUMERIC, price NUMERIC, vol24h NUMERIC, buy_vol NUMERIC, sell_vol NUMERIC, txns INT, liquidity_usd NUMERIC`
   - Index: `(mint, ts DESC)`

3. **`ab_evaluations`** — every meaningful vet/score decision:
   - `id SERIAL PRIMARY KEY, mint TEXT NOT NULL, ts TIMESTAMPTZ NOT NULL DEFAULT NOW()`
   - `market_snapshot JSONB` (mc, vol, holders at decision time)
   - `risk_result TEXT, ta_result TEXT`
   - `strategy_version TEXT NOT NULL DEFAULT 'v3.29'`
   - `decision TEXT NOT NULL` (vetted_pass | killed | skipped)
   - `rejection_reason TEXT`
   - Index: `(mint, ts DESC)`

### `src/lib/registry.js` refactor
Keep the **exact same 5 sync function signatures** (zero call-site changes):
- `registryTouch(mint, mc)` — updates in-memory cache immediately; queues DB upsert (fire-and-forget, debounced per mint to avoid write storms: max 1 write per mint per 60s)
- `registryShouldVet(mint, mc)` — pure in-memory decision (cache is the single writer in this process, so it's always consistent). Unchanged logic.
- `registryRecordVet(mint, verdict, mc)` — updates cache + queues DB write + appends to `ab_evaluations` (fire-and-forget)
- `registryPrune()` — prunes cache; DB rows marked `watch=false` + `lifecycle_state='STALE'` instead of deleted (history preserved)
- `registrySize()` — unchanged

New async functions (new capabilities, additive):
- `initRegistry()` — `SELECT * FROM ab_tokens WHERE watch` → hydrate cache. Called in `startLoop` boot. Logs count.
- `registrySetState(mint, state, reason)` — lifecycle transitions (DISCOVERED → TRACKING → WATCHLIST → CANDIDATE → RISK_CHECK → ENTRY_READY → POSITION_OPEN, plus REJECTED_TEMPORARY / REJECTED_RISK / STALE)
- `registryGet(mint)` — full record for diagnostics
- `registryRecordObservation(mint, metrics)` — append to `ab_token_observations` (called on vet events + every Nth sighting, not every cycle)
- `registryDueForReeval(limit)` — `SELECT mint FROM ab_tokens WHERE watch AND next_reeval_at <= NOW() ORDER BY next_reeval_at LIMIT n` — feeds priority re-vetting

### Lifecycle rules (no scoring/vetting logic changes)
- `REJECTED_TEMPORARY` (low volume, no momentum, score < bar): `next_reeval_at = now + 5min`. Re-vet triggers: MC moved >20%, `next_reeval_at` passed, or volume acceleration detected.
- `REJECTED_RISK` (honeypot, concentration, LP unlock): stays rejected until `venue` changes (e.g. graduation) or 24h passes with fresh market data — requires new evidence, not just time.
- PumpSwap graduation: `UPDATE ab_tokens SET venue='pumpswap', lifecycle_state='TRACKING', next_reeval_at=NOW()` on the **existing** mint row. No duplicate records (PK on mint + idempotent upserts).

### What is explicitly NOT changing
- Scoring, vetting kill chain, risk thresholds, anti-scam gates — untouched
- `VET_PER_CYCLE`, queue architecture, StageQueue — untouched (queue prioritization is a separate future phase)
- Fills, learning ledgers, kill history tables — untouched
- Bot stays paused (realMode off). Kill switch stays disabled.

### Verification plan
1. `node --check` on all modified files
2. Migration applies cleanly (test via `npm run db:migrate` — but DATABASE_URL is only on Render; verify via deploy logs)
3. Deploy → check Render logs for `[registry] hydrated N tokens`
4. Write a canary token via a debug endpoint or direct DB insert → trigger deploy → confirm it survives (SELECT after restart)
5. `GET /api/realbook` still returns expected shape; `enabled=false` confirmed
6. No test suite exists — add none (out of scope), rely on live verification
