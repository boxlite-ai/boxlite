import { MicrocloudError } from '@microcloud/shared';
import type { Command } from 'commander';
import type { MakeCtx } from '../cli.js';
import type { Ctx } from '../context.js';
import { REFERENCE_MD, SKILL_MD } from '../generated/docs.js';
import { describe } from '../meta.js';

export interface DocSection {
  topic: string;
  title: string;
  markdown: string;
}

/** Other names agents reach for, mapped to the SKILL.md section that answers them. */
const ALIASES: Record<string, string> = { setup: 'install', orient: 'install', manifest: 'initialise', init: 'initialise', toml: 'initialise', deploy: 'loop', debug: 'loop', test: 'verify', safety: 'rules' };

/** `## 3. Runtime rules your code must follow` → topic `runtime`. */
export function skillSections(md: string = SKILL_MD): DocSection[] {
  const body = md.replace(/^---\n[\s\S]*?\n---\n/, '');
  const parts = body.split(/^(?=## )/m).filter((p) => p.startsWith('## '));
  return parts.map((p) => {
    const title = p.slice(3, p.indexOf('\n')).trim();
    const words = title.replace(/^\d+\.\s*/, '').toLowerCase().split(/\s+/).filter((w) => !['the', 'a', 'an'].includes(w));
    const topic = (words[0] ?? 'section').replace(/[^a-z0-9-]/g, '');
    return { topic, title, markdown: p.trimEnd() };
  });
}

/** `### boxlite-app app logs` sections of the reference whose command starts with `words`. */
export function referenceSections(words: string[], md: string = REFERENCE_MD): string[] {
  const parts = md.split(/^(?=### )/m).filter((p) => p.startsWith('### '));
  const want = `boxlite-app ${words.join(' ')}`.trim();
  return parts.filter((p) => p.slice(4, p.indexOf('\n')).replace(/`/g, '').trim().startsWith(want)).map((p) => p.trimEnd());
}

async function docs(ctx: Ctx, words: string[]): Promise<void> {
  const sections = skillSections();
  const [topic, ...rest] = words.map((w) => w.toLowerCase());
  if (!topic) {
    const list = [...sections.map((s) => ({ topic: s.topic, title: s.title })), { topic: 'reference', title: 'Every command, flag, JSON shape and exit code' }, { topic: 'all', title: 'The whole agent guide' }];
    ctx.out.data({ topics: list });
    ctx.out.line('Topics (boxlite-app docs <topic>):');
    for (const t of list) ctx.out.line(`  ${t.topic.padEnd(12)} ${t.title}`);
    ctx.out.next('`boxlite-app docs install` to start, or `boxlite-app docs reference deploy` for one command');
    return;
  }
  if (topic === 'all') {
    ctx.out.data({ topic: 'all', title: 'BoxLite App agent guide', markdown: SKILL_MD });
    if (!ctx.json) ctx.out.raw(SKILL_MD);
    return;
  }
  if (topic === 'reference') {
    const parts = rest.length ? referenceSections(rest) : [REFERENCE_MD];
    if (!parts.length) throw new MicrocloudError('not_found', `no command "boxlite-app ${rest.join(' ')}" in the reference`, '`boxlite-app docs reference` prints all of it; `boxlite-app --help` lists commands');
    const markdown = parts.join('\n\n');
    ctx.out.data({ topic: 'reference', title: rest.length ? `boxlite-app ${rest.join(' ')}` : 'CLI reference', markdown });
    if (!ctx.json) ctx.out.raw(markdown);
    return;
  }
  const wanted = ALIASES[topic] ?? topic;
  const section = sections.find((s) => s.topic === wanted);
  if (!section) throw new MicrocloudError('not_found', `no docs topic "${topic}"`, `\`boxlite-app docs\` lists the topics: ${sections.map((s) => s.topic).join(', ')}, reference, all`);
  ctx.out.data(section);
  if (!ctx.json) ctx.out.raw(section.markdown);
}

export function registerDocs(program: Command, make: MakeCtx): void {
  describe(
    program
      .command('docs [topic...]')
      .description('the agent guide and the CLI reference, offline: docs | docs <topic> | docs reference [command…] | docs all')
      .action(async (topic: string[], _o: unknown, cmd: Command) => docs(await make(cmd), topic ?? [])),
    {
      json: 'no topic: { topics: { topic, title }[] }; topic: { topic, title, markdown }',
      exits: [4],
      online: false,
      examples: ['boxlite-app docs', 'boxlite-app docs runtime', 'boxlite-app docs reference app logs'],
    },
  );
}
