# signalgen — Build Plan v1.0

**Companion to:** Architecture Spec v1.1
**Agent:** Claude Code
**Roles:** Kandus — architect, reviewer, deployer. Chris — reviewer (P0–P1), pair (P2 search), owner (P3 web). Claude — brief authorship. Claude Code — execution.

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
    web/              # Next.js — Vercel (created in Phase 3)
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
- [ ] **OQ-1:** drop the DM endpoint documentation into the repo as `docs/dm-contract.md`
- [ ] **OQ-3:** DM rate-window semantics (rolling vs calendar day, TZ) — from the docs or stated
- [ ] Phase 2: Brave Search API key (self-serve; card required even for the free credit). Phase 3: Vercel project.
- [ ] Async (2b, no code): submit Reddit Data API commercial-access application — approval later unlocks the §15 Reddit adapter

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
2. packages/contract: zod schema for DM POST /api/signals payload derived
   verbatim from docs/dm-contract.md (committed endpoint documentation),
   plus CandidateSignal internal type.
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

### Phase 2 — Search adapter, Brave (pair: Chris drafts, Kandus co-reviews)
**Scope:** thin Brave client (single GET, `X-Subscription-Token`, native fetch), config-file query watchlist (OQ-4: open-web + Reddit-scoped `site:reddit.com/r/…` entries, freshness pd/pw, `maxCandidatesPerRun`, taxonomy mappings), URL canonicalization + URL-based fingerprints (21-day suppression), platform derivation from result URL (`Reddit`/`r/X` vs `Web`/domain), snippet→sourceExcerpt ≤500, no engagementMetrics, search daily cap ≤ 100, `srch_` shortcode.
**Stop conditions:** DRY_RUN over the live watchlist stays within caps with correct mappings; ledger review quantifies Reddit-scoped query freshness (this **is** the Brave-Reddit coverage test — thin results are a watchlist edit, not a code change); supervised real post; Brave error/quota-exhaustion path alerts.
**Note:** Brave attribution requirement is satisfied in Phase 3's web footer.

### Phase 2b — Reddit application (async, no code)
Submit Reddit Data API commercial-access application now. On approval, the §15 Reddit adapter becomes a normal phase brief; nothing blocks on it.

### Phase 3 — Web (Vercel, Chris-led)
**Scope:** apps/web Next.js: manual-entry form (server action → `/manual/signals`, token server-side only, shared contract schema for client-side validation), read-only ops views (ledger w/ status filter, adapter runs, today's budget) reading Supabase via server-side Prisma.
**Stop conditions:** Chris submits a signal through the UI end-to-end; ops views match ledger truth; no secrets shipped to browser (verified).
**Process:** Chris writes the brief; Kandus reviews brief before execution; Chris drives Claude Code and the review — his end-to-end vertical slice.
**Open at phase start:** web auth choice — Supabase Auth with allowlisted emails vs simpler shared-secret gate. Decide in the Phase 3 brief.

---

## 7. Risk register

| Risk | Mitigation |
|---|---|
| Contract drift vs DM over time | Contract schema derives verbatim from committed `docs/dm-contract.md`; any DM-side change updates that doc first |
| No staging | DRY_RUN default + supervised first posts with budget cap 1 |
| Double-fired crons | Fly `count=1` + advisory locks |
| Brave's Reddit coverage thin/stale for `site:` queries | Measured empirically in Phase 2 dry-run ledger; watchlist is config — open-web queries unaffected; Reddit API application (2b) is the fallback path |
| Search adapter licensing | Brave API output consumed under Brave's commercial terms; attribution shipped in web footer; no scraping anywhere |
| Budget desync with DM (429s) | Client-side accounting + alert on any 429 as an accounting bug |

## 8. Sequencing

P0 → P1 sequential (P1 depends on client + ledger). P2 (Reddit) starts once P1's pipeline interfaces are merged. P3 (web) can run parallel to P2 — it only depends on P1's endpoint and the ledger schema, and parallel work gives Chris his slice sooner.

## 9. Pre-flight (before first CC session)

**DM-side:**
- [ ] Commit the existing endpoint documentation as `docs/dm-contract.md` — the contract package derives from it verbatim. Confirm it covers: success response shape, duplicate-signalId replay behavior, error body format, and rate-window semantics (OQ-3). Any gap there gets one clarifying curl before Phase 0, not during it.
- [ ] Export the current taxonomy dump (valid Category/Subcategory/Tone) — needed for the Reddit keyword→taxonomy map and the manual/web form options.
- [ ] DM reachability from Fly: if DM's IIS ingress allowlists source IPs, Fly egress is dynamic — needs a Fly static egress IP or an open (auth-only) endpoint. Decide now, not at first deploy. (AdPush→DM calls may already answer this.)

**Claude Code harness:**
- [ ] `CLAUDE.md` at repo root: conventions, commands, and hard guardrails — never run migrations against Supabase, never deploy, never touch `fly.toml` secrets sections, local Docker Postgres only.
- [ ] `docs/architecture-spec.md` + `docs/build-plan.md` + `docs/dm-contract.md` committed before session 1; directives reference them.
- [ ] `.env.example` complete. **Secrets policy (pre-production):** prod secrets MAY be staged in `apps/service/.env.local` for integration testing — gitignored, excluded from the Docker context, invisible to Prisma CLI (env split), and blocked from `migrate dev` by `assert-local-db.mjs`. `DRY_RUN=true` stays on in any environment holding them except supervised posts. **At production cutover:** remove staged secrets from dev, rotate `DM_SIGNAL_KEY` + MailWain key, and prod secrets live only in `fly secrets` / Vercel env thereafter.
- [ ] Pin Node 22.x, pnpm version (packageManager field), Prisma version.

**Time discipline:**
- [ ] All storage/wire timestamps UTC ISO-8601; anything user-facing renders in America/Chicago. Codify in Phase 0.

**Team readiness (before P2/P3):**
- [ ] Chris: GitHub access, local Docker + pnpm working, Claude Code seat/auth, one dry-run session on a toy task before he drives P3.
- [ ] Agree the review convention (PR review vs branch walkthrough) while it's cheap.

**End-to-end acceptance:**
- [ ] "Supervised first post" includes eyeballing the signal in DM's Signal Review UI — rendering correctly there, not just returning 200, is the done condition.

**Deferred flags:**
- [ ] Reddit Data API (2b): commercial-use approval required beyond the free tier — application runs async; no phase blocks on it.
- [ ] Migrations forward-only; destructive changes use expand/contract. Irrelevant at greenfield, cheap to state now.

