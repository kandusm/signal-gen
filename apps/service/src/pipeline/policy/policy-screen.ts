import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CandidateSignal } from '@signalgen/contract';
import { z } from 'zod';

/**
 * One denylist rule (architecture-spec.md §5).
 *
 * `word` (the default) matches only at word boundaries, so "ford" does not
 * catch "afford"; `substring` matches anywhere. Scope `topic` covers topic and
 * subtopic.
 */
export const policyRuleSchema = z.object({
  pattern: z.string().trim().min(1),
  match: z.enum(['word', 'substring']).default('word'),
  scope: z.enum(['topic', 'keywords', 'excerpt', 'all']).default('all'),
  reason: z.string().trim().min(1),
});
export type PolicyRule = z.infer<typeof policyRuleSchema>;

export const denylistFileSchema = z.object({ rules: z.array(policyRuleSchema) });

/** apps/service/config/denylist.json — same depth from src/ and dist/. */
export const DENYLIST_PATH = resolve(__dirname, '../../../config/denylist.json');

interface CompiledRule {
  rule: PolicyRule;
  regex: RegExp;
}

/**
 * Screens candidates against the denylist, between schema validation and the
 * tone gate. A hit is ledgered as `rejected_policy` with the rule that
 * matched; it is never sent, never fingerprinted and never alerted — the
 * ledger is the audit.
 *
 * Why it exists: DM validates almost nothing and its human reviewer is the
 * only downstream guard, so this protects the daily budget, reviewer attention
 * and DM storage from topics that must never go out.
 */
export class PolicyScreen {
  private readonly compiled: CompiledRule[];

  constructor(rules: readonly PolicyRule[]) {
    this.compiled = rules.map((rule) => ({ rule, regex: compile(rule) }));
  }

  /** Loads and validates the denylist file. A malformed file fails the boot. */
  static fromFile(path: string = DENYLIST_PATH): PolicyScreen {
    const parsed = denylistFileSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    if (!parsed.success) {
      throw new Error(`Policy denylist ${path} is invalid: ${parsed.error.message}`);
    }
    return new PolicyScreen(parsed.data.rules);
  }

  get ruleCount(): number {
    return this.compiled.length;
  }

  /** The first rule the candidate matches, or null to let it through. */
  screen(candidate: CandidateSignal): PolicyRule | null {
    for (const { rule, regex } of this.compiled) {
      if (fieldsFor(candidate, rule.scope).some((text) => regex.test(text))) return rule;
    }
    return null;
  }
}

function compile(rule: PolicyRule): RegExp {
  const escaped = rule.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Unicode-aware boundaries: \b only knows ASCII word characters.
  const source = rule.match === 'word' ? `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])` : escaped;
  return new RegExp(source, 'iu');
}

function fieldsFor(candidate: CandidateSignal, scope: PolicyRule['scope']): string[] {
  const topic = [candidate.topic, candidate.subtopic ?? ''];
  const keywords = candidate.keywords ?? [];
  const excerpt = [candidate.sourceExcerpt ?? ''];
  switch (scope) {
    case 'topic':
      return topic;
    case 'keywords':
      return keywords;
    case 'excerpt':
      return excerpt;
    case 'all':
      return [...topic, ...keywords, ...excerpt];
  }
}
