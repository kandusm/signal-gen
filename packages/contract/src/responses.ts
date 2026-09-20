import { z } from 'zod';

/**
 * DM's documented responses to `POST /api/signals` (docs/dm-contract.md →
 * Responses). Parsed rather than trusted: the parsed result decides the ledger
 * transition, and a response that does not parse is itself contract drift.
 *
 * Not strict — DM adding a field to its own response should not break ingest.
 */

/** 202 Accepted — ingested, matching enqueued. */
export const dmAcceptedResponseSchema = z.object({
  signalId: z.string(),
  status: z.literal('ACCEPTED'),
  matchingScheduled: z.boolean(),
});
export type DmAcceptedResponse = z.infer<typeof dmAcceptedResponseSchema>;

/** 200 OK — idempotent replay of a signalId DM already holds. No-op upstream. */
export const dmDuplicateResponseSchema = z.object({
  signalId: z.string(),
  status: z.literal('DUPLICATE'),
  originalCapturedAt: z.iso.datetime({ offset: true }),
});
export type DmDuplicateResponse = z.infer<typeof dmDuplicateResponseSchema>;

/** 400 Bad Request — schema violation or taxonomy value that blocks Tier 1. */
export const dmValidationFailedResponseSchema = z.object({
  error: z.literal('VALIDATION_FAILED'),
  details: z.array(
    z.object({
      field: z.string(),
      message: z.string(),
    }),
  ),
});
export type DmValidationFailedResponse = z.infer<typeof dmValidationFailedResponseSchema>;

/**
 * 429 Too Many Requests.
 * `limit` is a human-readable string in DM's example ("10/min"), not a number.
 * `retryAfter` is seconds, and is mirrored in the Retry-After header.
 */
export const dmRateLimitedResponseSchema = z.object({
  error: z.literal('RATE_LIMITED'),
  limit: z.string(),
  retryAfter: z.number(),
});
export type DmRateLimitedResponse = z.infer<typeof dmRateLimitedResponseSchema>;

export const dmResponseSchemas = {
  accepted: dmAcceptedResponseSchema,
  duplicate: dmDuplicateResponseSchema,
  validationFailed: dmValidationFailedResponseSchema,
  rateLimited: dmRateLimitedResponseSchema,
} as const;
