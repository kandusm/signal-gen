# signalgen — working guardrails

Read `docs/dm-contract.md` before touching anything that shapes a request to
Design Manager. It is authoritative for every wire shape. Where it disagrees
with `docs/architecture-spec.md`, a build plan, or a phase brief, **the
contract wins and you stop and flag the disagreement** rather than picking a
side.

Sources: build-plan.md §9 (pre-flight), §3 (migrations) and §4 (deploy flow);
architecture-spec.md §3, §6 and §11.

## Never

- **Never run `migrate dev`, `db push`, `db execute` or `migrate reset`
  against anything but local Postgres.** These create and drop shadow
  databases and offer to reset their target. Supabase changes go through
  `migrate deploy` only — see *Operations*. Two of the three mechanisms under
  *Secrets policy* exist to enforce exactly this.
- **Never migrate or deploy without an explicit in-session go.** See
  *Operations*. The agent operates these; it does not decide when they run.
- **Never edit secrets in `fly.toml`.** Secrets reach the service through
  `fly secrets` and Vercel env, never a committed file (build-plan.md §9).
- **Never weaken the three secret guardrails.** They are what make staged
  production secrets acceptable at all — see *Secrets policy* below. Removing
  any one of them is not a refactor.
- **Never commit a secret.** `.env` and `.env.local` are gitignored and
  excluded from the Docker build context; `.env.example` carries placeholders
  only. No key, token or connection string with a real password belongs in the
  repo, in a test fixture, or in a commit message. Staging a real value in
  `.env.local` is permitted (below); committing one never is.
- **Never take a session-level advisory lock.** Advisory locks are
  transaction-scoped only (`pg_try_advisory_xact_lock`, via
  `AdvisoryLockService`): through Supabase's transaction pooler a
  session-level unlock can land on a different backend and leave the lock held.
- **Never add a queue library.** BullMQ/Redis were considered and rejected: at
  a 500/day ceiling the DB-backed ledger provides the same durability
  (architecture-spec.md section 3).
- **Never add an HTTP client.** Native `fetch` only — no axios, got, or
  snoowrap.
- **Never post from a test.** The suite must be runnable offline. Anything
  that would reach DM or MailWain is faked.

## Always

- **Ledger before network.** A `Signal` row exists, with its final `signalId`,
  before the first POST attempt. This is what makes a crash mid-dispatch
  recoverable instead of ambiguous. Both the ordering and a test that asserts
  it must survive any refactor.
- **Rate guards before dispatch.** The 10/min token bucket and the trailing-24h
  budgets are checked before the request, not after a 429. A 429 from DM is
  treated as a bug in our accounting and is always alerted.
- **`DRY_RUN` defaults to true.** Every new adapter's first deploy runs in
  dry-run. A missing or unparseable value must never resolve to "post for
  real".
- **`DRY_RUN` skips only the network call** (Phase 1 brief §1). Schema
  validation, the tone gate, dedup, the rate guards and the ledger write all
  run. A `dry_run` row counts toward the trailing-24h budgets (total and
  per-adapter) exactly as `posted` does, with `postedAt` stamped as when it
  would have been sent; `suppressed`, `rejected_*` and `failed*` never count.
  That is what makes adapter caps testable without posting. A row that has
  already made a real attempt is never relabelled `dry_run`.
- **Reuse `@signalgen/contract`.** The wire schema is defined once. Service
  validation, tests and the Phase 4 web form all import it, so drift is a type
  error rather than a production 400.
- **UTC everywhere it is stored or sent.** All DateTime columns are
  `Timestamptz(3)`, the container runs `TZ=UTC`, and `toWireTimestamp`
  (`src/common/time.ts`) is the only way a timestamp is formatted for DM.
  Anything user-facing renders in `America/Chicago` — nothing does yet
  (build-plan.md §9).
- **Migrations are forward-only.** Destructive changes use expand/contract.
  The one exception was regenerating the initial migration before it had ever
  been applied; once a migration has run anywhere, it is immutable. See
  *Operations* for how they reach Supabase.
- **Pinned toolchain.** Node 22.x (`engines`), pnpm (`packageManager`) and
  Prisma (exact version, CLI and client together) are pinned per
  build-plan.md §9. Do not loosen them to a caret range.
- **Conventional commits**, on a phase branch, reviewed before merge.

## Operations

The agent operates **all** migrations and **all** service deploys. This
supersedes the earlier "never deploy / never migrate Supabase" rules
(build-plan.md §4 and §9, recommitted).

### Two paths

**Standard — code and schema together.**

```bash
fly deploy        # its release_command runs `prisma migrate deploy`
```

The release command applies migrations against Supabase before the new machine
takes traffic. This is the default; prefer it whenever a schema change ships
with code.

**Schema-only — when a change must land without a code release.**

```bash
pnpm --filter @signalgen/service migrate:deploy:remote
```

Runs `prisma migrate deploy` against `DIRECT_URL` explicitly, and prints host,
port, user and database before doing anything, so which database was touched is
never a guess afterwards. `migrate:status:remote` reads the same target.

Use it only when there is no accompanying release; otherwise the two paths can
disagree about what is deployed.

### Which URL is which

`DIRECT_URL` is the Supabase **session pooler**
(`...pooler.supabase.com:5432`), not `db.<ref>.supabase.co` — the direct host
resolves IPv6-only and is unreachable from an IPv4 network. `DATABASE_URL` is
the **transaction pooler** on `:6543` and must carry `?pgbouncer=true`, without
which Prisma's prepared statements fail intermittently under concurrency.

Both use the `postgres.<project-ref>` username; only the direct host uses bare
`postgres`. A URL pairing the direct host with a pooler port will not connect.

### Trigger discipline

A Supabase migration or a `fly deploy` happens **only** on Kandus's explicit
in-session go, **after he has reviewed the diff**. Never self-initiated. Never
bundled into unrelated work — if a task happens to need a schema change, stop
and ask rather than folding a migration into the change that motivated it.

A go is for one operation. It does not carry forward to the next one.

### After every deploy or remote migration

Verify both, and report the results before doing anything else:

```bash
curl -s https://<app>/healthz | jq        # or localhost:3000 when local
pnpm --filter @signalgen/service migrate:status:remote
```

`migrate status` must report no pending migrations and no failed ones. A
failed migration is reported, not silently retried — `migrate resolve` is a
decision, not a cleanup step.

### Hard lines that did not change

- `migrate dev` / `db push` / `migrate reset` never touch Supabase.
- `scripts/assert-local-db.mjs` stays, on `migrate:dev` and `migrate:reset`.
- Migrations are forward-only; destructive changes use expand/contract.
- `fly.toml` secrets sections are never edited; secrets live in `fly secrets`.
- `DRY_RUN` discipline stands (see *Secrets policy*).

## Secrets policy

build-plan.md §9 permits **real production secrets to be staged in
`apps/service/.env.local` pre-production**, for integration testing against
live Supabase and DM. That permission is conditional on three mechanisms, and
they are load-bearing rather than decorative:

1. **The env split.** `.env` is local development and is the only file
   Prisma's CLI reads. `.env.local` overrides it for the service and is
   invisible to Prisma — so a Supabase URL staged there cannot reach
   `prisma migrate dev`, which creates and drops a shadow database and offers
   to reset its target.
2. **`scripts/assert-local-db.mjs`.** Runs before `migrate:dev` and
   `migrate:reset` with only `.env` loaded, and exits non-zero if
   `DATABASE_URL` or `DIRECT_URL` names a non-local host.
3. **`.dockerignore`.** Patterns are `**`-prefixed because `.dockerignore`
   matches only at the context root; a bare `.env` would not exclude
   `apps/service/.env.local` from a `COPY . .`. The prune stage deletes any
   that slip through anyway.

> **TEMPORARY (2026-09-27, Kandus's ruling) — no real posts until DM's
> idempotency fix is verified.** `DRY_RUN` stays `true` everywhere after the
> Phase 1 supervised session. DM currently answers 201 with its own id instead
> of 202 echoing ours, and does not yet dedup on `Idempotency-Key`/`signalId`,
> so a retry after a transport error that actually landed can double-post.
> Remove this note only once a replayed signalId is shown to return
> `200 DUPLICATE`.

**`DRY_RUN=true` is mandatory** in any environment holding staged secrets. The
sole exception is a supervised first post: budget capped at 1, a human
watching the ledger, both restored afterwards.

**At production cutover:** remove the staged secrets from the dev environment,
rotate `DM_SIGNAL_KEY` and the MailWain key, and keep production secrets only
in `fly secrets` and Vercel env from then on.

If a migration command is being awkward, fix the URL — do not bypass a guard.

## Scope discipline

Each phase has a brief with explicit stop conditions. Stop at them. Do not
scaffold the next phase's features because they seem obvious — Phase 2 is
Chris's vertical slice and Phase 3 is a pairing exercise, and pre-built
scaffolding takes the learning out of both.

Current phase: **1 — pipeline core + manual adapter**
(`docs/signalgen-phase-1-brief.md`). The search adapter, Brave client, cron
adapters and the web app are explicitly out of scope.

Roadmap, as revised: Phase 1 pipeline core + manual adapter; Phase 2 the Brave
Search adapter (pair); Phase 3 the Vercel web app (Chris-led). The calendar
adapter is dropped and a direct Reddit adapter is deferred behind a commercial
access application — until then Reddit content is reached through
`site:reddit.com/r/...` search queries and arrives under `adapterKey: "search"`.

## Layout

```
apps/service/       NestJS 11, Node 22. The whole service.
  src/config/       zod-validated env, fail-fast at boot
  src/persistence/  Prisma schema + repositories (the ledger)
  src/dm/           DM client (dispatch), budgets, retries, taxonomy, sweep cron
  src/pipeline/     stage order: schema → policy → tone → dedup → ledger → dispatch
  src/adapters/     SourceAdapter, AdapterRegistry; one directory per adapter
  src/notify/       MailWain alerts
  src/health/       GET /healthz
  scripts/          seed-candidate.ts — the dry-run rehearsal
packages/contract/  zod schemas and types. Depends on zod and nothing else.
docs/               Reference documents. dm-contract.md is authoritative.
```

Adding a source later means a new directory under `src/adapters/` and one
module registration. If a change requires touching the pipeline to add an
adapter, the adapter boundary is wrong.

## Commands

```bash
pnpm install
cp apps/service/.env.example apps/service/.env
docker compose up -d db                  # local Postgres, required for migrations
pnpm --filter @signalgen/service migrate:dev
pnpm test                                # offline; no DM or MailWain contact
pnpm build
pnpm seed:candidate                      # dry-run rehearsal, writes one dry_run row
```

Env files live in `apps/service/` (Prisma does not search up to the workspace
root). `.env` is local development and is the only one Prisma reads;
`.env.local` holds staged Supabase credentials and overrides `.env` for the
service itself.

## Testing

vitest, in both packages. It runs the TypeScript sources through esbuild, so
there is no ts-jest transform to keep in sync with two tsconfigs, and the same
config shape carries over to the Phase 4 Next.js app.

Time-dependent behaviour (6h TTL, token bucket, trailing 24h, retry schedule)
is tested through the injected `Clock` and `Sleep` from `src/common`. Do not
introduce a test that sleeps.

`test/db/` holds what an in-memory fake cannot prove — above all the dedup
race (two identical candidates → exactly one `pending`). It needs local
Postgres and is skipped by the offline `pnpm test`:

```bash
docker compose up -d db
pnpm --filter @signalgen/service test:db   # creates signalgen_test, migrates, runs
```

`test:db` runs `assert-local-db.mjs` first and uses `127.0.0.1`, not
`localhost`: on Windows the latter tries IPv6 first and stalls each new
connection ~2s, which is Prisma's transaction `maxWait`.

Nest DI in a test runs through esbuild, which emits no parameter-type
metadata. A class resolved by Nest in tests needs explicit `@Inject(Token)`
on its constructor parameters, or its dependencies arrive `undefined`.
