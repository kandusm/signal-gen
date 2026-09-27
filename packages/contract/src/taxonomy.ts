import { z } from 'zod';

/**
 * Response shape of `GET /api/secondarydesigns/categories`
 * (docs/dm-contract.md → Taxonomy sync), as DM actually serves it.
 *
 * Not strict: DM owns this endpoint and may add fields to it. An unknown key
 * here is DM growing, not us drifting — the failure mode is the opposite of
 * the one on the outbound payload, so the tolerance is too.
 */
export const taxonomySubcategorySchema = z.object({
  // DM sends ids; nothing here matches on them, so they are not required.
  id: z.string().optional(),
  name: z.string(),
});
export type TaxonomySubcategory = z.infer<typeof taxonomySubcategorySchema>;

export const taxonomyCategorySchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  subcategories: z.array(taxonomySubcategorySchema),
});
export type TaxonomyCategory = z.infer<typeof taxonomyCategorySchema>;

export const taxonomyResponseSchema = z.object({
  categories: z.array(taxonomyCategorySchema),
  // Optional until DM publishes tones from config. Absent means "DM has not
  // told us", not "no tone is valid" — the tone gate skips rather than
  // rejects (TaxonomyService.isValidTone).
  tones: z.array(z.string()).optional(),
});
export type TaxonomyResponse = z.infer<typeof taxonomyResponseSchema>;
