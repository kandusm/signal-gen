import { z } from 'zod';
import { dmSignalPayloadSchema, signalDecayHintSchema } from './payload';

/**
 * Body of `POST /manual/signals` (Phase 1 brief §4, architecture-spec.md §9.1).
 *
 * Defined here, not in the service, because the Phase 3 web form submits the
 * same shape: a field the form allows and the endpoint rejects becomes a type
 * error instead of a production 400.
 *
 * Field limits are taken from the wire schema so the two cannot drift; only
 * requiredness and defaults are the operator's own. Strict: an unknown key is
 * a typo in the form or the curl, and silently dropping it would hide that.
 */
const wire = dmSignalPayloadSchema.shape;
const trimmed = (max: number) => z.string().trim().min(1).max(max);

export const manualSubmissionSchema = z.strictObject({
  topic: trimmed(128),
  tone: z.string().trim().min(1),
  subtopic: trimmed(128).optional(),
  platform: z.string().trim().min(1).default('Manual'),
  keywords: z.array(z.string().trim().min(1)).max(20).optional(),
  audience: trimmed(128).optional(),
  sourceUrl: wire.sourceUrl,
  sourceExcerpt: z.string().trim().min(1).max(500).optional(),
  signalDecayHint: signalDecayHintSchema.default('SHORT'),
});

/** What the operator sends (defaults optional). */
export type ManualSubmissionInput = z.input<typeof manualSubmissionSchema>;
/** What the service works with (defaults applied). */
export type ManualSubmission = z.output<typeof manualSubmissionSchema>;
