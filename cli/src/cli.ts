import { MicrocloudError, type CheckResult } from '@microcloud/shared';
import { Command, CommanderError } from 'commander';
import { registerApp } from './commands/app.js';
import { registerApply } from './commands/apply.js';
import { registerAuth } from './commands/auth.js';
import { registerBuild } from './commands/build.js';
import { registerCheck } from './commands/check.js';
import { registerDeploy } from './commands/deploy.js';
import { registerDocs } from './commands/docs.js';
import { registerDoctor } from './commands/doctor.js';
import { registerInit } from './commands/init.js';
import { registerPlan } from './commands/plan.js';
import { registerWhoami } from './commands/whoami.js';
import { createCtx, type Ctx, type GlobalOpts, type RunOptions } from './context.js';
import { refineError, usageError } from './guidance.js';
import { checkLines, Output } from './output.js';
import { redacting } from './redact-stream.js';
import { VERSION } from './version.js';

export type MakeCtx = (cmd: Command) => Promise<Ctx>;

export { VERSION };

/** Builds the command tree. `out` is shared with every command so the runner can flush its JSON result. */
export function buildProgram(run: RunOptions, argv: readonly string[] = [], out: Output = new Output(run.io, argv.includes('--json'))): Command {
  const program = new Command('boxlite-app')
    .description('BoxLite Micro-cloud: deploy and operate an App from its project directory')
    .version(VERSION)
    .option('--json', 'one JSON document on stdout on success; {"error":{code,message,next,…}} on stderr on failure')
    .option('--env <name>', 'environment (default: .boxlite/link.json env, else main)')
    .exitOverride()
    .configureOutput({
      writeOut: (s) => run.io.stdout.write(s),
      writeErr: (s) => run.io.stderr.write(s),
      // Usage errors are printed by `run` in the same shape as every other error.
      outputError: () => undefined,
    });

  const make: MakeCtx = (cmd) => createCtx(run, cmd.optsWithGlobals() as GlobalOpts, argv, out);
  registerInit(program, make);
  registerCheck(program, make);
  registerPlan(program, make);
  registerApply(program, make);
  registerDeploy(program, make);
  registerBuild(program, make);
  registerWhoami(program, make);
  registerDoctor(program, make);
  registerDocs(program, make);
  registerAuth(registerApp(program, make), make);
  return program;
}

/** The deepest command named by argv, e.g. `app db rows` (options and their values are skipped). */
export function commandPath(program: Command, argv: readonly string[]): string {
  const path: string[] = [];
  let cur = program;
  for (const token of argv) {
    if (token.startsWith('-')) continue;
    const sub = cur.commands.find((c) => c.name() === token || c.aliases().includes(token));
    if (!sub) break;
    path.push(sub.name());
    cur = sub;
  }
  return path.join(' ');
}

/** Runs the CLI with the given argv (without node/script) and returns the exit code. */
export async function run(argv: string[], options: RunOptions): Promise<number> {
  const json = argv.includes('--json');
  const opts: RunOptions = { ...options, io: { ...options.io, stdout: redacting(options.io.stdout), stderr: redacting(options.io.stderr) } };
  const out = new Output(opts.io, json);
  const program = buildProgram(opts, argv, out);
  const command = commandPath(program, argv);
  try {
    await program.parseAsync(argv, { from: 'user' });
    out.flush();
    return 0;
  } catch (e) {
    out.clearProgress();
    if (e instanceof CommanderError) {
      if (e.code === 'commander.helpDisplayed' || e.code === 'commander.version' || e.code === 'commander.help') return 0;
      const appCommands = program.commands.find((c) => c.name() === 'app')?.commands.map((c) => c.name()) ?? [];
      printError(opts, json, usageError(e.message, command, appCommands));
      return e.exitCode || 1;
    }
    const base = e instanceof MicrocloudError ? e : new MicrocloudError('internal', (e as Error)?.message ?? String(e));
    const err = refineError(base, { command, commandLine: ['boxlite-app', ...argv].join(' '), env: envFromArgv(argv), clientSide: !(e instanceof MicrocloudError) });
    printError(opts, json, err);
    if (!(e instanceof MicrocloudError) && opts.env.BOXLITE_DEBUG) opts.io.stderr.write(`${(e as Error).stack ?? ''}\n`);
    return err.exit;
  }
}

function envFromArgv(argv: readonly string[]): string {
  const i = argv.indexOf('--env');
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : 'main';
}

function printError(opts: RunOptions, json: boolean, err: MicrocloudError): void {
  const { stderr } = opts.io;
  if (json) {
    stderr.write(`${JSON.stringify(err.toBody())}\n`);
    return;
  }
  stderr.write(`error: ${err.message}\n`);
  const d = err.details;
  if (Array.isArray(d.errors) && err.code === 'invalid_manifest' && d.printed !== true) {
    const result = { ok: false, errors: d.errors, warnings: [] } as CheckResult;
    for (const line of checkLines(result)) stderr.write(`  ${line}\n`);
  }
  if (err.code === 'deploy_failed') {
    const tail = Array.isArray(d.log_tail) ? (d.log_tail as unknown[]).map(String) : [];
    if (tail.length) {
      stderr.write(`  last ${tail.length} log lines:\n`);
      for (const line of tail) stderr.write(`    ${line}\n`);
    }
    if (typeof d.cause === 'string') stderr.write(`  cause: ${d.cause}${typeof d.step === 'string' ? ` (step ${d.step})` : ''}\n`);
    if (typeof d.file === 'string') stderr.write(`  file: ${d.file}${typeof d.line === 'number' ? `:${d.line}` : ''}\n`);
    stderr.write('  the previous live release, if any, keeps serving\n');
  } else if (Array.isArray(d.destroys)) {
    // confirmation_required: the brief was printed as notes already.
  } else if (typeof d.step === 'string') {
    stderr.write(`  step: ${d.step}\n`);
  }
  if (err.next) stderr.write(`  next: ${err.next}\n`);
  if (typeof d.docs === 'string') stderr.write(`  docs: ${d.docs}\n`);
}
