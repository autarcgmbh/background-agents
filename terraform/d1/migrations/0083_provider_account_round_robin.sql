-- Round-robin account selection.
--
-- A provider's installation default gains a selection strategy. 'default'
-- keeps binding the default account to every policy-following session;
-- 'round_robin' binds the provider's least recently selected active account
-- instead, so all connected subscriptions are drawn on evenly. The default
-- account stays the anchor and the fallback, so its protection trigger and
-- the one-default-per-provider shape are unchanged.
ALTER TABLE model_provider_account_defaults
  ADD COLUMN selection_strategy TEXT NOT NULL DEFAULT 'default'
  CHECK (selection_strategy IN ('default', 'round_robin'));

-- When a session last bound this account at creation. The rotation pointer.
-- Distinct from last_used_at, which the token broker stamps (throttled) as a
-- sandbox actually draws credentials.
ALTER TABLE model_provider_accounts ADD COLUMN last_selected_at INTEGER;
