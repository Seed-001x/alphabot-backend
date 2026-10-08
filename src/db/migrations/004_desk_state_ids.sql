-- 004: allow ab_desk_state ids 1 (legacy paper) and 2 (real book).
-- The original CHECK constraint only allowed id=1, which silently broke
-- every realbook persist() (id=2) — the .catch(()=>{}) swallowed the
-- violation, so deploys wiped positions/fills/closed trades.
ALTER TABLE ab_desk_state DROP CONSTRAINT IF EXISTS ab_desk_singleton;
ALTER TABLE ab_desk_state ADD CONSTRAINT ab_desk_ids CHECK (id IN (1, 2));
