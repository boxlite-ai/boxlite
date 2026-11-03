/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

export interface QuickstartRecipe {
  id: string
  label: string
  title: string
  description: string
  result: string
  command?: { executable: string; args: string[] }
}

const python = (script: string) => ({ executable: 'python3', args: ['-c', script] })

export const QUICKSTART_RECIPES: readonly QuickstartRecipe[] = [
  {
    id: 'coding-agent',
    label: 'Coding agent',
    title: 'Give your agent a safe place to iterate.',
    description: 'Try the edit → test → fix loop with a small generated Python module. No model key needed.',
    result: 'A failing test, a one-line fix, then a passing test inside the same Box.',
    command: python(String.raw`from pathlib import Path
import subprocess, sys, difflib, tempfile, shutil
root = Path(tempfile.mkdtemp(prefix='boxlite-code-'))
p = root / 'calculator.py'
before = 'def add(a, b): return a - b\n'
after = 'def add(a, b): return a + b\n'
p.write_text(before)
test = 'from calculator import add; assert add(2, 3) == 5'
first = subprocess.run([sys.executable, '-B', '-c', test], cwd=root, capture_output=True)
print('Before fix: FAIL' if first.returncode else 'Before fix: PASS')
p.write_text(after)
print(''.join(difflib.unified_diff(before.splitlines(True), after.splitlines(True), fromfile='before', tofile='after')))
subprocess.run([sys.executable, '-B', '-c', test], cwd=root, check=True)
print('After fix: PASS')
shutil.rmtree(root)`),
  },
  {
    id: 'code-execution',
    label: 'Run untrusted code',
    title: 'Run untrusted code in a Box.',
    description: 'Start with a disposable environment. Run a command, read its output, then clean up.',
    result: 'Hello from BoxLite, an exit code, and automatic Box cleanup.',
    command: { executable: 'echo', args: ['Hello from BoxLite'] },
  },
  {
    id: 'browser-agent',
    label: 'Browser automation',
    title: 'Give your agent a browser.',
    description:
      'Install Playwright and Chromium, then fill and submit a local HTML form. The first run downloads the browser.',
    result: 'A submitted form and “Browser task: PASS”. No website account required.',
    command: {
      executable: 'sh',
      args: [
        '-lc',
        String.raw`set -eu
python3 -m venv /tmp/browser-env
/tmp/browser-env/bin/pip install playwright
/tmp/browser-env/bin/playwright install --with-deps chromium
/tmp/browser-env/bin/python - <<'PY'
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.set_content('<form onsubmit="event.preventDefault();document.querySelector(\'output\').textContent=\'Submitted\'"><label>Name<input name="name"></label><button>Submit</button></form><output></output>')
    page.get_by_label('Name').fill('BoxLite')
    page.get_by_role('button', name='Submit').click()
    assert page.locator('output').inner_text() == 'Submitted'
    print('Browser task: PASS')
    browser.close()
PY`,
      ],
    },
  },
  {
    id: 'long-running-agent',
    label: 'Data processing',
    title: 'Turn a file into an answer.',
    description:
      'Read a sample CSV, aggregate revenue by product, and print a JSON report. Python standard library only.',
    result: 'A JSON report: compute $42, storage $8, total $50.',
    command: python(String.raw`import csv, io, json
rows = csv.DictReader(io.StringIO('product,revenue\ncompute,30\nstorage,8\ncompute,12\n'))
totals = {}
for row in rows:
    totals[row['product']] = totals.get(row['product'], 0) + int(row['revenue'])
print(json.dumps({'revenue': totals, 'total': sum(totals.values())}, indent=2))`),
  },
  {
    id: 'application-deployments',
    label: 'Application deployments',
    title: 'Put your agent’s app online.',
    description: 'Give your coding agent a ready-to-copy prompt. It builds an app and publishes it on BoxLite.',
    result: 'A running app with a public URL. This guide waits for your agent’s Box.',
  },
  {
    id: 'reinforcement-learning',
    label: 'Reinforcement learning',
    title: 'Run your first rollout.',
    description:
      'Try 200 steps of a seeded, epsilon-greedy bandit on CPU. A small environment for testing the rollout loop.',
    result: 'Action counts, estimated rewards and the selected arm. No GPU or model download.',
    command: python(String.raw`import random, json
random.seed(7)
rewards, counts, values = [0.2, 0.5, 0.8], [0]*3, [0.0]*3
for step in range(200):
    arm = random.randrange(3) if random.random() < 0.2 else max(range(3), key=lambda i: values[i])
    reward = int(random.random() < rewards[arm])
    counts[arm] += 1
    values[arm] += (reward - values[arm]) / counts[arm]
print(json.dumps({'steps': 200, 'counts': counts, 'estimated_rewards': values, 'best_arm': max(range(3), key=lambda i: values[i])}, indent=2))`),
  },
  {
    id: 'ci-evals',
    label: 'CI & agent evaluations',
    title: 'Make every run reproducible.',
    description:
      'Evaluate a candidate function against three fixed cases in a clean Box. Failures produce a nonzero exit code.',
    result: 'Three passing cases and a machine-readable score. Replace the candidate with your agent’s output.',
    command: python(String.raw`import json, sys
def candidate(value):
    return value.strip().lower()
cases = [(' BOX ', 'box'), ('Agent', 'agent'), ('', '')]
results = [{'input': text, 'passed': candidate(text) == expected} for text, expected in cases]
passed = sum(item['passed'] for item in results)
print(json.dumps({'passed': passed, 'total': len(cases), 'cases': results}, indent=2))
sys.exit(0 if passed == len(cases) else 1)`),
  },
  {
    id: 'state-recovery',
    label: 'Agent state & recovery',
    title: 'Pick up where a worker left off.',
    description:
      'Save a checkpoint, end the worker, then launch another process in the same Box. This finite demo cleans up afterward.',
    result: 'Worker one saves step 3; worker two resumes and saves step 6.',
    command: python(String.raw`from pathlib import Path
import subprocess, sys, tempfile, shutil
root = Path(tempfile.mkdtemp(prefix='boxlite-worker-'))
worker = root / 'worker.py'
worker.write_text("from pathlib import Path\np = Path('checkpoint.txt')\nstart = int(p.read_text()) if p.exists() else 0\nprint('Resumed at', start)\np.write_text(str(start + 3))\nprint('Checkpoint saved:', start + 3)\n")
for _ in range(2):
    subprocess.run([sys.executable, str(worker)], cwd=root, check=True)
assert (root / 'checkpoint.txt').read_text() == '6'
shutil.rmtree(root)`),
  },
  {
    id: 'artifacts',
    label: 'Files & artifacts',
    title: 'Let your agent produce a deliverable.',
    description:
      'Generate a report and CSV, package both into a ZIP, and return the archive as base64 before removing the Box.',
    result: 'A file manifest and an encoded ZIP that you can save and decode locally.',
    command: python(String.raw`import io, zipfile, base64, json
archive = io.BytesIO()
with zipfile.ZipFile(archive, 'w') as z:
    z.writestr('report.md', '# Run report\n\n3 tasks completed.\n')
    z.writestr('results.csv', 'task,status\n1,passed\n2,passed\n3,passed\n')
    print(json.dumps({'files': z.namelist()}))
print('ZIP_BASE64=' + base64.b64encode(archive.getvalue()).decode())`),
  },
]

export function quickstartRecipeFor(useCase?: string | null): QuickstartRecipe {
  return QUICKSTART_RECIPES.find((recipe) => recipe.id === useCase) ?? QUICKSTART_RECIPES[1]
}

export function quickstartEntryFor(useCase?: string | null): QuickstartRecipe {
  return quickstartRecipeFor(useCase === 'application-deployments' ? useCase : 'code-execution')
}
