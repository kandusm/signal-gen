import { Module } from '@nestjs/common';
import { BudgetService } from './budget.service';
import { DmClient } from './dm.client';
import { DmHttpClient } from './dm.http';
import { RateLimitService } from './rate-limit.service';
import { SweepService } from './sweep.service';
import { TaxonomyService } from './taxonomy.service';

@Module({
  providers: [
    DmHttpClient,
    TaxonomyService,
    BudgetService,
    RateLimitService,
    DmClient,
    SweepService,
  ],
  exports: [DmClient, TaxonomyService, BudgetService, RateLimitService, SweepService],
})
export class DmModule {}
