# The Ecommarise Connector

A remote MCP server that lets people read the Ecommarise Portal from their own Claude accounts,
without the portal being on the public internet.

It is one of two halves. This service handles the MCP protocol and OAuth; the portal handles
identity and every access decision. See
[`docs/ECOMMARISE_CONNECTOR_FEASIBILITY.md`](docs/ECOMMARISE_CONNECTOR_FEASIBILITY.md) §9 for
why it is split that way rather than built inside the Laravel application.

---

## Why this is a separate service

Three reasons, in order of weight:

1. **The OAuth server should not be hand-written.** It mints tokens granting read access to HR
   salaries, client pricing and the whole Sourcing book. Here it is a maintained implementation
   over standard libraries; inside Laravel 8 it would be Passport 10 (itself out of support)
   plus hand-rolled discovery and dynamic client registration.
2. **No MCP server package installs into the portal.** Verified, not assumed — `laravel/mcp`
   needs Laravel 11+, `php-mcp/laravel` needs 9.46+, and `php-mcp/server` needs Symfony 6/7 while
   Laravel 8.83 pins the whole Symfony tree at 5.4.
3. **The portal stays private.** Laravel 8 has had no security fixes since January 2023, and the
   build spec requires the portal be reachable from Anthropic's cloud. This service is the only
   thing exposed; the portal sits behind it on a private network.

## How a sign-in works

```
1. Claude          → GET  /authorize         client_id, PKCE challenge, state
2. we redirect     → portal /connector/authorize
3. the user consents in the portal (their normal login)
4. portal redirects → GET /callback          the portal's one-time code
5. we exchange that code server-to-server for the user's identity
6. we redirect     → Claude's redirect_uri   our authorization code
7. Claude          → POST /token             code + code_verifier
```

Two authorization codes exist because two trust boundaries are crossed. The portal's code proves
"this browser was user 42" to us; ours proves "we authenticated somebody" to Claude.

Every later tool call carries the acting user's id to the portal, which re-resolves their roles
and re-checks that the account is still active. **This service never decides what anyone may
read.** If it were compromised, it could act as users who had signed in — it could not widen what
those users can see.

## Setup

```bash
npm install
cp .env.example .env     # then fill it in
npm run build
npm run start:local
```

`start:local` loads `.env` itself; plain `npm start` does not, and is the one to use under a
process manager that supplies the environment — see the systemd unit in
[`DEPLOYMENT.md`](DEPLOYMENT.md). Node 20.6 or newer, for `--env-file`.

On the portal side, set in its `.env`:

```
CONNECTOR_SERVICE_TOKEN=<the same value as PORTAL_SERVICE_TOKEN here>
CONNECTOR_ALLOWED_IPS=<this host's address>
CONNECTOR_REDIRECT_URIS=https://connector.example.com/callback
```

The callback URI must match exactly — the portal does no prefix matching, deliberately.

Then add the connector in Claude as a custom connector pointing at `https://…/mcp`. Registration
is dynamic; there is nothing to configure by hand.

## Verifying it

```bash
npm run smoke
```

Runs the whole flow — discovery, registration, authorize, consent, callback, token, refresh
rotation, `tools/list`, `tools/call` — against a stub portal on localhost. No database, no
migration, no browser. 28 checks, including the ones that matter most: an unregistered
`redirect_uri` is refused in place rather than redirected to, PKCE `plain` is rejected, a wrong
verifier fails, codes cannot be replayed, and refresh tokens rotate.

It does not prove the real portal answers correctly — that is what the portal's own 41 feature
tests, in the portal repository under `tests/Feature/Connector`, are for.

## The tools

Ten, matching build spec §04. Each is a thin mapping onto a portal endpoint; none of them decides
anything.

| Tool | Portal endpoint |
|---|---|
| `ask_knowledge` | `GET /knowledge` |
| `get_rule_or_variable` | `GET /variables` |
| `get_ai_pending_tasks` | `GET /ai-tasks` |
| `submit_task_result` | `POST /ai-tasks/{id}/result` |
| `create_pointer` | `POST /pointers` |
| `update_pointer_status` | `PATCH /pointers/{id}/status` |
| `get_pointer_status` | `GET /pointers` |
| `submit_kb_draft` | `POST /knowledge/drafts` |
| `read_code` | `GET /code/tree`, `GET /code/file` |
| `read_db_views` | `GET /db-views` |

There is no tool to confirm a task result, approve a pointer or activate a knowledge version.
Those are human actions in the portal, and the way to keep them that way is to leave the doors
unbuilt rather than guarded.

## Known limits

- **The token store is a JSON file.** Right at this scale — a handful of people on personal
  accounts — and wrong at any other. `TokenStore` is an interface; swapping in Postgres or Redis
  is one class and nothing above it changes.
- **`read_db_views` returns nothing useful yet.** No curated views exist in the portal and no
  read-only database user is provisioned. The tool refuses and says so. See §3.3 of the
  feasibility review.
- **The portal is a separate repository.** This service was split out of it with `git subtree
  split`, so the history here is its own; nothing is shared at runtime beyond the HTTP calls in
  `src/portal.ts`. The copy of the feasibility review in `docs/` is a snapshot — the portal's own
  copy is the one that gets updated.
