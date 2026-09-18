-- Reported token usage per session per model, the basis for cost analytics.
--
-- sessions.total_tokens (0075) answers "how many tokens" but not "what were
-- they worth": input, output and cached tokens price an order of magnitude
-- apart, and a session may run several models. Cost cannot be recovered from
-- one scalar, so the components are kept per model here and priced at read
-- time — a corrected rate then fixes history instead of only new rows.
--
-- The runtime reports cumulative usage for the whole session on every rollup,
-- so writers REPLACE a session's rows rather than accumulating into them.
--
-- model_id is the catalog id (`provider/model`), or 'unattributed' for steps
-- whose model the runtime did not name. Unattributed rows are counted in token
-- totals and deliberately never priced.
CREATE TABLE IF NOT EXISTS session_model_usage (
  session_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  -- Thinking tokens, already counted inside output_tokens by the providers
  -- that bill them. Kept for display; never priced again.
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, model_id)
);

-- The analytics breakdown reads every model row for the sessions in a window,
-- so the session_id prefix of the primary key already serves it. This index
-- serves the other direction: "what did we spend on model X across sessions".
CREATE INDEX IF NOT EXISTS idx_session_model_usage_model
  ON session_model_usage(model_id);
