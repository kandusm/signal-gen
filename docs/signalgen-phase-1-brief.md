# signalgen — Phase 1 Implementation Brief

**Agent:** Claude Code
**References:** `docs/architecture-spec.md` (§5 adapter framework, §6 DM client, §8 dedup/decay, §9.1 manual), `docs/build-plan.md` (§4 ops model, §6 Phase 1), `docs/dm-contract.md`, `CLAUDE.md`
**Precondition:** Phase 0 merged to `main` after Kandus's review; Docker present; local-first migration authoring in effect.

---

```text
CLAUDE CODE DIRECTIVE — signalgen Phase 1: Pipeline core + manual adapter

Branch phase-1 from main. Read spec §5/§8/§9.1 before writing code.

== 1. DRY_RUN semantics change (supersedes Phase 0 behavior) ==
DRY_RUN skips ONLY the network call. Everything else runs and is
recorded: schema validation, tone gate, fingerprint/dedup decision,
ledger write. And dry_run rows now COUNT toward trailing-24h budget
accounting (total and per-adapter), so adapter caps are testable
without posting. posted + dry_run count; suppressed/rejected/failed
do not. Update BudgetService, /healthz, and the Phase 0 tests that
pinned the old behavior. Record the rule in CLAUDE.md.

== 2. Adapter framework ==
SourceAdapter interface per spec §5, plus:
  fingerprintMaterial(c: CandidateSignal): string   // adapter-defined
AdapterRegistry: adapters register with key + schedule; boot-time
validation that every registered key has a shortcode mapping and a
budget cap. No cron adapters exist yet — registry + lifecycle only.

== 3. Pipeline ==
PipelineService.process(candidate, runCtx) — single entry point for
every adapter, ordered:
  1. schema validate (contract candidateSignalSchema) → rejected_schema
  2. tone gate (existing) → rejected_tone
  3. fingerprint = sha256(adapterKey | fingerprintMaterial(c))
  4. dedup: Fingerprint row lookup; suppressUntil in future →
     Signal row status=suppressed (recorded, per spec §8), update
     lastSeenAt, stop
  5. new/expired → upsert Fingerprint (firstSeen/lastSeen/
     suppressUntil = now + window(adapterKey)), ledger pending,
     hand to DmClient (dispatch or sweep)
Suppression windows from config: SUPPRESS_MANUAL_DAYS=7,
SUPPRESS_SEARCH_DAYS=21.
Concurrency: two identical candidates racing must yield exactly one
pending + one suppressed — use a transaction + unique-conflict
handling on Fingerprint.hash, not a check-then-write. Test the race.
Cron-run adapters will take pg_advisory_lock keyed on adapterKey
(build the helper now, exercised in Phase 2); manual is push-style
and relies on the transactional dedup instead.
Every adapter invocation records an AdapterRun (manual: one per
submission, itemsFetched=1).

== 4. Manual adapter ==
POST /manual/signals:
  - Authorization: Bearer MANUAL_API_TOKEN, constant-time compare,
    401 with empty body on failure
  - Nest throttler: 10/min per IP
  - zod body: operator fields (topic required; subtopic, tone
    required; platform default "Manual"; keywords ≤20, audience,
    sourceUrl, sourceExcerpt ≤500, signalDecayHint default "SHORT")
  - runs PipelineService.process; response 200
    { signalId, status } with the actual pipeline outcome
    (pending|dry_run|suppressed|rejected_schema|rejected_tone)
fingerprintMaterial: lowercase(trim(topic))|lowercase(trim(subtopic??""))

== 5. Tests ==
- dedup: window boundary (suppressUntil exactly now), expiry refire,
  suppressed row recorded with correct status
- race: concurrent identical submissions → 1 pending + 1 suppressed
- budget: dry_run rows counted (new semantics), suppressed/rejected
  not counted
- endpoint: auth (constant-time path), throttle, outcome statuses
- alerting: mocked DM 401/400 → failed_permanent + alert payload
  contains signalId + status

== 6. Migrations ==
No schema change is expected (Fingerprint, AdapterRun, nextAttemptAt
all exist). If one proves necessary: author via migrate dev against
local Docker Postgres, flag it in your report, and it reaches
Supabase only via the standing ops model (Kandus's go).

== Constraints ==
No search adapter, no Brave client, no web app, no cron adapters.
Native fetch only. Conventional commits on phase-1.

== Stop conditions ==
1. pnpm test green from clean checkout (Phase 0 suites updated for
   the DRY_RUN semantics, not deleted).
2. Local (Docker db): two identical manual submissions via curl →
   first dry_run, second suppressed, both visible in ledger;
   /healthz budget shows the dry_run row consumed manual quota.
3. Same demonstration against Supabase (DRY_RUN=true) — report row
   ids.
4. Supervised real post (Kandus's go, budget cap 1): one manual
   signal through the endpoint, 202 in ledger, verified in DM's
   Signal Review Queue; then a forced-failure drill (Kandus
   temporarily invalidates DM_SIGNAL_KEY): resubmission →
   failed_permanent + MailWain alert received. Restore key + caps.
5. Stop. Diff review before merge; deploys only on explicit go.
```

---

## Review gate (Kandus + Chris)

- [ ] Race test actually exercises concurrency (parallel awaits against one DB, not sequential calls)
- [ ] Constant-time token compare (timingSafeEqual, length-guarded), no token in logs
- [ ] Suppressed rows carry enough context to audit what dedup is eating (fingerprint, adapterKey, topic)
- [ ] Budget semantics: dry_run counted, one query path, /healthz truthful
- [ ] Forced-failure drill: alert email actually arrived via MailWain, correct template
- [ ] Chris walk: pipeline order (why tone gate before fingerprint), the race handling, and the DRY_RUN-counts-budget rationale — this is the Phase 2 dry-run testability story
