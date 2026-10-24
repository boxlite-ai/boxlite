import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError } from 'commander';
import { buildProgram } from '../src/cli.js';

/**
 * Every `boxlite-app …` command an agent can be told to run — `next` and `fix` text, CLI `next:`
 * lines, examples, the agent guide — must name a command and flags the CLI really has. The hints are
 * collected from the sources (control plane, shared, CLI, agent/), so a new hint is covered the
 * moment it is written.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE_DIRS = ['control-plane/src', 'shared/src', 'cli/src'];
const DOC_FILES = ['agent/SKILL.md', 'agent/prompt-template.md'];

interface Hint {
  where: string;
  text: string;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== 'generated' && name !== 'node_modules') out.push(...walk(p));
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

function lineAt(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

/** Index just past the `}` that closes the `${` starting at `start`. */
function skipExpression(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return i + 1;
  }
  return text.length;
}

/** Stands for a `${…}` expression; a hint whose command name is computed is not checked. */
const EXPR = '\u0000';

/**
 * Reads a hint from `start` (the `b` of `boxlite-app`) up to its closing quote. `${…}` expressions
 * become `X` when they start a token and disappear when glued to one (`--logs${suffix}`).
 */
function readHint(text: string, start: number, quote: string): string {
  let out = '';
  for (let i = start; i < text.length; ) {
    const ch = text[i]!;
    if (ch === '$' && text[i + 1] === '{' && quote === '`') {
      const glued = out.length > 0 && !/[\s=:]$/.test(out);
      out += glued ? '' : EXPR;
      i = skipExpression(text, i + 1);
      continue;
    }
    if (ch === '\\') {
      // \` closes a code span written inside a template literal; any other escape is the character itself.
      if (text[i + 1] === '`') return out;
      out += text[i + 1] ?? '';
      i += 2;
      continue;
    }
    if (ch === quote || ch === '`' || ch === '\n') return out;
    out += ch;
    i++;
  }
  return out;
}

function sourceHints(): Hint[] {
  const hints: Hint[] = [];
  for (const dir of SOURCE_DIRS) {
    for (const file of walk(join(root, dir))) {
      const text = readFileSync(file, 'utf8');
      const rel = relative(root, file);
      // `boxlite-app …` code spans (also \`…\` inside template literals), 'boxlite-app …' strings, and `&& boxlite-app …`.
      const re = /(\\?`|'|&& )boxlite-app /g;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        const start = m.index + m[1]!.length;
        const quote = m[1] === "'" ? "'" : '`';
        const before = text.slice(Math.max(0, m.index - 3), m.index);
        if (m[1] === "'" && /[\w/]$/.test(before)) continue; // an apostrophe in prose
        hints.push({ where: `${rel}:${lineAt(text, start)}`, text: readHint(text, start, quote) });
      }
    }
  }
  return hints;
}

function docHints(): Hint[] {
  const hints: Hint[] = [];
  for (const rel of DOC_FILES) {
    let text: string;
    try {
      text = readFileSync(join(root, rel), 'utf8');
    } catch {
      continue;
    }
    let fenced = false;
    text.split('\n').forEach((line, i) => {
      const where = `${rel}:${i + 1}`;
      if (line.trimStart().startsWith('```')) {
        fenced = !fenced;
        return;
      }
      if (fenced) {
        const m = /(?:^|&&\s*|\|\s*)(boxlite-app .*)$/.exec(line.trim());
        if (m) hints.push({ where, text: m[1]!.replace(/\s+#.*$/, '') });
        return;
      }
      for (const span of line.matchAll(/`(boxlite-app [^`]*)`/g)) hints.push({ where, text: span[1]! });
    });
  }
  return hints;
}

/** Shell-ish split: quotes group, `<placeholder words>` are one token, `|`, `&&`, `;`, `>` end the command. */
function tokens(command: string): string[] {
  const text = command.replace(/<[^>]*>/g, 'X').replace(/…/g, 'X');
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let has = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
      continue;
    }
    if (ch === '|' || ch === ';' || ch === '>' || (ch === '&' && text[i + 1] === '&')) break;
    cur += ch;
    has = true;
  }
  if (has || cur) out.push(cur);
  return out;
}

const sink = (): Writable => new Writable({ write: (_c, _e, cb) => cb() });

function program(): Command {
  const io = { stdout: sink(), stderr: sink(), stdin: new PassThrough(), isTTY: false };
  const p = buildProgram({ cwd: root, env: {}, io });
  const stub = (c: Command): void => {
    if ((c as unknown as { _actionHandler: unknown })._actionHandler) c.action(() => undefined);
    c.commands.forEach(stub);
  };
  stub(p);
  return p;
}

/** null when `command` parses against the real CLI, else commander's complaint. */
async function parseError(command: string): Promise<string | null> {
  const argv = tokens(command);
  if (argv[0] !== 'boxlite-app') return `does not start with boxlite-app: ${command}`;
  const name = argv[1] === 'app' ? argv[2] : argv[1];
  if (name?.includes(EXPR)) return null; // `boxlite-app ${command} --help`: the command is computed
  for (let i = 0; i < argv.length; i++) argv[i] = argv[i]!.replaceAll(EXPR, 'X');
  try {
    await program().parseAsync(argv.slice(1), { from: 'user' });
    return null;
  } catch (e) {
    if (e instanceof CommanderError) {
      if (e.code === 'commander.helpDisplayed' || e.code === 'commander.version') return null;
      return e.code === 'commander.help' ? 'names a command group, not a command' : e.message;
    }
    return (e as Error).message;
  }
}

test('the checker itself rejects unknown commands, unknown flags and missing arguments', async () => {
  assert.equal(await parseError('boxlite-app app deployment 7 --follow'), null);
  assert.equal(await parseError('boxlite-app app sql --write --env try --file migrations/0002_x.sql'), null);
  assert.equal(await parseError('boxlite-app app logs --source web --level error --since 10m'), null);
  assert.match((await parseError('boxlite-app app deployments 7 --follow')) ?? '', /unknown option|too many arguments/);
  assert.match((await parseError('boxlite-app logs --source system')) ?? '', /unknown command/);
  assert.match((await parseError('boxlite-app env list')) ?? '', /unknown command/);
  assert.match((await parseError('boxlite-app app env list')) ?? '', /unknown command/);
  assert.match((await parseError('boxlite-app app rollback')) ?? '', /missing required argument/);
  assert.match((await parseError('boxlite-app app db')) ?? '', /command group/);
  assert.match(agentProblem('boxlite-app apply') ?? '', /exits 10/);
  assert.equal(agentProblem('boxlite-app apply --yes'), null);
});

test('every boxlite-app command in hints, examples and the agent guide parses against the CLI', async () => {
  const hints = [...sourceHints(), ...docHints()];
  assert.ok(hints.length > 150, `found only ${hints.length} hints: the collector is broken`);
  const broken: string[] = [];
  for (const h of hints) {
    const problem = (await parseError(h.text)) ?? agentProblem(h.text);
    if (problem) broken.push(`${h.where}  \`${h.text.replaceAll(EXPR, '${…}')}\`  → ${problem}`);
  }
  assert.deepEqual(broken, [], `hints naming commands or flags the CLI does not have:\n${broken.join('\n')}`);
});

/** Hints that parse but still fail for an agent, which runs without a terminal. */
function agentProblem(command: string): string | null {
  const argv = tokens(command);
  // `apply` asks before it changes anything; without a terminal it exits 10 unless --yes is given.
  if (argv[1] === 'apply' && !argv.includes('--yes') && !argv.includes('-y') && !argv.includes('--help')) return 'apply without --yes exits 10 for an agent';
  return null;
}

test('no hint names BOXLITE_APP_KEY (the variable is BOXLITE_API_KEY)', () => {
  const offenders: string[] = [];
  for (const dir of SOURCE_DIRS) {
    for (const file of walk(join(root, dir))) {
      const text = readFileSync(file, 'utf8');
      if (text.includes('BOXLITE_APP_KEY')) offenders.push(relative(root, file));
    }
  }
  assert.deepEqual(offenders, []);
});
