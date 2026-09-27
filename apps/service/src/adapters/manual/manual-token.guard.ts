import { createHash, timingSafeEqual } from 'node:crypto';
import {
  type ArgumentsHost,
  Catch,
  type CanActivate,
  type ExceptionFilter,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ConfigService } from '../../config';

/**
 * Bearer MANUAL_API_TOKEN, compared in constant time.
 *
 * Both sides are hashed to SHA-256 before timingSafeEqual. That is the length
 * guard: timingSafeEqual throws on unequal lengths, and a plain length check
 * first would leak the token's length through timing. Equal-length digests
 * make the comparison's cost independent of what was sent.
 *
 * Nothing here logs the header or the token.
 */
@Injectable()
export class ManualTokenGuard implements CanActivate {
  private readonly expected: Buffer;

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.expected = digest(config.get('MANUAL_API_TOKEN'));
  }

  canActivate(context: ExecutionContext): boolean {
    const header = context.switchToHttp().getRequest<Request>().headers.authorization ?? '';
    const match = /^Bearer (.+)$/.exec(header);
    if (!match?.[1] || !timingSafeEqual(digest(match[1]), this.expected)) {
      throw new UnauthorizedException();
    }
    return true;
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * 401 with an empty body (Phase 1 brief §4): a failed auth tells the caller
 * nothing about why — not which part was wrong, not what the endpoint expects.
 */
@Catch(UnauthorizedException)
export class EmptyUnauthorizedFilter implements ExceptionFilter {
  catch(_exception: UnauthorizedException, host: ArgumentsHost): void {
    host.switchToHttp().getResponse<Response>().status(401).end();
  }
}
