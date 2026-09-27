import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '../config';

export const SIGNALS_PATH = '/api/signals';
export const TAXONOMY_PATH = '/api/secondarydesigns/categories';

const REQUEST_TIMEOUT_MS = 15_000;

/** So a stray HTML error page cannot bloat the ledger row. */
export const RAW_BODY_MAX_LENGTH = 2000;

/** A response actually came back, whatever its status. */
export interface DmHttpResponse {
  kind: 'response';
  status: number;
  retryAfter: string | null;
  /** Parsed JSON body, or null when the body was absent or not JSON. */
  body: unknown;
  /** Raw body text, truncated, for the ledger's dmResponse column. */
  rawBody: string;
}

/** No response at all: DNS, TCP, TLS, or timeout. */
export interface DmTransportError {
  kind: 'transport_error';
  message: string;
}

export type DmHttpResult = DmHttpResponse | DmTransportError;

/**
 * Transport for Design Manager. Native fetch only — architecture-spec.md §3
 * rules out axios and friends, and nothing here needs them.
 *
 * This layer makes no ledger decisions. It reports what happened; DmClient
 * decides what that means.
 */
@Injectable()
export class DmHttpClient {
  private readonly logger = new Logger(DmHttpClient.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * POST /api/signals.
   *
   * `Idempotency-Key` carries the same value as the body's signalId, per
   * dm-contract.md — it is what makes a retry a replay rather than a second
   * signal.
   */
  async postSignal(payload: unknown, signalId: string): Promise<DmHttpResult> {
    return this.request(SIGNALS_PATH, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.get('DM_SIGNAL_KEY')}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': signalId,
      },
      body: JSON.stringify(payload),
    });
  }

  /** GET /api/secondarydesigns/categories. */
  async getTaxonomy(): Promise<DmHttpResult> {
    return this.request(TAXONOMY_PATH, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.config.get('DM_SIGNAL_KEY')}` },
    });
  }

  private async request(path: string, init: RequestInit): Promise<DmHttpResult> {
    const url = `${this.config.get('DM_BASE_URL')}${path}`;

    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`DM transport error on ${init.method} ${path}: ${message}`);
      return { kind: 'transport_error', message };
    }

    // Parse the whole body, truncate only the copy kept for the ledger. The
    // taxonomy response alone is ~2.7 KB; parsing a truncated copy turned every
    // valid taxonomy into null.
    const text = await safeText(response);
    return {
      kind: 'response',
      status: response.status,
      retryAfter: response.headers.get('retry-after'),
      body: parseJson(text),
      rawBody: text.slice(0, RAW_BODY_MAX_LENGTH),
    };
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
