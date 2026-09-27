import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { AdapterRegistry } from './adapter.registry';

/**
 * The adapter framework. Global so the pipeline can inject the registry;
 * each concrete adapter lives in its own module under src/adapters/<key>/.
 */
@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [AdapterRegistry],
  exports: [AdapterRegistry],
})
export class AdaptersModule {}
