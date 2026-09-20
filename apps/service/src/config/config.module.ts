import { Global, Module } from '@nestjs/common';
import { loadEnv } from './config.schema';
import { ConfigService } from './config.service';

/**
 * Global so every module can inject ConfigService without re-importing.
 * `loadEnv` runs during provider construction, so invalid config fails the
 * bootstrap rather than the first request.
 */
@Global()
@Module({
  providers: [
    {
      provide: ConfigService,
      useFactory: () => new ConfigService(loadEnv()),
    },
  ],
  exports: [ConfigService],
})
export class ConfigModule {}
