-- ALPHABOT backend base schema. All tables prefixed ab_.
-- SQL comments use -- only (never //).

-- Generic key/value store (cursors, snapshots, config, misc state).
CREATE TABLE IF NOT EXISTS ab_kv (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Paper portfolio: one row, the desk's live state.
CREATE TABLE IF NOT EXISTS ab_desk_state (
  id INT PRIMARY KEY DEFAULT 1,
  state JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ab_desk_singleton CHECK (id = 1)
);

-- Trade journal: entry snapshots + outcomes. The learning floor's memory.
CREATE TABLE IF NOT EXISTS ab_trade_journal (
  id SERIAL PRIMARY KEY,
  mint TEXT NOT NULL,
  symbol TEXT,
  entry_ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  entry_mc NUMERIC,
  score INT,
  breakdown JSONB,
  feeds JSONB,
  research_mod INT,
  research_line TEXT,
  elite_hit BOOLEAN DEFAULT FALSE,
  exit_ts TIMESTAMPTZ,
  exit_mc NUMERIC,
  pnl_pct NUMERIC,
  exit_reason TEXT,
  hold_ms BIGINT,
  buy_pressure NUMERIC,
  creator TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ab_trade_journal_mint_idx ON ab_trade_journal (mint);
CREATE INDEX IF NOT EXISTS ab_trade_journal_exit_idx ON ab_trade_journal (exit_ts);

-- Kill ledger: every kill + its confirmation status.
CREATE TABLE IF NOT EXISTS ab_kill_ledger (
  id SERIAL PRIMARY KEY,
  mint TEXT NOT NULL,
  symbol TEXT,
  pass TEXT,
  fam TEXT,
  reason TEXT,
  creator TEXT,
  mc NUMERIC,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'open',
  checked_ts TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ab_kill_ledger_mint_idx ON ab_kill_ledger (mint);
CREATE INDEX IF NOT EXISTS ab_kill_ledger_status_idx ON ab_kill_ledger (status);

-- Creator outcomes: launches / rugged / moon2x counts per creator.
CREATE TABLE IF NOT EXISTS ab_creator_ledger (
  creator TEXT PRIMARY KEY,
  launches INT NOT NULL DEFAULT 0,
  rugged INT NOT NULL DEFAULT 0,
  moon2x INT NOT NULL DEFAULT 0,
  last_seen TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Learned score weights + adaptation log.
CREATE TABLE IF NOT EXISTS ab_learned_weights (
  id INT PRIMARY KEY DEFAULT 1,
  weights JSONB NOT NULL,
  last_adapt_ts TIMESTAMPTZ,
  adapt_log JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ab_weights_singleton CHECK (id = 1)
);

-- Recent activity / events for the UI feed.
CREATE TABLE IF NOT EXISTS ab_activity_log (
  id SERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  kind TEXT NOT NULL,
  mint TEXT,
  symbol TEXT,
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ab_activity_log_ts_idx ON ab_activity_log (ts DESC);
