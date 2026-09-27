import type { Prisma } from '@prisma/client';
import type { DmHttpResponse } from './dm.http';

/**
 * Builders for the ledger's `dmResponse` column.
 *
 * architecture-spec.md §7 types this as `Json`, not text. The difference
 * matters operationally: a contract drift shows up across many rows at once,
 * and JSON lets that be a query
 *
 *   select payload->>'topic', dm_response->'details'
 *   from "Signal" where status = 'failed_permanent';
 *
 * rather than a grep over prose. Every branch below therefore produces an
 * object with a discriminating key, so "what went wrong" is always readable
 * without knowing which branch wrote it.
 */
export type LedgerResponse = Prisma.InputJsonValue;

/** Truncated so a stray HTML error page cannot bloat the row. */
const MAX_RAW_LENGTH = 2000;

/**
 * What DM actually returned.
 *
 * Uses the parsed body when there was one. A response that did not parse as
 * JSON is recorded under `raw` rather than discarded — an HTML error page from
 * a proxy in front of DM is exactly the kind of thing worth being able to read
 * back later.
 */
export function fromDmResponse(response: DmHttpResponse): LedgerResponse {
  if (response.body !== null && typeof response.body === 'object') {
    return response.body as LedgerResponse;
  }
  return { raw: response.rawBody.slice(0, MAX_RAW_LENGTH) };
}

/** No response at all: DNS, TCP, TLS, or timeout. */
export function fromTransportError(message: string): LedgerResponse {
  return { error: 'TRANSPORT_ERROR', message: message.slice(0, MAX_RAW_LENGTH) };
}

/**
 * Our own wire-schema check rejected the payload before sending it.
 * Shaped to mirror DM's own 400 body so the two read alike in the ledger.
 */
export function fromSchemaRejection(
  issues: readonly { path: string; message: string }[],
): LedgerResponse {
  return {
    error: 'VALIDATION_FAILED_LOCAL',
    details: issues.map((issue) => ({ field: issue.path, message: issue.message })),
  };
}

/** The tone gate rejected the candidate before dispatch. */
export function fromToneRejection(tone: string, knownTones: readonly string[]): LedgerResponse {
  return {
    error: 'TONE_REJECTED',
    details: [{ field: 'tone', message: `Value '${tone}' is not a recognized tone` }],
    tone,
    knownTones: [...knownTones],
  };
}

/**
 * The policy screen matched a denylist rule. The rule is recorded whole, so the
 * ledger alone answers "why was this blocked" (architecture-spec.md §5).
 */
export function fromPolicyRejection(rule: {
  pattern: string;
  match: string;
  scope: string;
  reason: string;
}): LedgerResponse {
  return {
    error: 'POLICY_REJECTED',
    rule: { pattern: rule.pattern, match: rule.match, scope: rule.scope, reason: rule.reason },
  };
}

/** Renders a stored response for an alert email, which is plain text. */
export function describeLedgerResponse(value: unknown): string {
  if (value === null || value === undefined) return '(none)';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
