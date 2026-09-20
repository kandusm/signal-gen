# signalgen — working guardrails

Read `docs/dm-contract.md` before touching anything that shapes a request to
Design Manager. It is authoritative for every wire shape. Where it disagrees
with `docs/architecture-spec.md`, a build plan, or a phase brief, **the
contract wins and you stop and flag the disagreement** rather than picking a
side.

> Note: the Phase 0 brief cites "build-plan §9" for these guardrails. The build
> plan has eight sections. What follows is drawn from build-plan.md sections 3,
> 4 and 7, architecture-spec.md sections 3, 6 and 11, and the brief's own
> constraints. Worth reconciling at the review gate.

## Never

- **Never point Prisma at a non-local database.** `migrate dev`, `db push`,
  `db execute` and `migrate reset` run against the docker-compose Postgres and
  nowhere else. Supabase gets `migrate deploy`, from the Fly release command,
  and nothing else. `db push` against Supabase is never correct.
- **Never deploy.** `fly deploy`, `fly launch`, `fly secrets` and the
  supervised first real post are Kandus's, not the agent's.
- **Never commit a secret.** `.env` is gitignored; `.env.example` carries
  placeholders only. No key, token or connection string with a real password
  belongs in the repo, in a test fixture, or in a commit message.
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
- **Reuse `@signalgen/contract`.** The wire schema is defined once. Service
  validation, tests and the Phase 4 web form all import it, so drift is a type
  error rather than a production 400.
- **Conventional commits**, on a phase branch, reviewed before merge.

## Scope discipline

Each phase has a brief with explicit stop conditions. Stop at them. Do not
scaffold the next phase's features because they seem obvious — Phase 2 is
Chris's vertical slice and Phase 3 is a pairing exercise, and pre-built
scaffolding takes the learning out of both.

Current phase: **0 — foundation**. Adapters, dedup/fingerprint suppression and
the web app are explicitly out of scope.

## Layout

```
apps/service/       NestJS 11, Node 22. The whole service.
  src/config/       zod-validated env, fail-fast at boot
  src/persistence/  Prisma schema + repositories (the ledger)
  src/dm/           DM client, budgets, retries, taxonomy, sweep cron
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
docker compose up -d db                  # local Postgres, required for migrations
pnpm --filter @signalgen/service migrate:dev
pnpm test                                # offline; no DM or MailWain contact
pnpm build
pnpm seed:candidate                      # dry-run rehearsal, writes one dry_run row
```

## Testing

vitest, in both packages. It runs the TypeScript sources through esbuild, so
there is no ts-jest transform to keep in sync with two tsconfigs, and the same
config shape carries over to the Phase 4 Next.js app.

Time-dependent behaviour (6h TTL, token bucket, trailing 24h, retry schedule)
is tested through the injected `Clock` and `Sleep` from `src/common`. Do not
introduce a test that sleeps.
