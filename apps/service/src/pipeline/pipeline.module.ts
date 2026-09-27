import { Logger, Module } from '@nestjs/common';
import { DmModule } from '../dm';
import { AdapterRunRecorder } from './adapter-run.recorder';
import { PipelineService } from './pipeline.service';
import { PolicyScreen } from './policy/policy-screen';

@Module({
  imports: [DmModule],
  providers: [
    PipelineService,
    AdapterRunRecorder,
    {
      provide: PolicyScreen,
      // Read once at boot; a malformed denylist fails the boot rather than
      // failing open at the first candidate.
      useFactory: () => {
        const screen = PolicyScreen.fromFile();
        new Logger('PolicyScreen').log(`Denylist loaded: ${screen.ruleCount} rule(s)`);
        return screen;
      },
    },
  ],
  exports: [PipelineService, AdapterRunRecorder],
})
export class PipelineModule {}
