# ALPHABOT Backend

Server-side powerhouse for the ALPHABOT paper-trading desk
(frontend: https://seed-001x.github.io/alphabot-paper/).

Runs the full pipeline in Node on a ~45s loop: **SCAN → VET (kill chain) →
RESEARCH → SCORE → paper TRADE → RISK exits**, with the learning floor
(kill ledger, trade journal, creator outcomes, adaptive scoring/exits) and
the AI judge. **Paper money only.** No wallet keys, no signing, no Telegram.

## Why a backend

- **No CORS server-side** — SCAN calls pump.fun's `frontend-api-v3` directly
  (exact creator, timestamp, socials, USD market cap), plus RugCheck,
  DexScreener, and the PumpPortal websocket.
- **24/7 operation** — the desk runs even when your browser is closed
  (requires the $7/mo Starter plan; the free tier sleeps when idle).
- **Durable learning** — ledgers live in Postgres instead of browser
  localStorage, so the floor keeps getting smarter across restarts.
- **Keys stay server-side** — Helius/OpenAI keys are env vars, never in a
  browser.

## Deploy (Render)

**Option A — Blueprint (recommended):** Render dashboard → New → Blueprint →
connect the `Seed-001x/alphabot-backend` repo. The included `render.yaml`
sets everything up (free plan).

**Option B — Manual:** New → Web Service → connect the repo.
- Runtime: Node · Build: `npm ci` · Start: `npm start`
- Health check path: `/health`

Then add env vars in the dashboard (**you do this — keys never go in chat**):

| Variable | Required | What it wakes |
|---|---|---|
| `DATABASE_URL` | Recommended | Durable ledgers + portfolio (Render Postgres, internal URL). Without it the backend runs in-memory. |
| `HELIUS_API_KEY` | Optional | Smart-flow watcher (156 wallets) + elite confirmation |
| `OPENAI_API_KEY` | Optional | AI judge (gpt-4o-mini, ≤3 calls/cycle) |

Migrations run automatically on boot (`npm start` = `db:migrate` then server).

**24/7 note:** the free plan sleeps when idle. For round-the-clock scanning,
upgrade the service to **Starter ($7/mo)** — one click in the dashboard, no
code change.

## API (CORS open, read-only)

- `GET /health` — `{ ok, uptimeSec, db, helius, openai, cycles, paper }`
- `GET /api/state` — full snapshot: portfolio, positions, stats, feeds,
  brain, events, queues, cycle counters
- `GET /api/trades?limit=50` — closed paper trades, newest first
- `GET /api/brain` — learning stats, kill hit-rates, correlations, exit rules
- `GET /api/events?limit=80` — recent pipeline events

## Local dev

```bash
npm install
# optional: export DATABASE_URL=... HELIUS_API_KEY=... OPENAI_API_KEY=...
npm start   # migrations + server on :3000
```

Without `DATABASE_URL` everything runs in-memory (ledgers live for the
process lifetime) — fine for testing, not for learning.
