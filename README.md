# signalgen

Observes external content sources, normalises what it finds into signals, and
posts them to Design Manager's `POST /api/signals`. Outbound-only: everything
downstream of ingestion — matching, review, commissioning, advertising —
happens in DM.

**Phase 0 (this code): the foundation.** Contract package, config, ledger, DM
client with budgets and retries, taxonomy cache, alerts, health. No adapters
yet — nothing produces candidates on its own; `scripts/seed-candidate.ts`
hand-builds one to exercise the path.

Reference documents live in [`docs/`](docs/). `docs/dm-contract.md` is
authoritative for every wire shape.

## Layout

```
apps/service/       NestJS 11 / Node 22
packages/contract/  zod schemas shared by the service, its tests, and (Phase 4) the web form
docs/               architecture spec, build plan, DM contract
```

## Getting started

```bash
pnpm install
cp .env.example .env          # fill in DM_SIGNAL_KEY, MAILWAIN_*, ALERT_*
docker compose up -d db       # local Postgres 16
pnpm --filter @signalgen/service migrate:dev
pnpm test
pnpm build
```

Then the dry-run rehearsal, which is Phase 0's end-to-end proof:

```bash
pnpm seed:candidate
```

It builds one valid `CandidateSignal`, pushes it through the real application
context, and asserts a `dry_run` row landed in the ledger. It refuses to run
with `DRY_RUN=false`.

Health:

```bash
curl -s localhost:3000/healthz | jq
```

`/healthz` returns `200` when healthy or degraded and `503` only when the
database is unreachable — a DM outage leaves the service degraded but alive,
and restarting it would not help.

## How a signal travels

```
CandidateSignal
  -> assign signalId  ({shortcode}_{ULID})
  -> WRITE LEDGER ROW status=pending          <- before any network call
  -> validate against dmSignalPayloadSchema   -> rejected_schema
  -> tone gate against DM's taxonomy          -> rejected_tone
  -> DRY_RUN?                                 -> dry_run
  -> token bucket (10/min) + trailing-24h budgets
       over budget -> stays pending, sweep retries every 5 min
  -> POST /api/signals
       202              -> posted
       200 DUPLICATE    -> posted (logged as an anomaly)
       400/401/other 4xx-> failed_permanent + alert
       429              -> alert always, honour Retry-After, retry
       5xx / network    -> retry 1m/5m/30m/2h/6h, then failed + alert
```

The ledger row exists before the first attempt so that a crash mid-dispatch
leaves something recoverable rather than a signal that may or may not have
arrived. `signalId` doubles as the `Idempotency-Key`, so a retry is a replay.

## Runbook

**Rotate the DM signal key.** Issue a new key in DM (`Api:SignalKey`), then
`fly secrets set DM_SIGNAL_KEY=...`. Fly restarts the machine; the taxonomy
cache warms again on boot. Nothing in the ledger needs touching.

**Force a taxonomy refresh.** Restart the machine (`fly apps restart
signalgen`). The cache is in-memory with a 6h TTL and refreshes at boot. Check
`/healthz` → `taxonomy.fetchedAt` to confirm.

**Toggle dry-run.** `fly secrets set DRY_RUN=true` (or `false`). Confirm via
`/healthz` → `dryRun` before trusting it. The default is `true`, and a missing
value stays `true`.

**Supervised first real post.** Set `BUDGET_TOTAL_24H=1`, then `DRY_RUN=false`.
Submit one signal. Watch for `status=posted` and `dmStatusCode=202` in the
ledger, then confirm it renders in DM's Signal Review Queue (matching usually
completes in under 60s). Restore both settings afterwards.

**Replay a failed signal.** A row parked as `failed` has spent its retry
schedule. To try again, set it back to `pending` and clear the booking:

```sql
UPDATE "Signal" SET status = 'pending', attempts = 0, "nextAttemptAt" = NULL
WHERE id = '<signalId>';
```

The sweep picks it up within five minutes. Retrying is safe — DM deduplicates
on `signalId`, so the worst case is a `200 DUPLICATE`. A `failed_permanent` row
should **not** be replayed until the payload problem behind it is fixed.

**Check budget headroom.** `/healthz` → `budget` reports trailing-24h usage
against each cap. Counts come from the ledger itself, so they cannot drift from
what was actually posted.

**Disable one adapter.** Set its budget to zero (`BUDGET_REDDIT_24H=0`). Its
candidates still reach the ledger and stay `pending` rather than vanishing.
(Adapters arrive in Phase 1 and later.)

## Testing

```bash
pnpm test        # both packages
```

The suite is offline: nothing contacts DM, MailWain or a database. Clock- and
delay-dependent behaviour is driven through the injected `Clock` and `Sleep`
in `apps/service/src/common`, so no test sleeps.

## Constraints worth knowing before changing anything

Native `fetch` only. No queue library. Prisma points at local Postgres and
never at Supabase. `DRY_RUN` defaults to true. See [`CLAUDE.md`](CLAUDE.md) for
the full list and the reasoning.
