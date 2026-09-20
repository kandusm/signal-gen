# signalgen — Build Plan v1.0

**Companion to:** Architecture Spec v1.1
**Agent:** Claude Code
**Roles:** Kandus — architect, reviewer, deployer. Chris — reviewer (P0–P1), owner (P2, P4), pair (P3). Claude — brief authorship. Claude Code — execution.

---

## 1. Platform summary (final)

| Layer | Platform |
|---|---|
| Service | NestJS / Node 22 → Fly.io, single machine, Dockerfile deploy |
| Web (P4) | Next.js → Vercel |
| Database | Supabase Postgres (dedicated project `signalgen`) |
| ORM/migrations | Prisma — `migrate dev` locally, `migrate deploy` in Fly release command |
| Alerts | MailWain |
| Repo | GitHub, pnpm workspaces monorepo |

## 2. Repo layout

```
signalgen/
  apps/
    service/          # NestJS — Fly.io
    web/              # Next.js — Vercel (created in Phase 4)
  packages/
    contract/         # zod schemas: DM POST /api/signals payload, CandidateSignal
  docker-compose.yml  # local Postgres for prisma migrate dev
  fly.toml
```

`packages/contract` is deliberate: the DM contract schema is defined once and consumed by service validation, tests, and (P4) the web form. Contract drift shows up as a type error, not a production 400.

## 3. Migration workflow

- Local dev: Docker Postgres (`docker-compose up db`); Claude Code runs `prisma migrate dev` there — shadow DB works, Supabase never sees experimental migrations.
- Production: `fly deploy` → release command runs `prisma migrate deploy` against Supabase via `DIRECT_URL` before new machine takes traffic.
- Rule: migration SQL is reviewed like code. No `db push` against Supabase, ever.

## 4. Deploy flow (no staging)

1. Claude Code works on a branch; Kandus reviews diff; merge to `main`.
2. Service: `fly deploy` manually by Kandus (Fly auth is his). Web: Vercel auto-deploy on `main` (P4+).
3. `DRY_RUN=true` is the default for every new adapter until its supervised first post (budget cap temporarily 1, watch the ledger, flip the cap back).

## 5. Provisioning checklist (Kandus, before Phase 0 execution)

- [ ] Supabase project `signalgen` → `DATABASE_URL` (pooled), `DIRECT_URL`
- [ ] Fly app `signalgen` + region + auth for deploys
- [ ] GitHub repo, Chris added
- [ ] `DM_SIGNAL_KEY` value; `MAILWAIN_*` creds; generate `MANUAL_API_TOKEN`
- [ ] **OQ-1:** paste DM field-by-field contract into Phase 0 brief
- [ ] **OQ-3:** DM rate-window semantics (rolling vs calendar day, TZ)
- [ ] Phase 3: Reddit script app creds. Phase 4: Vercel project.

---

## 6. Phases

Each phase = one brief → Claude Code execution → review gate → deploy. Directives below are paste-ready skeletons; P1–P4 get expanded to full briefs at phase start per standard workflow.

### Phase 0 — Foundation
**Scope:** monorepo scaffold, contract package, config+zod fail-fast, Prisma schema + initial migration, DM client (bearer, 10/min token bucket, daily budget, taxonomy cache w/ persisted snapshot, POST with retry schedule + ULID-first ledger write), dry-run mode, healthz, MailWain notifier, Dockerfile, fly.toml, local docker-compose.
**Out:** all adapters, dedup, web.
**Stop conditions:** hand-built candidate passes schema+taxonomy validation and lands in ledger as `dry_run`; unit tests green; `fly deploy` succeeds with migrations applied; one supervised real signal visible in DM's review queue.
**Review gate:** Kandus reviews; Chris code-walk session (brief anatomy, why dry-run, ledger-before-post).

```text
CLAUDE CODE DIRECTIVE — signalgen Phase 0

Context: greenfield monorepo per signal-generator-architecture-spec.md §3–§7
(file included in repo root as docs/architecture-spec.md). Read it first.

Build:
1. pnpm workspaces monorepo: apps/service (NestJS, Node 22), packages/contract.
2. packages/contract: zod schema for DM POST /api/signals payload
   [INSERT OQ-1 FIELD CONTRACT HERE], plus CandidateSignal internal type.
3. apps/service:
   - ConfigModule: zod-validated env (DATABASE_URL, DIRECT_URL, DM_BASE_URL,
     DM_SIGNAL_KEY, MANUAL_API_TOKEN, MAILWAIN_*, DRY_RUN, per-adapter caps).
     Fail-fast on invalid.
   - Prisma schema per spec §7; initial migration.
   - DmClientModule: bearer auth; token bucket 10/min; DailyBudget counter
     keyed per [INSERT OQ-3 WINDOW/TZ]; taxonomy GET cached 6h with
     TaxonomySnapshot fallback; postSignal(): ledger row (ULID, pending)
     BEFORE first attempt, retries 1m/5m/30m/2h/6h on 5xx/network,
     failed_permanent on non-429 4xx, alert hooks on both.
   - NotifyModule: MailWain client, alert templates per spec §10.
   - HealthModule: /healthz per spec §10, wired to fly.toml checks.
   - DRY_RUN short-circuits POST, writes status=dry_run.
4. Dockerfile (multi-stage), fly.toml (count=1, release_command
   "prisma migrate deploy"), docker-compose.yml (local Postgres).
5. Tests: contract schema round-trip; budget accounting incl. window
   rollover; retry state machine; taxonomy cache fallback.

Constraints: no adapters, no dedup, no queue libs, native fetch only.
Stop when: tests green, dry-run candidate script (scripts/seed-candidate.ts)
produces a dry_run ledger row end-to-end. Do not deploy; Kandus deploys.
```

### Phase 1 — Pipeline core + manual adapter
**Scope:** fingerprint (sha256 canonicalization per spec §8), suppression windows, Fingerprint table lifecycle, per-adapter budget enforcement, `pg_advisory_lock` run guard, retry sweep cron, `POST /manual/signals` (bearer + throttle) feeding the pipeline, `adapter_runs` recording.
**Stop conditions:** manual signal posts for real (supervised); identical resubmission within 7-day window lands as `suppressed`; alert fires on a forced permanent failure.
**Review gate:** Kandus reviews; Chris walks the pipeline with the ledger open.

### Phase 2 — Calendar adapter (Chris-led)
**Scope:** event registry data file (Chris drafts content: occupation-pride + hobbyist observances, leadDays, taxonomy mapping), nth-weekday date rules with table-driven tests, 90-day lookahead cron, year-inclusive fingerprints.
**Stop conditions:** dry-run emits hand-verified signal set for next 90 days; one supervised real post.
**Process:** Chris writes the brief from spec §9.1; Kandus reviews brief before execution; Chris drives Claude Code and the review.

### Phase 3 — Reddit adapter (pair)
**Scope:** OAuth2 client-credentials token manager, thin fetch client, config-file watchlist (OQ-4), top/hot polling, keyword→taxonomy mapping with `taxonomyAligned` flag, excerpt cap 500 chars, engagementMetrics, 21-day suppression, reddit daily cap ≤ 100.
**Stop conditions:** dry-run over live watchlist within caps, mappings verified; supervised real post; token-refresh failure path alerts.

### Phase 4 — Web (Vercel, Chris-led)
**Scope:** apps/web Next.js: manual-entry form (server action → `/manual/signals`, token server-side only, shared contract schema for client-side validation), read-only ops views (ledger w/ status filter, adapter runs, today's budget) reading Supabase via server-side Prisma.
**Stop conditions:** Chris submits a signal through the UI end-to-end; ops views match ledger truth; no secrets shipped to browser (verified).
**Open at phase start:** web auth choice — Supabase Auth with allowlisted emails vs simpler shared-secret gate. Decide in the Phase 4 brief.

---

## 7. Risk register

| Risk | Mitigation |
|---|---|
| Contract drift vs DM (schema reconstructed from memory) | OQ-1 pasted verbatim into contract package before Phase 0 |
| No staging | DRY_RUN default + supervised first posts with budget cap 1 |
| Double-fired crons | Fly `count=1` + advisory locks |
| Reddit auth/ToS | Client-credentials script app, minimal storage, excerpt caps |
| Budget desync with DM (429s) | Client-side accounting + alert on any 429 as an accounting bug |

## 8. Sequencing

P0 → P1 sequential (P1 depends on client + ledger). P2 can start once P1's pipeline interfaces are merged. P4 can run parallel to P3 if Chris has bandwidth — it only depends on P1's endpoint and the ledger schema.
