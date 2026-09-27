import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConfigService } from './config';

async function bootstrap(): Promise<void> {
  const logger = new Logger('bootstrap');
  const app = await NestFactory.create(AppModule, { bufferLogs: false });

  // Shut down cleanly so Prisma disconnects and the cron stops on SIGTERM,
  // which is how the container is stopped.
  app.enableShutdownHooks();

  const config = app.get(ConfigService);
  const port = config.get('PORT');

  // Bound to all interfaces inside the container; exposure is the platform's
  // job (fly.toml http_service, or a LAN-bound compose port).
  await app.listen(port, '0.0.0.0');

  logger.log(`signalgen listening on :${port} (DRY_RUN=${config.dryRun})`);
  if (!config.dryRun) {
    logger.warn('DRY_RUN is false - signals will be posted to Design Manager for real');
  }
}

void bootstrap();
