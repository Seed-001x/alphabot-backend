-- 003_token_registry.sql — persistent token registry for discovered tokens.
-- Replaces the in-memory-only registry so deploys don't wipe the bot's
-- knowledge of what it discovered, rejected, and should re-evaluate.
-- SQL comments use -- only (never //).

-- Canonical token record: one row per mint address.
CREATE TABLE IF NOT EXISTS ab_tokens (
  mint TEXT PRIMARY KEY,
  symbol TEXT,
  name TEXT,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  discovery_sources TEXT[] NOT NULL DEFAULT '{}',
  venue TEXT NOT NULL DEFAULT 'bonding_curve',
  lifecycle_state TEXT NOT NULL DEFAULT 'DISCOVERED',
  last_mc NUMERIC,
  last_liquidity_usd NUMERIC,
  last_vol24h NUMERIC,
  risk_status TEXT NOT NULL DEFAULT 'unverified',
  watch BOOLEAN NOT NULL DEFAULT TRUE,
  last_evaluated_at TIMESTAMPTZ,
  rejection_reason TEXT,
  next_reeval_at TIMESTAMPTZ,
  vet_count INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ab_tokens_lifecycle_idx ON ab_tokens (lifecycle_state);
CREATE INDEX IF NOT EXISTS ab_tokens_reeval_idx ON ab_tokens (next_reeval_at) WHERE watch = TRUE;
CREATE INDEX IF NOT EXISTS ab_tokens_last_seen_idx ON ab_tokens (last_seen);

-- Timestamped market observations for momentum calculation (24h retention).
CREATE TABLE IF NOT EXISTS ab_token_observations (
  id SERIAL PRIMARY KEY,
  mint TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  mc NUMERIC,
  price NUMERIC,
  vol24h NUMERIC,
  buy_vol NUMERIC,
  sell_vol NUMERIC,
  txns INT,
  liquidity_usd NUMERIC
);
CREATE INDEX IF NOT EXISTS ab_token_observations_mint_ts_idx ON ab_token_observations (mint, ts DESC);

-- Evaluation history: every meaningful vet/score decision, inspectable.
CREATE TABLE IF NOT EXISTS ab_evaluations (
  id SERIAL PRIMARY KEY,
  mint TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  market_snapshot JSONB,
  risk_result TEXT,
  ta_result TEXT,
  strategy_version TEXT NOT NULL DEFAULT 'v3.29',
  decision TEXT NOT NULL,
  rejection_reason TEXT
);
CREATE INDEX IF NOT EXISTS ab_evaluations_mint_ts_idx ON ab_evaluations (mint, ts DESC);
