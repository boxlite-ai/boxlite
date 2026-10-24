import { MicrocloudError } from '@microcloud/shared';
import type { Command } from 'commander';
import type { MakeCtx } from '../cli.js';

export function registerBuild(program: Command, make: MakeCtx): void {
  program
    .command('build', { hidden: true })
    .description('not available in the prototype; builds happen as part of deploy')
    .action(async (_opts: unknown, cmd: Command) => {
      await make(cmd);
      throw new MicrocloudError('not_available', 'build is not available in the prototype; use deploy', 'run `boxlite-app deploy` (it uploads, builds and starts in one step)');
    });
}
