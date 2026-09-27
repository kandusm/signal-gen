/**
 * Refuses to let a destructive Prisma command run against a remote database.
 *
 * `prisma migrate dev` creates and drops a shadow database and will offer to
 * reset the target. Pointed at Supabase, that is data loss, and the guardrail
 * against it should not be "remember not to". CLAUDE.md states the rule; this
 * enforces it.
 *
 * Plain .mjs rather than TypeScript on purpose: it runs before anything else,
 * so it must not depend on ts-node, a build step, or a generated Prisma
 * client. Nothing here imports anything.
 *
 * Note that Prisma's own CLI reads `.env` but never `.env.local`, which is
 * where the Supabase credentials are staged. The two mechanisms agree: only
 * `.env` can reach a migration, and only a local host may appear in it.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', 'db', 'host.docker.internal']);

/** Host portion of a Postgres URL, or null if it cannot be parsed. */
function hostOf(url) {
  try {
    // The URL parser handles postgres:// fine; credentials may contain
    // characters it dislikes, so fall back to a regex before giving up.
    return new URL(url).hostname.toLowerCase();
  } catch {
    const match = /^[^:]+:\/\/(?:[^@/]*@)?([^:/?#]+)/.exec(url);
    return match?.[1]?.toLowerCase() ?? null;
  }
}

const problems = [];

for (const name of ['DATABASE_URL', 'DIRECT_URL']) {
  const value = process.env[name];

  if (!value) {
    problems.push(`${name} is not set. Create apps/service/.env from .env.example.`);
    continue;
  }

  const host = hostOf(value);
  if (host === null) {
    problems.push(`${name} could not be parsed as a database URL.`);
  } else if (!LOCAL_HOSTS.has(host)) {
    problems.push(`${name} points at "${host}", which is not a local database.`);
  }
}

if (problems.length > 0) {
  console.error(
    [
      '',
      'Refusing to run a migration command against a non-local database.',
      '',
      ...problems.map((problem) => `  - ${problem}`),
      '',
      'Migrations are developed against the docker-compose Postgres and nowhere',
      'else (build-plan.md section 3):',
      '',
      '  docker compose up -d db',
      '',
      'A remote database receives schema changes only through',
      '`prisma migrate deploy`, run by the Fly release command. If you are',
      'trying to apply migrations to Supabase, that is a deploy, and it is',
      "Kandus's to run.",
      '',
    ].join('\n'),
  );
  process.exit(1);
}
