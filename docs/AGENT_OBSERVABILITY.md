# Grafana Agent Observability

Sandbox OpenCode and Claude sessions export usage, tool activity, traces, and full conversations
through
[Grafana's official coding-agent integrations](https://github.com/grafana/agento11y/blob/main/plugins/agento11y/README.md).
The upstream Analytics page continues to show session activity, provider-reported cost, and PR
outcomes. Grafana replaces this fork's custom per-session token tables and list-price calculations.

## Connect your stack

1. Open **Observability → Agent Observability** in your Grafana stack and enable it if needed.
2. Open `https://<your-stack>.grafana.net/a/grafana-agento11y-app/setup-coding-agent` and copy the
   connection block. The access-policy token needs **`sigil:write`, `metrics:write`,
   `traces:write`**. The Cloud scope is still named `sigil`.
3. In Open-Inspect, open **Settings → Secrets → All Repositories (Global)** and add:

   ```dotenv
   AGENTO11Y_ENDPOINT=<Agent Observability API URL>
   AGENTO11Y_AUTH_TENANT_ID=<instance ID>
   AGENTO11Y_AUTH_TOKEN=<access-policy token>
   AGENTO11Y_OTEL_EXPORTER_OTLP_ENDPOINT=<OTLP gateway URL>
   ```

   The OTLP URL is also available in **Grafana Cloud Portal → your stack → OpenTelemetry**. If that
   card shows a different instance ID, supply its generated `OTEL_EXPORTER_OTLP_HEADERS` block as
   well. These are two independent export channels; both endpoints are required.

4. Deploy the updated control plane and rebuild the sandbox images using the existing
   [sandbox image workflow](../packages/sandbox-images/README.md). Rebuild any prepared repository
   or environment images too. Start fresh sessions on the updated images: existing running processes
   and old snapshots keep their previous plugins and configuration.

Use repository/environment secret scopes instead of global scope to enable a subset of sessions.
Credentials are delivered through the existing encrypted-secret environment mechanism; they are not
baked into images or written into agent configuration files.

## Capture and attribution

When the four connection values are present, the runtime defaults to:

| Setting                 | Default                                                                          |
| ----------------------- | -------------------------------------------------------------------------------- |
| Content capture         | `full` — prompts, responses, tool inputs/outputs, and usage                      |
| Agent name              | `open-inspect-opencode` or `open-inspect-claude`                                 |
| Agent version           | The host version reported by the official plugin                                 |
| User                    | Session creator's canonical user ID, falling back to SCM login or `unknown`      |
| Repository tag          | Primary `owner/name`, including nested namespaces; `none` for repo-less sessions |
| Provider account tags   | `provider_account` (display name) and `provider_account_id` when the session's   |
|                         | model runs on a connected subscription account; absent for API-key sessions      |
| Automatic metric tags   | `user,repo`                                                                      |
| Local receiver / guards | Disabled                                                                         |

The official plugins retain their built-in secret redaction. To choose a different capture mode, set
`AGENTO11Y_CONTENT_CAPTURE_MODE` in Settings → Secrets. `AGENTO11Y_AGENT_NAME`,
`AGENTO11Y_AGENT_VERSION`, `AGENTO11Y_USER_ID`, and `AGENTO11Y_TAGS` can also be overridden.
Additional tags are merged with the repository tag; an explicit `repo` tag wins.

To distinguish coding sessions from product agents in a shared stack, set:

```dotenv
AGENTO11Y_TAGS=app=kirk,workload=internal-coding
```

The provider account tags name the account bound for the session's model when the sandbox starts, so
a rotating ChatGPT default (see [OpenAI models](OPENAI_MODELS.md)) can be read per subscription by
filtering conversations on `provider_account`. Custom tags cannot be promoted to automatic metric
labels; the plugin accepts only `user`, `repo`, and `branch` there.

These tags reach conversations, traces, and client token/latency metrics. Grafana's derived
`agento11y_generation_cost_usd_total` metric carries agent/model labels rather than custom tags;
filter cost panels with `gen_ai_agent_name=~"open-inspect-.*"` (or your configured agent names).

The plugins use the underlying agent conversation ID. Open-Inspect's session API exposes that ID as
`agentSessionId`, so you can use it to find the corresponding Grafana conversation. The runtime
reports the ID as soon as it creates, resumes, or rotates a conversation — a fresh session has none
until its first prompt, because the harness creates the conversation lazily. Resuming the same agent
session keeps its ID; a conversation reset creates a new one. Subagent capture and parent-generation
links are handled by the official plugins.

No historical backfill runs automatically. The old `sessions.total_tokens` column and
`session_model_usage` table remain as historical data; new sessions no longer update or query them.

## Open in Grafana

Set the `grafana_url` Terraform variable to your stack origin, for example
`https://mystack.grafana.net`. Sessions then link straight at their Grafana conversation:

```
<grafana_url>/a/grafana-agento11y-app/conversations/<agentSessionId>
```

Terraform passes it to the web app as `NEXT_PUBLIC_GRAFANA_URL` and to the Linear bot as
`GRAFANA_URL`. Only the origin matters: a URL pasted with a path (the setup page, say) is reduced to
its origin, so you can copy it straight out of the address bar.

Two surfaces carry the link:

- **Session details sidebar** — an **Open in Grafana** row, next to the model and branch metadata.
- **Linear agent sessions** — a **Grafana** entry in the session's external links, published
  alongside **View Session** and **Pull Request** when a turn finishes.

`NEXT_PUBLIC_*` vars are inlined into the client bundle at build time, so rebuild the web app after
changing the value. The link appears only once the session has an agent conversation ID, so a
session that has not been prompted yet shows none. Leaving the variable empty omits the link
everywhere, which is what a deployment that exports nothing to Grafana wants.

## Verify and diagnose

Run a turn in each enabled harness, including a tool call and subagent, then check:

- **Conversations:** prompt/response content, model, token counts, and subagent relationships.
- **Performance:** token and latency metrics.
- **Tempo / conversation traces:** LLM and tool spans.

In a fresh sandbox terminal, `agento11y doctor --json` checks endpoint connectivity without printing
the token. The runtime loads plugins explicitly rather than through a global interactive install.
For detailed plugin logs, set `AGENTO11Y_DEBUG=true` for a new session. OpenCode logs to stderr;
Claude hooks log under `~/.local/state/agento11y/logs/agento11y.log`.

With an authenticated `gcx` context pointing at the same stack, use:

```bash
gcx agento11y agents list
gcx agento11y conversations list --limit 10
gcx agento11y conversations get <agentSessionId>
```

Conversation ingestion does not prove OTLP is working. If conversations appear but Performance or
traces are empty, check the OTLP URL, instance ID, and metrics/traces write scopes separately.

Incomplete connection settings log `agento11y.disabled` with missing variable names and skip the
integration. `agento11y.plugin_missing` means the session booted an image without the pinned plugin.
During OpenCode shutdown, the runtime requests plugin disposal before terminating the server;
`agento11y.dispose_failed` records a failed or timed-out disposal. Claude exports through its Stop
and SessionEnd hooks. Export failures do not change provider billing or session budget enforcement.

## Dependency updates

`packages/sandbox-images/toolchain.json` pins the CLI archive, the Claude plugin manifest from the
same release, and the OpenCode npm package. Update those versions/checksums together with the image
lockfiles. Image verification checks the CLI version, OpenCode plugin import, and Claude hook
manifest. The runtime uses these local artifacts directly, with no interactive login, marketplace
installation, or automatic plugin upgrade at session startup.
