import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { load } from 'js-yaml'

const digest = (data) => 'sha256:' + createHash('sha256').update(data).digest('hex')
test('publishing a runtime includes each sidecar once and resumes without replacing it', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'release-upload-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const bundle = join(dir, 'dist')
  mkdirSync(bundle)
  const files = ['boxlite-runtime-v1.2.3-linux.tar.gz', 'boxlite-cli-v1.2.3-linux.tar.gz', 'install.sh']
  const names = [...files, ...files.map((f) => f + '.sha256'), 'SHA256SUMS']
  const assets = {}
  for (const name of names) {
    writeFileSync(join(bundle, name), name)
    assets[name] = { group: 'runtime-distribution', digest: digest(name) }
  }
  const tag = 'v1.2.3'
  const sha = 'a'.repeat(40)
  const receipt = JSON.stringify({ tag, sha, assets })
  writeFileSync(join(bundle, 'release-candidate.json'), receipt)
  const gh = join(dir, 'gh')
  writeFileSync(join(dir, 'uploads'), '')
  writeFileSync(
    gh,
    `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const args=process.argv.slice(2), ledger=process.env.LEDGER;
if(args.includes('PATCH')) {if(!args.includes('draft=false')||!args.includes('prerelease=false'))process.exit(10); fs.appendFileSync(ledger+'.patch','P'); fs.writeFileSync(ledger+'.public','1'); process.exit(9)}
else if(args[0]==='release' && args[1]==='upload') fs.appendFileSync(ledger,path.basename(args[3])+'\\n');
else if(args.at(-1).endsWith('/assets?per_page=100')) console.log(JSON.stringify([fs.readFileSync(ledger,'utf8').split('\\n').filter(Boolean).map(name=>({name,state:'uploaded',digest:'sha256:'+crypto.createHash('sha256').update(fs.readFileSync(path.join(process.env.RELEASE_ASSET_DIR,name))).digest('hex')}))]));
else if(args.at(-1).includes('/commits/')) console.log(JSON.stringify({sha:process.env.SHA}));
else if(args.at(-1).endsWith('/releases/1')) console.log(JSON.stringify({tag_name:process.env.TAG,draft:!fs.existsSync(ledger+'.public')}));
else process.exit(9);
`,
    { mode: 0o755 },
  )
  const env = {
    ...process.env,
    PATH: dir + ':' + process.env.PATH,
    RELEASE_ASSET_DIR: bundle,
    TAG: tag,
    SHA: sha,
    CANDIDATE_DIGEST: digest(receipt),
    RELEASE_ID: '1',
    GITHUB_REPOSITORY: 'boxlite-ai/boxlite',
    LEDGER: join(dir, 'uploads'),
  }
  const code = new URL('./release-candidate.mjs', import.meta.url)
  for (const scope of ['', '', 'runtime-distribution']) {
    const r = spawnSync(process.execPath, [resolve(code.pathname), 'attach'], {
      cwd: dir,
      env: { ...env, REPAIR_GROUP: scope },
      encoding: 'utf8',
    })
    assert.equal(r.status, 0, r.stderr)
  }
  assert.deepEqual(
    readFileSync(env.LEDGER, 'utf8').trim().split('\n').sort(),
    [...names, 'release-candidate.json'].sort(),
  )
  const workflow = load(readFileSync(new URL('../../../.github/workflows/mbuild-release.yml', import.meta.url), 'utf8'))
  const finalize = workflow.jobs.finalize.steps
    .at(-1)
    .run.replace('apps/infra/scripts/release-candidate.mjs', JSON.stringify(code.pathname))
  const run = () => spawnSync('bash', ['-ec', finalize], { cwd: dir, env, encoding: 'utf8' })
  assert.notEqual(run().status, 0, 'simulate a lost response to the publication request')
  assert.equal(readFileSync(env.LEDGER + '.public', 'utf8'), '1')
  let result = run()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(env.LEDGER + '.patch', 'utf8'), 'P', 'retry must only verify the public release')
  assert.deepEqual(
    readFileSync(env.LEDGER, 'utf8').trim().split('\n').sort(),
    [...names, 'release-candidate.json'].sort(),
  )
  writeFileSync(env.LEDGER, names.join('\n') + '\n')
  result = run()
  assert.notEqual(result.status, 0, 'incomplete public release must fail')
  assert.equal(
    readFileSync(env.LEDGER, 'utf8').trim().split('\n').length,
    names.length,
    'public release must be read-only',
  )
})
