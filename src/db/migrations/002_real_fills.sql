-- 002_real_fills.sql — real-money fill records for slippage learning.
-- Every real trade logs quoted vs actual fill price so the bot learns
-- its true execution costs (separate from paper's idealized fills).

CREATE TABLE IF NOT EXISTS ab_real_fills (
  id SERIAL PRIMARY KEY,
  mint TEXT NOT NULL,
  symbol TEXT,
  side TEXT NOT NULL,              -- 'buy' | 'sell'
  quoted_price_sol DOUBLE PRECISION,
  fill_price_sol DOUBLE PRECISION,
  slippage_bps DOUBLE PRECISION,  -- (fill - quoted)/quoted * 10000, signed
  sol_amount DOUBLE PRECISION,
  tx_sig TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ab_real_fills_mint_idx ON ab_real_fills (mint);
CREATE INDEX IF NOT EXISTS ab_real_fills_created_idx ON ab_real_fills (created_at DESC);
