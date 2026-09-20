import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ConfigModule } from './config';
import { DmModule } from './dm';
import { HealthModule } from './health';
import { NotifyModule } from './notify';
import { PersistenceModule } from './persistence';

@Module({
  imports: [
    // In-process cron (architecture-spec.md section 3): single instance, low
    // throughput, no external scheduler warranted.
    ScheduleModule.forRoot(),
    ConfigModule,
    PersistenceModule,
    NotifyModule,
    DmModule,
    HealthModule,
  ],
})
export class AppModule {}
