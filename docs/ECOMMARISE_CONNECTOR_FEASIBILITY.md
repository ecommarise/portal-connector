# The Ecommarise Connector — feasibility review

**Spec reviewed:** [`docs/mockups/Ecommarise-Connector-Build-Spec.html`](mockups/Ecommarise-Connector-Build-Spec.html) (build specification v3)
**Reviewed against:** `dev` @ `a1e7e823`, Laravel 8.83.29 / PHP 8.3, 606 migrations
**Date:** 14 Sep 2026
**Status:** review only — nothing built, no decisions taken.

---

## 0. Verdict

**Yes, it can be built in this portal**, and cheaper than the spec assumes for three of its
four modules — the AI task queue, the knowledge base and the audit-pointer flow are ordinary
Laravel work on primitives that already exist here, several of them with a direct precedent
to copy.

The connector itself (§01–§04) is the expensive half, and the spec under-states it in three
places:

1. **One hard blocker** — the portal has no OAuth authorization server. §13 files this as a
   confirmation; it is a build item.
2. **Two unbudgeted design items** — there is no single variable registry behind
   `get_rule_or_variable` / `linked_variable_ids`, and there are no curated DB views behind
   `read_db_views`. Neither is mentioned in the spec.
3. **One stated invariant the codebase already contradicts** — "no Anthropic API keys
   anywhere" is false today.

Nothing here says don't build it. It says Phase 1 as written is not the first phase.

---

## 1. What already exists

Everything in this table is shipped code on `dev`. The spec budgets most of it as new.

| Spec item | What the portal already has |
|---|---|
| Roles + server-side gate (§02, §10) | `roles` / `permissions` / `role_user` / `permission_role`; `hasRole()` ([`app/Models/User.php:148`](../app/Models/User.php)), `hasPermission()` (`:404`); middleware `role`, `permission`, `permission_any`, `active` ([`app/Http/Kernel.php:74`](../app/Http/Kernel.php)) |
| `connector_call_log` → Activity Logs (§10, §11) | [`app/Models/ActivityLog.php`](../app/Models/ActivityLog.php) + `ActivityLogService`, with an established event-constant pattern. The connector log is one more writer, not a new subsystem |
| `claude_task_instructions` (§07, §11) | ~70% built as [`app/Models/AiPrompt.php`](../app/Models/AiPrompt.php) — slug, body, `task_catalog_keys`, `is_active`, soft deletes — plus [`app/Models/TaskAiGeneration.php`](../app/Models/TaskAiGeneration.php), which already stores `prompt_snapshot` → `generated_content` → `edited_content` → `final_content` + `context_snapshot`. That is §07's `awaiting_confirmation` → `confirmed` lifecycle, already running |
| Task Guidance shelf (§07) | [`app/Models/Ecommarise/EcTaskGuidance.php`](../app/Models/Ecommarise/EcTaskGuidance.php) (steps + FAQs keyed on `TaskCatalog::key`, every edit logged via `EcTaskGuidanceChange`) and `HrTaskGuidance`. Note the spec calls this "Configuration Center → Task Guidance"; the portal calls it Administration → Guidelines & FAQs |
| draft → activate → version history → rollback (§08, §09) | Implemented several times over: `EcTaskGuidanceChange`, `HrConfigLog`, `DraftApprovalService`, `QuantityPriceAgreementVersion`, `HrJobPostingJdVersion` |
| Pointers surfaced as portal tasks (§05) | [`app/Models/Task.php`](../app/Models/Task.php) carries `status`, `priority`, `catalog_key`, `responsible_role`, `area`, `meta`. And there is an exact precedent for a finding-record that owns a linked task: `SourcingFlagInstance` + [`app/Models/SourcingFlagPointer.php`](../app/Models/SourcingFlagPointer.php) ↔ `tasks.sourcing_flag_id` |
| Credentials Vault to exclude (§02) | [`app/Models/Ecommarise/EcCredential.php`](../app/Models/Ecommarise/EcCredential.php) — encrypted at rest, `visible_roles`, every reveal logged. Excluding it is a deny-list plus a test, not a redesign |
| Stale-lock expiry, `kb-sync` insertion (§07, §09) | [`app/Console/Kernel.php`](../app/Console/Kernel.php) already runs ~20 scheduled commands on the same cadences these need |
| Brand-level row scope (§10) | `ProductBrandAssignment`, `brand_id` on tasks and products |

**Consequence:** §07, §08, §09 and §11 are low-risk. The estimate should reflect that they are
extensions of existing patterns, not greenfield modules.

---

## 2. The blocker — there is no OAuth server

Authentication today is Sanctum personal access tokens, issued by posting email + password to
`/api/auth/token` ([`app/Http/Controllers/Api/Hrm/AuthTokenController.php:12`](../app/Http/Controllers/Api/Hrm/AuthTokenController.php)).
`config/sanctum.php` is stock. There is no OAuth2 authorization server anywhere in the app —
the only `oauth` strings in the repo are Amazon SP-API's client credentials
(`config/ecommarise.php:75`, `AmazonOAuthController`), which is the portal acting as an OAuth
*client* against Amazon, not as a provider.

A remote MCP connector needs the portal to be an OAuth 2.1 **provider**: authorization code +
PKCE, plus discovery metadata (`/.well-known/oauth-authorization-server`,
`/.well-known/oauth-protected-resource`), plus — for claude.ai custom connectors — dynamic
client registration (RFC 7591).

- Laravel 8 + Passport covers auth-code + PKCE.
- Discovery metadata and DCR are hand-written on top of it.
- **Verify the exact requirement against Anthropic's current connector documentation before
  starting** — this review is based on how remote connectors work generally, and the details
  move.

§13 lists this as "confirm the portal's login can issue OAuth tokens for the connector (else
add a token endpoint)". It cannot, and "add a token endpoint" understates it. This is the
critical path for the entire project.

### 2.1 Two mechanics the spec treats as given

**No MCP server package installs into this app.** Laravel 8.83 / PHP 8.3
([`composer.json`](../composer.json)). Verified against Packagist and with
`composer require --dry-run` on 14 Sep 2026 — all four candidates fail to resolve:

| Package | Constraint | Result on this app |
|---|---|---|
| `laravel/mcp` v1.0.0-beta.1 (official) | php `^8.2`, `illuminate/* ^11.45.3\|^12.41.1\|^13.0` | Fails. No release ever supported Laravel 8 — the earliest (v0.1.x) already required `illuminate/support ^10.0\|^11.0\|^12.0` |
| `php-mcp/laravel` 4.0.0 | `laravel/framework ^9.46 \|\| ^10.34 \|\| ^11.29 \|\| ^12.0 \|\| ^13.0` | Fails — conflicts with root require `^8.75`. Minimum is Laravel 9.46 |
| `php-mcp/server` 3.3.0 (framework-agnostic) | php `>=8.1`, but `symfony/finder ^6.4 \|\| ^7.2` | Fails. Laravel 8.83 pins `symfony/*` to 5.4 (`symfony/finder v5.4.45` in the lock). Also unreleased since 12 Jul 2025 |
| `opgginc/laravel-mcp-server` ^2.0 | php `^8.2` | Fails — resolver lands on `illuminate/contracts v9.52.16` against the Laravel 8 tree |

The framework-agnostic route does not rescue this: PHP MCP servers depend on Symfony 6/7
components, and Laravel 8 holds the whole Symfony tree at 5.4. So the choice is between three
real options, and it needs making before Phase 1:

| Option | Cost | Note |
|---|---|---|
| Hand-roll the JSON-RPC / streamable-HTTP endpoint inside the portal | Medium | The surface is 10 tools — no resources, no prompts, no sampling. Tractable, and we own the transport. No new dependencies, so the Symfony 5.4 pin is irrelevant |
| A separate service beside the portal, talking to it over an internal API | Medium | Matches the spec's "hosted beside the portal". Frees the connector from the Laravel 8 dependency floor entirely — and from PHP, if a TypeScript SDK is preferred |
| Upgrade Laravel 8 → 11+ first, then use `laravel/mcp` | Large | Three majors on a 606-migration app. PHP 8.3 is already in place, so the runtime is not the obstacle. Worth its own decision on its own merits — not something to absorb inside this project |

**Hosting is unresolved.** `APP_URL=http://localhost` ([`.env.example:5`](../.env.example)) and
the repo carries a Laragon vhost. Nothing here indicates a public HTTPS deployment. Claude
connects *inbound* from Anthropic's cloud, so public HTTPS is a precondition for any of this
working at all — not a §13 detail.

---

## 3. Three places the spec contradicts the codebase

### 3.1 "No Anthropic API keys anywhere in the system" is already false

§02 MUST NOT says "No Anthropic API keys or calls anywhere in the system", and §01 puts "any
Anthropic API integration" out of scope. The portal ships a live Messages API integration:

- [`app/Services/Ai/ClaudeCompletionService.php:34`](../app/Services/Ai/ClaudeCompletionService.php) — `POST https://api.anthropic.com/v1/messages`
- [`app/Services/Ecommarise/CaseClaudeService.php:196`](../app/Services/Ecommarise/CaseClaudeService.php) — same, for Amazon case drafts
- `ANTHROPIC_API_KEY` + `CASE_CLAUDE_ENABLED` in [`config/ecommarise.php:202`](../config/ecommarise.php)
- `TaskAiPromptService`, `TestCaseClaude`, `DiagnoseCaseScheduler` all depend on it

Two readings, and they lead to different work:

- **Narrow** (likely intended): *the connector* uses no API keys. Then §01 and §02 need
  rewording, because as written an acceptance test on that invariant fails on day one.
- **Literal:** remove the case-draft AI. That is deleting shipped functionality and should be
  a deliberate product decision, not a side effect of this spec.

**Settle this before anything else** — it is a stated invariant, and §13's acceptance
checklist implies someone will test it.

### 3.2 "Logics & Variables" is not one system

`get_rule_or_variable` (§04) and `kb_chunks.linked_variable_ids` (§08) both assume a single
governed registry that can be addressed by id. The shelf exists as a UI —
`/settings/logics-variables/{department}` ([`routes/web.php:623`](../routes/web.php)) — but
behind it are separate books with separate tables and separate controllers:

| Store | Model |
|---|---|
| `sourcing_variables` | [`app/Models/SourcingVariable.php`](../app/Models/SourcingVariable.php) (`key` / `value`) |
| `hr_config_variables` | `HrConfigVariable` (+ `HrConfigLog`) |
| `inventory_recon_variables` | `InventoryReconVariable` |
| `replenishment_variable_overrides` | `ReplenishmentVariableOverride` |
| `settings` | [`app/Models/Setting.php`](../app/Models/Setting.php) (generic `key` / `value`) |
| Per-module thresholds | `CaseFlagThreshold`, `RevisionAnalyticsThreshold`, `HrFlagDefinition`, `HrClientBonusSlab`, … |

Plus the SLA book, the checklist/SOP book and the dropdown list book, each with its own
controller under the same shelf.

So a **canonical variable-reference layer** has to be built first: a stable reference →
(source store, key, reader, human label, min_role, unit) mapping, with one resolver the
connector calls. Without it, `linked_variable_ids` has nothing to point at and §08's "never a
copied number that can go stale" cannot be honoured.

**Update (15 Sep 2026):** built for Sourcing as
[`app/Services/Connector/VariableRegistry.php`](../app/Services/Connector/VariableRegistry.php),
and it needed no new table. Sourcing already catalogues all 113 of its variables with labels,
units and live-value resolution (`config/sourcing_variables.php` + `SourcingVariableCatalog` +
`SourcingVariableQueryService`), so the registry adapts that rather than copying it into a
second list that would drift from the first. References are `module:key`, e.g.
`sourcing:sup.otd`. A department arriving without a catalogue of its own gets a resolver added
there — the class is the contract, not the storage behind it.

This is still the item most likely to overrun **for the other departments**, and the spec does
not mention it.

### 3.3 No curated DB views exist, and no test-data convention is enforced

A search for `CREATE VIEW` / `createView` across `database/` and `app/` returns nothing across
606 migrations. `read_db_views` therefore means designing and writing the whole view set from
scratch, plus provisioning a read-only MySQL role. Scope that explicitly — "curated views"
sounds like configuration and is actually schema design.

Related: §02 says "Audit runs never touch real client/supplier records — test data (ZZ-prefix)
only."

**Correction (15 Sep 2026):** an earlier draft of this section said no such convention was
enforced. That was wrong — it exists, just not as a name prefix. `is_test_record` is a real
column on `users`, `brands` and `sourcing_orders`
([`2026_09_09_180000_add_test_record_flags.php`](../database/migrations/2026_09_09_180000_add_test_record_flags.php)),
and [`app/Support/Sourcing/TestRecords.php`](../app/Support/Sourcing/TestRecords.php) enforces
the exclusion in queries so totals and scorecards skip flagged rows.

The `ZZ` naming is a separate thing, and a thinner one: `.env.example` describes
`ZZ_PARTNER_TEST_PASSWORD` and a `ZzPartnerTestLoginsSeeder` for partner test logins, but that
block is uncommitted work-in-progress (ZB-087) and no such seeder exists in the tree —
nothing reads that variable. So the connector cannot rely on a name prefix today; the flag is
the only mechanism that is actually enforced.

The work here is therefore smaller than "establish a convention", but it is not nothing: the
curated views must respect `is_test_record` the way `TestRecords` already does, and §02's
wording should say "test-flagged records" rather than "ZZ-prefix", which names the half that
is not built.

---

## 4. Build-order bug in §12

Phase 1 ends with "Then the §08 population prompt runs." That prompt cannot run in Phase 1:

| The prompt requires | §12 puts it in |
|---|---|
| `submit_kb_draft` ("submit every chunk as a DRAFT") | **Phase 3** |
| `read_code` ("the code map") | Phase 2 |
| `read_db_views` ("the read-only data") | Phase 2 |

With only `ask_knowledge` + `get_rule_or_variable` available, a Phase 1 population run has
nothing to read and no way to write. Either pull those three tools forward into Phase 1, or
move the population run to the end of Phase 2.

---

## 5. Two design points worth reconsidering

**The all-scope flag is a single point of total read access.** §10 says scheduled runs are
"Abeer's account, flagged in the connector config". That makes one personal token a
full-portal read key, tied to a human who also uses the portal interactively. A separate
service identity with its own role and its own tool allow-list costs nothing extra, is
revocable without locking a person out, and makes the Activity Log unambiguous about whether a
human or a scheduled run made a call.

**`update_pointer_status` is the one unreviewed terminal write.** §02 says no tool may
"confirm its own task result, approve a pointer, or activate a knowledge version", and every
other Claude output lands in a human gate. But §04 lets a re-verification run set
`Verified-Fixed` directly — and the fix it is verifying was authored by Claude Code (§05
step 7). The verification is genuinely independent of the implementation run, so this is
defensible; it is worth making deliberate rather than incidental. A human sign-off at the
100% module-close gate (which already exists as a milestone in §09) would close it without
adding per-pointer friction.

---

## 6. Suggested re-phasing

| Phase | Contents | Why |
|---|---|---|
| **0 — preconditions** *(new)* | Settle §3.1 (API-key invariant). Choose the connector runtime (§2.1). Stand up OAuth provider + discovery + DCR. Confirm public HTTPS beside the portal. | Nothing else can be tested end-to-end until Claude can reach and authenticate against the portal |
| **1 — read surface** | Canonical variable-reference layer (§3.2) → `kb_chunks` / `kb_versions` + admin screen → `ask_knowledge`, `get_rule_or_variable`, **`submit_kb_draft`** → curated views + read-only role → `read_code`, `read_db_views` → call logging. **Then** the §08 population run | Fixes the §12 ordering bug; puts the registry first because everything else reads through it |
| **2 — the loops close** | AI task queue — extend `AiPrompt` into the versioned instruction store rather than adding `claude_task_instructions`; pointers built on the `SourcingFlagInstance` ↔ `Task` precedent | Both reuse shipped patterns; neither needs new concepts |
| **3 — self-truing** | As specified: auto `kb-sync` at 100%, stale-chunk surfacing, issue-frequency aggregation | Unchanged |

---

## 7. One product consequence to accept up front

With no API keys, `ask_knowledge` retrieval is keyword-grade — MySQL FULLTEXT over
`kb_chunks`, filtered by `module` + `min_role` per §06. Semantic retrieval would need
embeddings, which need the very API the spec excludes. This is a real limit, not a build
shortcut.

Mitigations that work at keyword grade: disciplined chunk titling, the `layer` / `module` /
`source_type` tags doing real filtering work, a tool call that lists a layer's chunk titles so
Claude can navigate rather than guess search terms, and letting Claude issue several queries
per question. Worth stating in the acceptance criteria so retrieval quality is judged against
what the architecture can deliver.

---

## 8. Open questions for the spec owner

1. **§3.1** — narrow or literal reading of "no Anthropic API keys anywhere"?
2. **§2.1** — hand-rolled inside the Laravel app, a separate service beside it, or is a
   Laravel 8 → 11+ upgrade already on the roadmap for other reasons?
3. Is there a public HTTPS deployment target today, or is provisioning one part of this work?
4. **§3.3** — what does the audit environment actually guarantee about test data?
5. **§5** — service identity for scheduled runs instead of a flag on a personal account?
6. Does `get_rule_or_variable` need to reach every store in §3.2 at launch, or is a first
   department (Sourcing, which is the most complete) enough for Phase 1?

---

## 9. Recommendation

### 9.1 Build the connector as a thin separate service; keep the portal private

Not because MCP is hard to hand-roll in PHP — it is not, the surface is 10 tools with no
resources, prompts or sampling. Because of what rides along with it.

**The OAuth server is the part that should not be hand-written.** It is the security-critical
component: an authorization server minting tokens that grant read access to HR salaries,
client pricing and the whole Sourcing book. On Laravel 8 the only route is Passport 10 —
itself out of support — plus hand-written discovery metadata and dynamic client registration.
In a separate service, a maintained OAuth 2.1 implementation and the official MCP SDK cover
both, and the SDK absorbs protocol-version churn while the MCP spec is still moving.

**Splitting costs less than it looks.** The tool logic is PHP either way — role resolution,
the variable registry (§3.2), KB search, task creation all run on existing models and
services. The only difference is whether those are called in-process or over an internal HTTP
API of roughly ten endpoints behind a Sanctum service token. That API is the entire extra
cost, and the tool implementations behind it were being built regardless.

**It also answers a problem this project creates and the spec does not mention.** Laravel 8
stopped receiving security fixes in January 2023, and §02 requires putting the portal on the
public internet so Anthropic's cloud can reach it — an out-of-support framework holding 606
migrations of business data, exposed. With a separate service, the connector is the **only**
internet-facing component and the portal stays on a private network or IP allow-list,
reachable only from it. The connector arrives without the exposure.

| Component | Owns |
|---|---|
| Connector service (public HTTPS) | MCP protocol, OAuth 2.1 AS + DCR + discovery metadata, token lifecycle, rate limiting |
| Portal (private) | One authorize screen + a code-exchange endpoint for identity; the ten tool endpoints; all role scoping, all logging |

The portal never becomes an OAuth server. It answers "who is this, and what is their role",
which it already knows how to do ([`app/Models/User.php:148`](../app/Models/User.php)).

### 9.2 Spike before committing

The riskiest assumption in the spec is that a Claude custom connector will complete an OAuth
handshake against our infrastructure. Everything else is work we can estimate. Prove that
first, with the smallest slice that exercises the whole path:

- the connector service with **one** tool — `get_rule_or_variable` reading `sourcing_variables`
- OAuth against a portal login, end to end, from claude.ai
- one role-gate assertion: a Sourcing user gets the variable, an Account Manager is refused
- every call landing in Activity Logs

If that connects and refuses correctly, the architecture is proven and the remainder is
ordinary Laravel work on the patterns in §1. If it does not, the loss is a spike, not a
project.

### 9.3 Scope cut for Phase 1

Build the variable-reference layer (§3.2) for **Sourcing only**. It is the most complete
department, it is where the audit work already runs, and it proves the resolver pattern.
HR/Finance, Replenishment and the rest get added once the shape is known. Extending a proven
registry is cheap; redesigning one that tried to span five stores on day one is not.

### 9.4 If two stacks are not wanted

A legitimate constraint for a small team, and the fallback is clean: hand-roll MCP inside
Laravel — that part is genuinely fine — but buy identity rather than build it. A managed IdP
in front, and a reverse proxy terminating TLS and handling OAuth, keeps the portal off the
public internet. We still avoid hand-writing an authorization server; we spend money instead
of a second codebase.

**What to avoid in every scenario:** hand-writing the OAuth AS in Laravel 8 *and* exposing the
portal directly. That is the one combination where a mistake is both likely and expensive.

### 9.5 Prerequisites, in order

1. Settle the API-key invariant (§3.1) — almost certainly the narrow reading, which means
   rewording §01/§02 of the spec and keeping the case-draft feature.
2. Decide where public HTTPS lives. Until a deployment target exists, none of this is testable.
3. Run the §9.2 spike.
4. Then Phase 1 as re-ordered in §6.
