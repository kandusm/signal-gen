/**
 * Runs a Prisma command against the REMOTE database, explicitly.
 *
 * Used by two package scripts:
 *
 *   migrate:deploy:remote   remote-prisma.mjs migrate deploy
 *   migrate:status:remote   remote-prisma.mjs migrate status
 *
 * `migrate deploy` is the schema-only path. The standard path is `fly deploy`,
 * whose release command runs the same thing before the new machine takes
 * traffic; this exists for a schema change that must land without a code
 * release. Using it when a release is also going out lets the two disagree
 * about what is deployed.
 *
 * Two properties this adds over calling Prisma directly:
 *
 *   1. It prints the target — host, port, user, database — before doing
 *      anything, so "which database did that touch?" is never a guess after
 *      the fact. Never the password.
 *   2. It passes DIRECT_URL explicitly as the child's DATABASE_URL. Prisma
 *      already prefers `directUrl` for migrations, but a migration is the
 *      wrong place to rely on precedence: the target is stated, not inferred.
 *
 * Plain .mjs so it depends on nothing that must be built or generated first,
 * matching assert-local-db.mjs.
 *
 * Per CLAUDE.md, a remote migration runs only on an explicit in-session go,
 * after the diff has been reviewed.
 */

import { spawnSync } from 'node:child_process';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', 'db', 'host.docker.internal']);

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('\nUsage: remote-prisma.mjs <prisma subcommand...>\n');
  process.exit(1);
}
const isWrite = args[0] === 'migrate' && args[1] === 'deploy';

/** Non-secret parts of a Postgres URL. */
function describe(url) {
  try {
    const parsed = new URL(url);
    return {
      user: decodeURIComponent(parsed.username) || '(none)',
      host: parsed.hostname,
      port: parsed.port || '5432',
      database: parsed.pathname.replace(/^\//, '') || '(default)',
      query: parsed.search ? parsed.search.slice(1) : '(none)',
    };
  } catch {
    return null;
  }
}

const directUrl = process.env['DIRECT_URL'];

if (!directUrl) {
  console.error(
    [
      '',
      'DIRECT_URL is not set.',
      '',
      'This command talks to the remote database and needs the migration',
      'connection explicitly. Populate it in apps/service/.env.local.',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

const target = describe(directUrl);
if (!target) {
  console.error('\nDIRECT_URL could not be parsed as a database URL.\n');
  process.exit(1);
}

if (LOCAL_HOSTS.has(target.host.toLowerCase())) {
  console.error(
    [
      '',
      `DIRECT_URL points at "${target.host}", which is local.`,
      '',
      'This is the remote path. For local schema work use:',
      '',
      '  pnpm --filter @signalgen/service migrate:dev',
      '',
      'which develops migrations against the compose Postgres and is guarded',
      'by assert-local-db.mjs.',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

console.log(
  [
    '',
    `prisma ${args.join(' ')} — REMOTE`,
    '',
    `  host     : ${target.host}`,
    `  port     : ${target.port}`,
    `  user     : ${target.user}`,
    `  database : ${target.database}`,
    `  options  : ${target.query}`,
    '',
    ...(isWrite
      ? [
          'Applying any migrations this database has not seen. Forward-only:',
          'nothing is reset and no existing migration is re-run.',
          '',
        ]
      : []),
  ].join('\n'),
);

const result = spawnSync('prisma', args, {
  stdio: 'inherit',
  shell: true,
  env: {
    ...process.env,
    // Stated, not inferred — see the note at the top of this file.
    DATABASE_URL: directUrl,
    DIRECT_URL: directUrl,
  },
});

if (result.error) {
  console.error(`\nCould not run prisma: ${result.error.message}\n`);
  process.exit(1);
}

if (result.status !== 0) {
  console.error(
    [
      '',
      `prisma ${args.join(' ')} exited ${result.status}.`,
      ...(isWrite
        ? [
            '',
            'Report this rather than retrying. A partially applied migration is',
            'recorded as failed, and resolving it is a decision (prisma migrate',
            'resolve), not a cleanup step.',
          ]
        : []),
      '',
    ].join('\n'),
  );
  process.exit(result.status ?? 1);
}

if (isWrite) {
  console.log('\nMigrations applied. Verify with migrate:status:remote and /healthz.\n');
}
