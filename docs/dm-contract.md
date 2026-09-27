# Signal Consumption API — Endpoint Documentation

**Consumer:** Signal generator (any source)
**Provider:** Design Manager (DM)
**Purpose:** Reference for implementing signal ingestion into DM's matching pipeline

## Endpoint

```
POST https://sartorial.commvergent.com/api/signals
```

## Authentication

```
Authorization: Bearer <SIGNAL_API_KEY>
```

Key is issued via DM configuration (`Api:SignalKey`). One key per signal generator instance. Rotate by issuing a new key and updating the generator's config.

## Headers

| Header | Required | Notes |
|---|---|---|
| Authorization | Yes | Bearer token per above |
| Content-Type | Yes | application/json |
| Idempotency-Key | Recommended | Same value as signalId in the body; enables clean retry semantics |

## Request body

```json
{
  "signalId": "sig_a1b2c3d4",
  "capturedAt": "2026-09-20T14:30:00Z",
  "sourceKey": "trend-monitor-v1",

  "topic": "Pipe Welding",
  "subtopic": "Safety",
  "tone": "Professional",
  "platform": "LinkedIn",
  "subplatform": "Construction group",

  "keywords": ["welding", "PPE", "hot work permit"],
  "audience": "trades professionals",

  "sourceUrl": "https://www.linkedin.com/posts/example",
  "sourceAuthor": "some-handle",
  "sourceExcerpt": "Short quote from the observed content (<500 chars)",
  "engagementMetrics": {
    "views": 12500,
    "likes": 340,
    "comments": 45,
    "shares": 12
  },

  "observedAt": "2026-09-20T09:15:00Z",
  "signalDecayHint": "SHORT",

  "extensions": {
    "sourceSpecificField": "..."
  }
}
```

## Field reference

### Required

| Field | Type | Notes |
|---|---|---|
| signalId | string, ≤64 chars | Unique per signal. Idempotency key. Prefix with a source shortcode is recommended (`rdt_...`, `gtr_...`) |
| capturedAt | ISO 8601 datetime | When the signal generator captured this observation |
| sourceKey | string, ≤32 chars | Identifies the signal generator instance/version (e.g., `trend-monitor-v1`). One value per deployed generator |
| topic | string, ≤128 chars | Primary subject. Should map to a Category in DM's taxonomy where possible |
| tone | string | SHOULD match a Tone from GET /api/secondarydesigns/categories exactly (drives Tier 1). Publish-only: DM never validates it or 400s on it — see *Taxonomy sync → Tone* |
| platform | string | Where the signal was observed (LinkedIn, Reddit, TikTok, Twitter/X, Etsy, GoogleTrends, etc.) |

### Recommended

| Field | Type | Notes |
|---|---|---|
| subtopic | string, ≤128 chars | Refinement of topic. Should map to a Subcategory when possible |
| subplatform | string, ≤128 chars | Sub-context within the platform (r/Welding, #construction, etc.) |
| keywords | string[], ≤20 items | Feeds DM's Tier 2 keyword matching against design SEO tags |
| audience | string, ≤128 chars | Inferred audience descriptor |
| sourceUrl | URL string | Direct link to the observed content |
| sourceAuthor | string, ≤128 chars | Creator/author handle |
| sourceExcerpt | string, ≤500 chars | Short quote or summary of the triggering content. Used by DM's Tier 3 Claude AI ranking |
| engagementMetrics | object | `{ views, likes, comments, shares }` — all fields optional, nulls fine |
| observedAt | ISO 8601 datetime | When the underlying content was posted (may differ from capturedAt) |
| signalDecayHint | enum | `IMMEDIATE` \| `SHORT` \| `EVERGREEN` — advisory for future prioritization |

### Optional

| Field | Type | Notes |
|---|---|---|
| extensions | object | Free-form JSONB for source-specific detail. Passed through downstream unchanged. Keep under 8KB serialized |

## Responses

### 202 Accepted

```json
{
  "signalId": "sig_a1b2c3d4",
  "status": "ACCEPTED",
  "matchingScheduled": true
}
```

Returned on successful ingest. Matching runs asynchronously; the signal appears in the DM reviewer queue after the three-tier matching completes (typically <60s).

### 200 OK — idempotent replay

```json
{
  "signalId": "sig_a1b2c3d4",
  "status": "DUPLICATE",
  "originalCapturedAt": "2026-09-20T14:30:00Z"
}
```

Returned when a signalId already exists. The request is a no-op; no state changes.

### 400 Bad Request

```json
{
  "error": "VALIDATION_FAILED",
  "details": [
    { "field": "tone", "message": "Value 'Sarcastic' is not a recognized tone" }
  ]
}
```

Returned on schema violations.

> **Amended 2026-09-27.** The tone example above was aspirational: DM has never
> validated tone, and an unknown taxonomy value does not produce a 400. It stays
> as an illustration of the error body's shape only.

### 401 Unauthorized

Bearer token missing or invalid.

### 429 Too Many Requests

```json
{
  "error": "RATE_LIMITED",
  "limit": "10/min",
  "retryAfter": 42
}
```

Retry-After header included. See rate limits below.

### 5xx

Standard error shape. Signal generator should retry with exponential backoff, up to a reasonable cap. Since signalId is idempotent, retries are safe.

## Rate limits

- 10 requests / minute per API key
- 500 requests / day per API key

Exceeding either returns 429. Signal generator should self-throttle rather than provoking 429s. If a source produces bursts (a news event, a viral moment), buffer and drain within the per-minute budget.

## Taxonomy sync

```
GET https://sartorial.commvergent.com/api/secondarydesigns/categories
Authorization: Bearer <SIGNAL_API_KEY>
```

Returns current valid values:

```json
{
  "categories": [
    {
      "id": "1ca227ed-…",
      "name": "Trades",
      "subcategories": [
        { "id": "557331f9-…", "name": "Welding" },
        { "id": "8f0c1d2e-…", "name": "Plumbing" }
      ]
    }
  ],
  "tones": ["Professional", "Humor", "Inspirational", "Vintage", "Bold"]
}
```

> **Amended 2026-09-27** to the shape DM actually serves: categories and
> subcategories carry ids, and subcategories are `{ id, name }` objects rather
> than strings. Matching is by `name`; ids are informational.

### Tone

Tones come from DM configuration (`Signals:Tones`), as shipped 2026-09-27:

- **Omitted when unconfigured.** If `Signals:Tones` is not set, the `tones` key
  is absent from the response entirely — not `null`, not `[]`. `tones` is
  therefore **optional** in the response schema.
- **Order preserved.** The list is returned in configured order.
- **Duplicates collapse, first spelling wins.** If the configuration lists the
  same tone twice in different spellings, only the first appears.

**Tone is publish-only.** `tone` on `POST /api/signals` SHOULD match an entry
in the list, because that exact match drives Tier 1 matching. DM never
validates it and never returns 400 for it. The generator's tone gate exists
for **match-quality discipline**, not 400-avoidance. It therefore:

- rejects a tone (`rejected_tone`) only when DM has published a tone list and
  the tone is not on it (exact, case-sensitive comparison — Tier 1 is an exact
  match);
- skips, and does not reject, when there is no taxonomy at all or the `tones`
  key is absent. `/healthz` reports the skip as a `degraded` issue so it is
  never silent.

Signal generator should fetch this on startup and refresh periodically (recommended: every 6h). Sending unknown Category/Subcategory/Tone values doesn't reject the signal — Tier 2 keyword matching and Tier 3 AI ranking still work — but Tier 1 taxonomy matching won't fire, reducing match quality.

## Delivery guarantees

- At-least-once delivery expected from the signal generator. Retry on network errors, 5xx, 429.
- Exactly-once processing guaranteed by DM via signalId idempotency.
- No delivery ordering required. Signals are independent; DM handles concurrent ingestion.

## What happens after ingestion (informational)

1. DM stores the signal and enqueues matching (Hangfire background job)
2. Three-tier matching runs: taxonomy → keyword → Claude AI semantic ranking
3. Signal transitions to PendingReview status
4. Human reviewer sees ranked design candidates in the Signal Review Queue
5. Reviewer either commissions a new design (→ Design Pipeline) or advertises existing ones (→ AdPush)

The signal generator has no visibility into steps 2–5. If observability into signal outcomes is needed, DM can expose a separate `GET /api/signals/{signalId}/status` endpoint — not built by default.

## Do not send

- Personally identifiable information beyond public author handles
- Content the signal generator scraped from behind a login or paywall
- Copyrighted content excerpts longer than fair use permits (keep sourceExcerpt under 500 chars)
- Signals from private communities (private subreddits, closed LinkedIn groups)
