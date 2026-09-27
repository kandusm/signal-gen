import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AdaptersModule } from './adapters';
import { ManualModule } from './adapters/manual';
import { ConfigModule } from './config';
import { DmModule } from './dm';
import { HealthModule } from './health';
import { NotifyModule } from './notify';
import { PersistenceModule } from './persistence';
import { PipelineModule } from './pipeline';

@Module({
  imports: [
    // In-process cron (architecture-spec.md section 3): single instance, low
    // throughput, no external scheduler warranted.
    ScheduleModule.forRoot(),
    ConfigModule,
    PersistenceModule,
    NotifyModule,
    DmModule,
    AdaptersModule,
    PipelineModule,
    // Adapters: one module each (src/adapters/<key>/).
    ManualModule,
    HealthModule,
  ],
})
export class AppModule {}
