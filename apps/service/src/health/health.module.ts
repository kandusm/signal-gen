import { Module } from '@nestjs/common';
import { DmModule } from '../dm';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  imports: [DmModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
