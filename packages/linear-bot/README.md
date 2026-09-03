# Open-Inspect Linear Agent

Cloudflare Worker that integrates [Linear](https://linear.app) with Open-Inspect as a first-class
**Linear Agent**. Users can `@mention` or assign the agent on issues to trigger background coding
sessions.

For day-to-day usage, see the user-facing
[Linear integration guide](../../docs/integrations/LINEAR.md).

## How It Works

```
@OpenInspect on issue → Linear sends AgentSessionEvent webhook →
  Agent emits "Thinking..." → Resolves repo (asks with selectable options if unsure) →
  Creates session → Prompt reaches sandbox → Eligible issue may move to team's
  lowest-position started state, agent becomes the issue delegate →
  Agent emits "Working on owner/repo..." → Agent codes in sandbox
  (progress and intermediate messages stream back as activities) →
  Completion callback → Agent emits its final message and "PR opened: <link>"
```

1. A user `@mentions` or assigns the agent on a Linear issue
2. Linear sends an `AgentSessionEvent` webhook to this worker
3. The worker emits a `Thought` activity (visible in Linear as "thinking")
4. Resolves the target GitHub repo (see [Repo Resolution](#repo-resolution) below)
5. Creates an Open-Inspect coding session and sends the issue as a prompt
6. After a human-initiated prompt reaches a live sandbox, moves an eligible issue to the team's
   lowest-position `started` workflow state when the signed callback is delivered and accepted
7. Emits a `Thought` activity with a link to the live session, and sets itself as the issue delegate
   when a person started the work and no delegate was set
8. While the sandbox works, the control plane sends progress callbacks: tool calls appear as
   ephemeral `Action` rows, finished assistant messages appear as `Thought` activities, and a
   throttled "Still working" thought keeps the session from going stale during long silent steps
9. When the agent completes, emits a final `Response` with the agent's message and the PR link

Follow-up messages on an issue with an active session are sent as additional prompts to the existing
session rather than creating a new one. Earlier turns are rebuilt from the agent session's
activities (not from editable comments) and replayed to the sandbox as untrusted context.

Stopping the agent from Linear (the "Send stop request" menu) stops the sandbox session and always
ends with a `Response` confirming what happened — even when the request arrived while the agent was
still choosing a repository or creating the session, in which case the in-flight start is aborted
and the just-created session is stopped. Unassigning the agent from the issue does the same.

The issue transition is opt-in and best-effort. Already-started, completed, canceled,
automation-created, and follow-up sessions remain unchanged. A skipped, rejected, or failed
transition never blocks agent execution.

## Setup

### 1. Create a Linear OAuth Application

Go to
**[Linear Settings → API → Applications → New](https://linear.app/settings/api/applications/new)**

Fill in:

- **Application name:** `OpenInspect` (this is how the bot appears in @mentions)
- **Developer name:** Your org name
- **Callback URL:** `https://<your-linear-bot-worker>/oauth/callback`
- **Webhooks:** Enable, set URL to `https://<your-linear-bot-worker>/webhook`
- **Webhook events:** Check **Agent session events**, **Inbox notifications**, and **Permission
  changes**. (Issues and Comments are not needed; the agent ignores them.)
- **Client credentials tokens:** Enable this option. The Worker uses these 30-day app-actor tokens
  for runtime API calls.
- **Public:** OFF (unless distributing to other workspaces)

Note the **Client ID**, **Client Secret**, and **Webhook Signing Secret**.

### 2. Deploy via Terraform

Set `enable_linear_bot = true` and add to your `terraform.tfvars`:

```hcl
enable_linear_bot     = true
linear_client_id      = "your-client-id"
linear_client_secret  = "your-client-secret"
linear_webhook_secret = "your-webhook-signing-secret"
```

The worker also requires these secrets (set via `wrangler secret put` or Terraform):

- Exactly one classifier credential selected by `CLASSIFICATION_MODEL`: **`ANTHROPIC_API_KEY`** for
  an Anthropic model (the default), or **`OPENAI_API_KEY`** for an OpenAI model
- **`SERVICE_AUTH_SECRET`** — per-service sig1 signing secret; also verifies CP callbacks

Then `terraform apply`.

### 3. Install the Agent in Your Workspace

Visit `https://<your-linear-bot-worker>/oauth/authorize` in your browser. This initiates the OAuth
flow with `actor=app` and installs the agent in your Linear workspace.

**Requires admin permissions** in the Linear workspace.

After installation, `@OpenInspect` will appear in the mention and assignee menus.

The browser authorization installs the app actor. The Worker then uses the application's client ID
and client secret to mint runtime tokens; authorization-code access and refresh tokens are not kept
as runtime credentials.

### Upgrading an Existing Installation

Before deploying a version that uses client credentials, open the existing application in **Linear
Settings → API → Applications** and enable **Client credentials tokens**. Terraform cannot change
this Linear-side setting.

For a private, single-workspace deployment whose application credentials resolve to the installed
workspace, deploy normally after enabling the setting. No uninstall/reinstall, new secret, webhook
change, or scope reauthorization is expected. The first Linear request mints and verifies a runtime
token, then removes the legacy refresh-token record. Allow already-running sessions to finish before
upgrading; callback contexts created by older versions may not contain the installed app-user
identity required for terminal Agent API delivery.

If the setting is not enabled, Linear reports that the client does not support the
`client_credentials` grant and the request fails without falling back to the legacy refresh token.
If the OAuth application is managed in a different workspace from the installed agent, verify that
the client-credentials token's viewer organization matches the webhook organization before
upgrading; a mismatch is rejected. Rotating the Linear client secret invalidates cached runtime
tokens; deploy the replacement secret and the Worker will mint a replacement token on the next cache
miss or HTTP 401.

### 4. Configure Repo Mapping (Optional)

The agent resolves repos automatically in most cases (see [Repo Resolution](#repo-resolution)).
Static mappings are optional overrides, stored in the worker's KV namespace and edited directly with
wrangler (the key shapes are documented in `src/kv-store.ts`):

**Team → target mapping:**

```bash
npx wrangler kv key put --namespace-id <LINEAR_KV_NAMESPACE_ID> config:team-repos '{
  "YOUR_TEAM_ID": [
    { "owner": "your-org", "name": "frontend", "label": "frontend" },
    { "environmentId": "env_abc123", "label": "fullstack" },
    { "owner": "your-org", "name": "main-repo" }
  ]
}'
```

Each team maps to an array of targets — repositories (`owner`/`name`) or saved environments
(`environmentId`, the stable `env_…` id shown in the web UI). If a target has a `label`, it only
matches issues with that label. The first target without a label is the default fallback. An
environment entry whose environment was deleted is skipped and resolution falls through to the next
stage.

**Project → target mapping:**

```bash
npx wrangler kv key put --namespace-id <LINEAR_KV_NAMESPACE_ID> config:project-repos '{
  "LINEAR_PROJECT_ID": { "owner": "your-org", "name": "my-repo" },
  "OTHER_PROJECT_ID": { "environmentId": "env_abc123" }
}'
```

Project mappings take the highest priority during target resolution.

### 5. Configure Integration Settings (Optional)

In the Open-Inspect web UI, go to **Settings → Integrations → Linear** to configure:

- Default model and reasoning effort
- Whether users can override the model via preferences or issue labels
- Whether real-time tool progress activities are shown in Linear
- Whether the agent sets itself as the issue delegate when a person starts work
- Which repos the Linear agent is enabled for (allowlist or all)

These can also be set per-repo as overrides.

### 6. Use It

On any Linear issue:

- Type `@OpenInspect` in a comment → agent picks up the issue
- Assign the issue to `OpenInspect` → agent picks it up
- Agent status is visible directly in Linear (thinking, working, done)
- Add a `model:<name>` label to override the model (e.g., `model:opus`, `model:sonnet`,
  `model:opus-5`, `model:sonnet-5`, `model:haiku`, `model:gpt-5.4`, `model:gpt-5.3-codex`)

## Repo Resolution

When an issue is triggered, the agent resolves the session target using a 5-step cascade:

1. **Project → target mapping** — static mapping from Linear project IDs to a repository or a saved
   environment (highest priority)
2. **Team → target mapping** — static mapping from Linear team IDs to repositories or saved
   environments, with optional label filtering
3. **Explicit `owner/repo` mention** — deterministically selects a single available repository named
   in the trigger comment or clarification reply
4. **Linear's `issueRepositorySuggestions` API** — Linear's built-in repo suggestion (>= 70%
   confidence)
5. **LLM classifier** — uses the model selected by `CLASSIFICATION_MODEL` (Anthropic by default) to
   classify based on issue content, labels, and available repo descriptions. Asks the user to
   clarify if confidence is low.

Environment sessions clone the environment's full repository set; integration settings (model,
enabled-repos allowlist) resolve from the environment's primary repository until environment-level
settings exist.

## API Endpoints

| Endpoint               | Method | Description                                                                                       |
| ---------------------- | ------ | ------------------------------------------------------------------------------------------------- |
| `/health`              | GET    | Health check                                                                                      |
| `/webhook`             | POST   | Linear webhook receiver (agent sessions, inbox notifications, permission changes, app revocation) |
| `/oauth/authorize`     | GET    | Start OAuth installation flow                                                                     |
| `/oauth/callback`      | GET    | OAuth callback handler                                                                            |
| `/callbacks/start`     | POST   | Prompt-dispatched callback from control plane                                                     |
| `/callbacks/progress`  | POST   | Keepalive / assistant-text progress callback from control plane                                   |
| `/callbacks/tool_call` | POST   | Tool progress callback from control plane                                                         |
| `/callbacks/complete`  | POST   | Completion callback from control plane                                                            |

Team/project mappings and user preferences are edited directly in KV (see `src/kv-store.ts`).

## Agent Activity Types

The agent uses Linear's native activity system:

| Activity        | When                                                                    | User sees                                                     |
| --------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------- |
| **Thought**     | Analyzing issue, resolving repo, finished assistant messages, keepalive | Thinking indicator; intermediate agent messages               |
| **Response**    | Work completed, stop confirmed, unassigned                              | Comment-like message on the issue with the agent's summary    |
| **Error**       | Something went wrong, stop could not be honoured                        | Error message on the issue                                    |
| **Action**      | Tool calls (file edits, commands), with result when finished            | Ephemeral status (e.g., "Run `npm test` → 12 passed")         |
| **Elicitation** | Repo classification is uncertain                                        | Question with selectable repository options (`select` signal) |

Every unhandled failure ends with an `Error` activity and a cancelled plan so the session never sits
in "working" forever. Requests made outside an issue (e.g. from a project or document) receive an
`Error` explaining that only issues are supported.

## Development

```bash
cd packages/linear-bot
npm install
npm run build
wrangler dev  # Local development
```

## Architecture

Built on Linear's [Agents API](https://linear.app/developers/agents):

- **OAuth2 installation with `actor=app`** — installs the agent identity in the workspace
- **OAuth2 client credentials at runtime** — mints replaceable 30-day app-actor tokens and renews
  once after an explicit HTTP 401
- **Raw Linear GraphQL API** — direct `fetch` calls (no SDK, Workers can't import CJS)
- **AgentSessionEvent** — native trigger when users @mention or assign
- **AgentActivity** — native status updates visible in Linear's UI, including `select` elicitations
  and ephemeral thoughts/actions
- **Stop signal** — a `prompt` activity with `signal: "stop"` writes a KV stop marker
  (`stop:<agentSessionId>`) that in-flight flows check at every step, stops the sandbox, and always
  ends with a confirming `Response`/`Error`
- **Inbox notifications / permission changes / revocation** — `issueUnassignedFromYou` stops the
  session; `OAuthApp revoked` clears cached tokens and the workspace's issue mappings
- **Progress callbacks** — the control plane pings `/callbacks/progress` every ~5 minutes while a
  Linear run is active (heartbeat) and whenever an assistant text segment finishes; the bot
  throttles keepalive thoughts (`keepalive:<agentSessionId>`) so Linear never marks the session
  stale
- **Issue workflow transition** — eligible human-started work may move to the team's lowest-position
  `started` workflow state after sandbox dispatch and callback validation; skipped or failed
  transitions never block execution
- **Hono** for HTTP routing
- **KV** for the replaceable runtime-token cache, issue-to-session mapping, stop markers, keepalive
  throttles, and configuration
- **Service binding** to the control plane for session management
