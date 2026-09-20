import { z } from 'zod';

/**
 * Response shape of `GET /api/secondarydesigns/categories`
 * (docs/dm-contract.md → Taxonomy sync).
 *
 * Not strict: DM owns this endpoint and may add fields to it. An unknown key
 * here is DM growing, not us drifting — the failure mode is the opposite of
 * the one on the outbound payload, so the tolerance is too.
 */
export const taxonomyCategorySchema = z.object({
  name: z.string(),
  subcategories: z.array(z.string()),
});
export type TaxonomyCategory = z.infer<typeof taxonomyCategorySchema>;

export const taxonomyResponseSchema = z.object({
  categories: z.array(taxonomyCategorySchema),
  tones: z.array(z.string()),
});
export type TaxonomyResponse = z.infer<typeof taxonomyResponseSchema>;
