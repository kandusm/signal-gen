import { z } from 'zod';

/**
 * Environment contract. Validated once at boot; an invalid value stops the
 * process rather than surfacing as a confusing runtime failure later
 * (architecture-spec.md §3: "fail-fast on invalid config").
 */

/**
 * `"true"`/`"false"`/`"1"`/`"0"`, case-insensitive.
 *
 * The default is applied after `.optional()` rather than with `.default()`,
 * because zod 4's `.default()` takes the schema's *output* type — here a
 * boolean — while the value arriving from the environment is a string.
 */
const booleanFromEnv = (defaultValue: boolean) =>
  z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.enum(['true', 'false', '1', '0']))
    .transform((v) => v === 'true' || v === '1')
    .optional()
    .transform((v) => v ?? defaultValue);

const positiveIntFromEnv = (defaultValue: number) =>
  z.coerce.number().int().nonnegative().default(defaultValue);

/** No trailing slash, so `${base}/api/signals` never produces a double slash. */
const baseUrl = z
  .url()
  .transform((value) => value.replace(/\/+$/, ''));

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Local listen port for /healthz (and Phase 1's /manual/signals). */
  PORT: positiveIntFromEnv(3000),

  // --- Database ---------------------------------------------------------
  /** Pooled connection (Supavisor `?pgbouncer=true` in production). */
  DATABASE_URL: z.string().min(1),
  /** Direct connection; migrations only. */
  DIRECT_URL: z.string().min(1),

  // --- Design Manager ---------------------------------------------------
  DM_BASE_URL: baseUrl,
  DM_SIGNAL_KEY: z.string().min(1),
  /**
   * Identity of this deployed generator, sent as `sourceKey`.
   * dm-contract.md caps sourceKey at 32 characters, so an over-long value is
   * a boot failure rather than a 400 from DM on the first real post.
   */
  GENERATOR_SOURCE_KEY: z.string().min(1).max(32).default('signalgen-v1'),

  // --- Manual adapter (surface lands in Phase 1; token is provisioned now)
  MANUAL_API_TOKEN: z.string().min(1),

  // --- Alerting ---------------------------------------------------------
  MAILWAIN_BASE_URL: baseUrl,
  MAILWAIN_API_KEY: z.string().min(1),
  /**
   * Sender address. Not in the Phase 0 brief's variable list, but MailWain's
   * POST /v1/send requires `from` and rejects a domain that is not ACTIVE for
   * the org, so alerting cannot work without it.
   */
  ALERT_FROM: z.email(),
  /**
   * Alert recipients, comma-separated. MailWain's `to` is a single address, so
   * multiple recipients become multiple sends. Comma support is here because
   * architecture-spec.md OQ-6 ("you only, or Chris too") is still open.
   */
  ALERT_TO: z
    .string()
    .min(1)
    .transform((value) =>
      value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.email()).min(1)),

  // --- Safety valves ----------------------------------------------------
  /**
   * Defaults to true. architecture-spec.md §6 makes dry-run the default mode
   * for every new adapter's first deploy; defaulting the other way would mean
   * a missing variable causes real posts.
   */
  DRY_RUN: booleanFromEnv(true),

  // --- Rate budgets (trailing 24h) --------------------------------------
  /** DM allows 500/day per key (dm-contract.md → Rate limits). */
  BUDGET_TOTAL_24H: positiveIntFromEnv(500),
  BUDGET_MANUAL_24H: positiveIntFromEnv(50),
  BUDGET_SEARCH_24H: positiveIntFromEnv(100),

  // --- signalId shortcodes ----------------------------------------------
  /**
   * Adapter shortcode map, as `adapterKey:code` pairs.
   *
   * The brief calls for a config-driven map rather than a hardcoded switch.
   * dm-contract.md recommends a source prefix so a signalId is legible in DM's
   * review queue without a lookup, and architecture-spec.md fixes the
   * convention as `man_` and `srch_`.
   *
   * Defaults cover the adapters the roadmap names; a new adapter can be given
   * a code without a code change, and gets a derived one if nobody does.
   */
  ADAPTER_SHORTCODES: z
    .string()
    .default('manual:man,search:srch')
    .transform((value, ctx) => {
      const map: Record<string, string> = {};
      for (const pair of value.split(',').map((p) => p.trim()).filter(Boolean)) {
        const [key, code] = pair.split(':').map((part) => part?.trim());
        if (!key || !code) {
          ctx.addIssue({ code: 'custom', message: `"${pair}" is not a "adapterKey:code" pair` });
          continue;
        }
        if (!/^[a-z0-9]{1,8}$/.test(code)) {
          ctx.addIssue({
            code: 'custom',
            message: `shortcode "${code}" must be 1-8 lowercase alphanumeric characters`,
          });
          continue;
        }
        map[key] = code;
      }
      return map;
    }),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Parses and validates `process.env`, reporting *every* problem at once.
 * Fixing config one error per restart is miserable; this prints the full list.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (result.success) return result.data;

  const lines = result.error.issues.map((issue) => {
    const key = issue.path.join('.') || '(root)';
    return `  ${key}: ${issue.message}`;
  });
  throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
}
