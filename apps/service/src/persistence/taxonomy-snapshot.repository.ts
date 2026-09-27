import { Injectable } from '@nestjs/common';
import type { Prisma, TaxonomySnapshot } from '@prisma/client';
import { PrismaService } from './prisma.service';

@Injectable()
export class TaxonomySnapshotRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(body: Prisma.InputJsonValue, fetchedAt: Date): Promise<TaxonomySnapshot> {
    return this.prisma.taxonomySnapshot.create({ data: { body, fetchedAt } });
  }

  /** Most recent snapshot, or null if DM has never been reached successfully. */
  findLatest(): Promise<TaxonomySnapshot | null> {
    return this.prisma.taxonomySnapshot.findFirst({ orderBy: { fetchedAt: 'desc' } });
  }
}
