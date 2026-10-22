import type { Command } from 'commander';
import type { MakeCtx } from '../cli.js';
import type { Ctx } from '../context.js';
import { describe } from '../meta.js';
import { VERSION } from '../version.js';

/** Reports something the platform got wrong (not the app's own bugs), then the agent carries on. */
async function feedback(ctx: Ctx, words: string[], opts: { command?: string }): Promise<void> {
  const out = await ctx.api().feedback({ message: words.join(' '), command: opts.command, env: ctx.envName, cli_version: VERSION });
  ctx.out.data(out);
  ctx.out.line(`Reported as ${out.id}. The BoxLite team reads every report.`);
  ctx.out.next('continue the user’s task with a workaround; do not wait for an answer');
}

export function registerFeedback(program: Command, make: MakeCtx): void {
  describe(
    program
      .command('feedback')
      .description('report a platform problem (a bug, a missing capability, docs that reality contradicts) to the BoxLite team')
      .argument('<message...>', 'what happened, what you expected, and what you did instead')
      .option('--command <cmd>', 'the command that misbehaved')
      .action(async (words: string[], o: { command?: string }, cmd: Command) => feedback(await make(cmd), words, o)),
    {
      json: '{ id, received_at, next }',
      exits: [2, 6],
      online: true,
      examples: ['boxlite-app feedback --command "boxlite-app deploy" "deploy stayed at box for 10 minutes; app status showed the Box running"'],
    },
  );
}
