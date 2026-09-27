# signalgen — Phase 0 Implementation Brief

**Agent:** Claude Code
**References (committed in repo):** `docs/architecture-spec.md` (v1.2), `docs/build-plan.md`, `docs/dm-contract.md`
**Prerequisites (Kandus):** repo created with docs committed; local Docker available. No Supabase/Fly credentials needed for this phase — everything runs against local Postgres; Kandus deploys.

---

```text
CLAUDE CODE DIRECTIVE — signalgen Phase 0: Foundation

Read docs/architecture-spec.md and docs/dm-contract.md before writing code.
dm-contract.md is authoritative for all wire shapes; the schemas below
restate it for convenience — if they ever disagree, the doc wins and you
stop and flag it.

== 1. Monorepo ==
pnpm workspaces:
  apps/service        NestJS 11, Node 22 (pin via packageManager + engines)
  packages/contract   zod schemas + types, no runtime deps besides zod
docker-compose.yml    local Postgres 16 for prisma migrate dev
No apps/web yet.

== 2. packages/contract ==
Export:

a) dmSignalPayloadSchema (zod) — wire contract for POST /api/signals:
   Required:
     signalId       string ≤64
     capturedAt     ISO 8601 datetime string
     sourceKey      string ≤32
     topic          string ≤128
     tone           string            (taxonomy check is runtime, not schema)
     platform       string
   Recommended (all optional in schema):
     subtopic       string ≤128
     subplatform    string ≤128
     keywords       string[] max 20
     audience       string ≤128
     sourceUrl      URL string
     sourceAuthor   string ≤128
     sourceExcerpt  string ≤500
     engagementMetrics  { views?, likes?, comments?, shares? } ints, nullable
     observedAt     ISO 8601 datetime string
     signalDecayHint  enum "IMMEDIATE" | "SHORT" | "EVERGREEN"
   Optional:
     extensions     record, refine: JSON.stringify length ≤ 8192
   .strict() — unknown keys rejected.

b) taxonomyResponseSchema — { categories: [{ name, subcategories: string[] }],
   tones: string[] } per dm-contract.md.

c) CandidateSignal type — internal: everything an adapter emits.
   adapterKey ("manual" | "reddit" for now, open string union), plus all
   wire fields EXCEPT signalId and sourceKey (pipeline assigns those),
   plus taxonomyAligned: boolean.

d) dmResponseSchemas — 202 {signalId,status:"ACCEPTED",matchingScheduled},
   200 {signalId,status:"DUPLICATE",originalCapturedAt},
   400 {error:"VALIDATION_FAILED",details:[{field,message}]},
   429 {error:"RATE_LIMITED",limit,retryAfter}.

== 3. apps/service ==
ConfigModule (zod-validated env, fail-fast at boot):
  DATABASE_URL, DIRECT_URL, DM_BASE_URL, DM_SIGNAL_KEY,
  GENERATOR_SOURCE_KEY (default "signalgen-v1"), MANUAL_API_TOKEN,
  MAILWAIN_BASE_URL, MAILWAIN_API_KEY, ALERT_TO, DRY_RUN (default true),
  BUDGET_TOTAL_24H (500), BUDGET_MANUAL_24H (50), BUDGET_SEARCH_24H (100).

Prisma schema exactly per architecture-spec §7 (Signal, Fingerprint,
AdapterRun, TaxonomySnapshot). Initial migration via migrate dev against
local Postgres only. NEVER point prisma at a non-local database.

DmClientModule:
  - postSignal(candidate → payload):
    * assign signalId "{shortcode}_{ULID}" (man_/srch_ by adapterKey,
      config-driven map), sourceKey from GENERATOR_SOURCE_KEY
    * write Signal row status=pending BEFORE first network attempt
    * validate payload with dmSignalPayloadSchema; failure →
      status=rejected_schema, no send
    * headers: Authorization Bearer, Content-Type, Idempotency-Key=signalId
    * DRY_RUN=true → skip network, status=dry_run, stop
    * response handling per architecture-spec §6:
      202→posted; 200 DUPLICATE→posted + anomaly log;
      400/401→failed_permanent + alert;
      429→wait Retry-After, retry, alert always;
      5xx/network→retry schedule 1m/5m/30m/2h/6h then failed + alert.
      Persist dmStatusCode + parsed dmResponse on every terminal state.
  - Rate guards, checked BEFORE dispatch:
    * token bucket 10/min (in-process)
    * trailing-24h counts from Signal table (posted, postedAt > now-24h):
      total < BUDGET_TOTAL_24H and per-adapter < its cap. Over budget →
      leave pending; a sweep cron (every 5 min) drains pending rows
      oldest-first within budget. This sweep also owns the retry schedule
      (nextAttemptAt column — add it to Signal).
  - TaxonomyModule: GET /api/secondarydesigns/categories, cache 6h in
    memory, persist TaxonomySnapshot on each successful fetch, fall back
    to latest snapshot when DM unreachable at boot. Expose
    isValidTone(t), isAlignedCategory(topic, subtopic).
  - Tone gate: candidate with invalid tone → status=rejected_tone, alert
    on first occurrence per adapter per day (contract drift smell).

NotifyModule: MailWain client; alert templates: permanent failure, retry
exhaustion, 429 observed, adapter run failures (wired in Phase 1),
tone rejection. Include signalId + ledger status in every alert body.

HealthModule: GET /healthz — DB reachable, taxonomy snapshot age,
trailing-24h usage total + per adapter. Wire into fly.toml checks.

== 4. Ops files ==
Dockerfile: multi-stage, prod deps only, runs migrations NEVER (release
command does). fly.toml: single machine intent, http_service on internal
port, checks → /healthz, release_command "npx prisma migrate deploy".
docker-compose.yml: postgres:16 with volume. .env.example: every var,
placeholder values, comments. CLAUDE.md: guardrails per build-plan §9.

== 5. Tests (vitest or jest — pick one, note why) ==
- contract: payload schema accepts the exact sample body from
  dm-contract.md; rejects >64 signalId, 21 keywords, >8KB extensions,
  unknown keys, bad decay enum.
- budget: trailing-24h counting incl. per-adapter caps and boundary at
  exactly now-24h; sweep drains oldest-first.
- retry: state machine transitions incl. 200 DUPLICATE and Retry-After.
- taxonomy: cache TTL, snapshot fallback, isValidTone.
- scripts/seed-candidate.ts: builds one valid CandidateSignal and runs it
  through the full path in DRY_RUN → asserts a dry_run ledger row.

== Constraints ==
Native fetch only (no axios/got). No queue libraries. No adapters yet —
manual/reddit modules do not exist in this phase. Do not install
anything against Supabase or Fly. Do not deploy. Conventional commits.

== Stop conditions ==
1. pnpm install && pnpm test green from clean checkout + compose db up.
2. seed-candidate script produces status=dry_run row end-to-end.
3. pnpm build produces runnable service; /healthz returns truthful state
   against local Postgres.
4. Diff reviewed by Kandus before merge. Kandus runs fly launch/deploy
   and the supervised first real post (budget cap 1) — not you.
Stop at these conditions. Do not scaffold Phase 1 features.
```

---

## Review gate (Kandus + Chris)

- [ ] Contract schema vs `docs/dm-contract.md` line-by-line (Chris drives this check — best possible contract-reading exercise)
- [ ] Ledger-before-post ordering verified in code, not just tests
- [ ] Rate guards run before dispatch; sweep respects both budgets
- [ ] No secret material anywhere in repo; `.env.example` placeholders only
- [ ] Supervised first post: flip `DRY_RUN=false` with total budget 1, post one manual-built signal, verify `202 ACCEPTED` in ledger **and** correct rendering in DM's Signal Review Queue after matching (<60s), then restore caps
