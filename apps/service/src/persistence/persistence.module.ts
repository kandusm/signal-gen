import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { SignalRepository } from './signal.repository';
import { TaxonomySnapshotRepository } from './taxonomy-snapshot.repository';

@Global()
@Module({
  providers: [PrismaService, SignalRepository, TaxonomySnapshotRepository],
  exports: [PrismaService, SignalRepository, TaxonomySnapshotRepository],
})
export class PersistenceModule {}
