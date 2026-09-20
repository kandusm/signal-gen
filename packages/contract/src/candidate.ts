import { z } from 'zod';
import { dmSignalPayloadSchema } from './payload';

/**
 * Adapter identity. Open union: the two Phase 1/3 adapters are named so they
 * autocomplete, but the pipeline never switches on this exhaustively and a
 * new adapter must not require a contract change.
 */
export type AdapterKey = 'manual' | 'reddit' | (string & {});

/**
 * What an adapter emits. Everything the wire payload carries, minus the two
 * fields the pipeline owns:
 *
 *   signalId  — assigned by DmClient as `{shortcode}_{ULID}` immediately
 *               before the ledger write, so retries reuse it.
 *   sourceKey — identifies the deployed *generator*, not the adapter. It comes
 *               from GENERATOR_SOURCE_KEY (default "signalgen-v1"); per
 *               dm-contract.md it is "one value per deployed generator".
 *
 * Derived from `dmSignalPayloadSchema` rather than restated, so a change to
 * the wire contract shows up here as a type error — build-plan.md §2.
 */
export const candidateSignalSchema = dmSignalPayloadSchema
  .omit({ signalId: true, sourceKey: true })
  .extend({
    adapterKey: z.string().min(1),
    /**
     * Whether `topic`/`subtopic` mapped onto DM's taxonomy.
     *
     * This is an internal field. It is NOT a wire field — the payload schema is
     * strict and has no such key. The pipeline copies it into
     * `extensions.taxonomyAligned` when building the payload, per
     * architecture-spec.md §5.
     */
    taxonomyAligned: z.boolean(),
  });

export type CandidateSignal = Omit<z.infer<typeof candidateSignalSchema>, 'adapterKey'> & {
  adapterKey: AdapterKey;
};
