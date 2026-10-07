-- Add m5_change to trade journal for snipe-and-dump pattern learning
ALTER TABLE ab_trade_journal ADD COLUMN IF NOT EXISTS m5_change NUMERIC;
