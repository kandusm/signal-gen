import { Global, Module } from '@nestjs/common';
import { AdapterRunRepository } from './adapter-run.repository';
import { AdvisoryLockService } from './advisory-lock.service';
import { FingerprintRepository } from './fingerprint.repository';
import { PrismaService } from './prisma.service';
import { SignalRepository } from './signal.repository';
import { TaxonomySnapshotRepository } from './taxonomy-snapshot.repository';

const PROVIDERS = [
  PrismaService,
  SignalRepository,
  FingerprintRepository,
  AdapterRunRepository,
  AdvisoryLockService,
  TaxonomySnapshotRepository,
];

@Global()
@Module({ providers: PROVIDERS, exports: PROVIDERS })
export class PersistenceModule {}
