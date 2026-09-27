import { z } from 'zod';

/**
 * Wire contract for `POST /api/signals`.
 *
 * Authoritative source: docs/dm-contract.md. If this file and that document
 * ever disagree, the document wins — fix this file, do not "fix" the doc.
 *
 * Strict by construction: DM's contract enumerates every accepted key, so an
 * unknown key here means our understanding has drifted. We want that to fail
 * loudly in a test, not silently in production as a 400.
 */

/** Advisory prioritisation hint (dm-contract.md → Recommended → signalDecayHint). */
export const signalDecayHintSchema = z.enum(['IMMEDIATE', 'SHORT', 'EVERGREEN']);
export type SignalDecayHint = z.infer<typeof signalDecayHintSchema>;

/**
 * dm-contract.md documents exactly these four keys, all optional, nulls fine.
 * Strict on purpose — see the note on `architecture-spec.md §9.3`, which
 * describes a Reddit adapter emitting `{ score, comments, upvoteRatio }`.
 * Those are not contract keys; when Phase 3 lands, `score`/`upvoteRatio` have
 * to be mapped (likes) or moved into `extensions`, and this strictness is what
 * will force that decision instead of quietly dropping the values.
 */
export const engagementMetricsSchema = z
  .strictObject({
    views: z.number().int().nullable().optional(),
    likes: z.number().int().nullable().optional(),
    comments: z.number().int().nullable().optional(),
    shares: z.number().int().nullable().optional(),
  });
export type EngagementMetrics = z.infer<typeof engagementMetricsSchema>;

/** dm-contract.md: "Keep under 8KB serialized". */
export const EXTENSIONS_MAX_SERIALIZED_BYTES = 8192;

/**
 * Serialized size of `extensions` in UTF-8 bytes.
 *
 * `JSON.stringify(x).length` counts UTF-16 code units, which under-reports the
 * real payload size for any non-ASCII content — exactly the content most likely
 * to appear in a scraped excerpt. TextEncoder is available in both Node and the
 * browser, which keeps this package dependency-free and usable by the Phase 4
 * web form.
 */
export function serializedByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) ?? '').length;
}

export const extensionsSchema = z
  .record(z.string(), z.unknown())
  .refine((value) => serializedByteLength(value) <= EXTENSIONS_MAX_SERIALIZED_BYTES, {
    message: `extensions must serialize to at most ${EXTENSIONS_MAX_SERIALIZED_BYTES} bytes`,
  });

export const dmSignalPayloadSchema = z.strictObject({
  // --- Required ---------------------------------------------------------
  signalId: z.string().min(1).max(64),
  capturedAt: z.iso.datetime({ offset: true }),
  sourceKey: z.string().min(1).max(32),
  topic: z.string().min(1).max(128),
  // Taxonomy membership is a runtime check against DM's live taxonomy
  // (TaxonomyService.isValidTone), deliberately not encoded in the schema.
  tone: z.string().min(1),
  platform: z.string().min(1),

  // --- Recommended (all optional on the wire) ---------------------------
  subtopic: z.string().max(128).optional(),
  subplatform: z.string().max(128).optional(),
  keywords: z.array(z.string()).max(20).optional(),
  audience: z.string().max(128).optional(),
  sourceUrl: z.url().optional(),
  sourceAuthor: z.string().max(128).optional(),
  sourceExcerpt: z.string().max(500).optional(),
  engagementMetrics: engagementMetricsSchema.optional(),
  observedAt: z.iso.datetime({ offset: true }).optional(),
  signalDecayHint: signalDecayHintSchema.optional(),

  // --- Optional ---------------------------------------------------------
  extensions: extensionsSchema.optional(),
});

export type DmSignalPayload = z.infer<typeof dmSignalPayloadSchema>;
