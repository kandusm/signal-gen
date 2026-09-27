import { Module } from '@nestjs/common';
import { ManualAdapter } from './manual.adapter';

@Module({ providers: [ManualAdapter], exports: [ManualAdapter] })
export class ManualModule {}
