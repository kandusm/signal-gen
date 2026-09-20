import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  /**
   * Connects eagerly, but does not make a failed connection fatal.
   *
   * Prisma connects lazily on first query anyway, so throwing here would only
   * change *where* the failure appears — and it would take the whole process
   * with it, leaving nothing to answer /healthz. A machine that boots and
   * reports 503 with a reason is diagnosable; one that crash-loops before it
   * can listen is not. Invalid *config* is still fatal (see ConfigModule):
   * that cannot fix itself, whereas a database can come back.
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
      this.logger.log('Database connected');
    } catch (error) {
      this.logger.error(
        `Database unreachable at boot (continuing so /healthz can report it): ${describeError(error)}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Cheap liveness probe for /healthz. Returns false rather than throwing —
   * an unreachable database is a health *report*, not a health *endpoint
   * failure*; /healthz must still answer so the platform can read the reason.
   */
  async isReachable(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch (error) {
      this.logger.warn(`Database unreachable: ${describeError(error)}`);
      return false;
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
