/**
 * Runs the Postgres-backed suite (test/db/) against a throwaway local database.
 *
 *   pnpm --filter @signalgen/service test:db
 *
 * Some guarantees cannot be proven with an in-memory fake — above all that two
 * identical candidates racing produce exactly one pending row. Those tests
 * need a real Postgres, so they live in test/db/ and are skipped by the plain
 * offline `pnpm test` unless TEST_DATABASE_URL is set. This script sets it.
 *
 * Steps: refuse anything but a local host (the same guard migrate:dev uses),
 * create the database if missing, apply migrations with `migrate deploy`, run
 * the suite. Needs `docker compose up -d db`.
 */
import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

// 127.0.0.1, not localhost: on Windows "localhost" tries ::1 first, and the
// compose container listens on IPv4 only, so every new connection stalls ~2s —
// exactly Prisma's transaction maxWait, which fails the concurrent tests.
const url = process.env.TEST_DATABASE_URL ?? 'postgresql://signalgen:signalgen@127.0.0.1:5432/signalgen_test';
const env = { ...process.env, DATABASE_URL: url, DIRECT_URL: url, TEST_DATABASE_URL: url };

function run(command, args) {
  const result = spawnSync(command, args, { env, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// 1. Local only. assert-local-db.mjs reads DATABASE_URL and DIRECT_URL.
run('node', ['scripts/assert-local-db.mjs']);

// 2. Create the database on the same server if it does not exist yet.
const target = new URL(url);
const database = target.pathname.slice(1);
if (!/^[a-z0-9_]+$/.test(database)) {
  console.error(`Refusing unexpected test database name "${database}".`);
  process.exit(1);
}
const admin = new URL(url);
admin.pathname = '/postgres';
const client = new PrismaClient({ datasourceUrl: admin.toString() });
try {
  await client.$executeRawUnsafe(`CREATE DATABASE "${database}"`);
  console.log(`Created database ${database}`);
} catch (error) {
  // 42P04 duplicate_database: already there, which is the usual case.
  if (!String(error?.message).includes('already exists')) throw error;
} finally {
  await client.$disconnect();
}

// 3. Schema, then 4. the suite.
run('npx', ['prisma', 'migrate', 'deploy']);
run('npx', ['vitest', 'run', 'test/db']);
