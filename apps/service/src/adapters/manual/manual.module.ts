import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import type { Request } from 'express';
import { PipelineModule } from '../../pipeline';
import { DmModule } from '../../dm';
import { ManualTokenGuard } from './manual-token.guard';
import { ManualAdapter } from './manual.adapter';
import { ManualController } from './manual.controller';

/** Nest throttler: 10 requests/minute per client IP (Phase 1 brief §4). */
export const MANUAL_THROTTLE = { ttl: 60_000, limit: 10 } as const;

/**
 * The client's IP. Behind Fly's proxy `req.ip` is the proxy, so every caller
 * would share one bucket; Fly sets Fly-Client-IP on every request it proxies
 * and overwrites any client-supplied value. Locally there is no proxy and
 * req.ip is the caller.
 */
export function clientIp(req: Request): string {
  const fly = req.headers['fly-client-ip'];
  return (typeof fly === 'string' && fly) || req.ip || 'unknown';
}

@Module({
  imports: [
    PipelineModule,
    DmModule,
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'manual', ...MANUAL_THROTTLE }],
      getTracker: (req) => clientIp(req as Request),
    }),
  ],
  controllers: [ManualController],
  providers: [ManualAdapter, ManualTokenGuard],
  exports: [ManualAdapter],
})
export class ManualModule {}
