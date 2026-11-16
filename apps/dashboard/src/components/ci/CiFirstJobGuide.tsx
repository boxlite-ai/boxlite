/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { useRef, useState, useEffect, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Check, Copy } from '@/components/ui/icon'
import { copyToClipboard } from '@/lib/copy-text'
import { RoutePath } from '@/enums/RoutePath'

export const FIRST_JOB_WORKFLOW = `name: BoxLite connection test

on:
  workflow_dispatch:

permissions: {}

jobs:
  verify:
    name: Verify runner
    runs-on: boxlite
    timeout-minutes: 5
    steps:
      - name: Verify execution
        shell: bash
        run: |
          echo "BoxLite runner is working"
          uname -s
          uname -m
`

/** Read-only guidance; copying and navigation never certify a workflow run. */
export function CiFirstJobGuide({
  context,
  label = 'How to run a job',
  primary = false,
}: {
  context?: (close: () => void) => ReactNode
  label?: string
  primary?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [testOpen, setTestOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const changeOpen = (value: boolean) => {
    setOpen(value)
    if (!value) {
      setTestOpen(false)
      setHelpOpen(false)
    }
  }
  const summaryStyle =
    'cursor-pointer py-2 font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring'
  return (
    <Sheet open={open} onOpenChange={changeOpen}>
      <SheetTrigger asChild>
        <Button
          variant={primary ? 'default' : 'link'}
          size="sm"
          className={primary ? undefined : 'resource-guide-link h-auto min-h-6 p-0 text-body font-normal'}
        >
          {label}
        </Button>
      </SheetTrigger>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl font-sans">
        <SheetHeader className="border-b border-border px-6 py-5 pr-10 text-left">
          <SheetTitle>Run GitHub Actions on BoxLite</SheetTitle>
          <SheetDescription>Run your workflows on BoxLite runners.</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-7 overflow-y-auto px-6 py-5 text-body leading-relaxed">
          <section aria-label="GitHub connection">
            {context?.(() => changeOpen(false)) ?? (
              <p className="text-muted-foreground">
                First,{' '}
                <Link className="resource-guide-link" to={RoutePath.CI_CONNECTS} onClick={() => changeOpen(false)}>
                  connect GitHub
                </Link>{' '}
                to your BoxLite organization. Installing the App alone does not link an organization.
              </p>
            )}
          </section>
          <section aria-label="Use an existing workflow" className="space-y-3">
            <p>
              Change <code>runs-on</code> in your workflow:
            </p>
            <CopyableCode value="runs-on: boxlite" label="Copy runs-on" name="Example workflow change" diff />
            <p className="text-muted-foreground">
              No BoxLite API key required. Commit the change and trigger your workflow as usual.
            </p>
          </section>
          <div className="space-y-3 border-t border-border pt-3">
            <details open={testOpen} onToggle={(event) => setTestOpen(event.currentTarget.open)}>
              <summary className={summaryStyle}>Try a test workflow</summary>
              {testOpen && (
                <div className="space-y-4 pt-3">
                  <p className="text-muted-foreground">
                    Verify the connection without checking out your code or adding dependencies.
                  </p>
                  <p>
                    Save this file as <code className="break-all">.github/workflows/boxlite-smoke.yml</code> and commit
                    it to your repository’s <strong className="font-medium">default branch</strong>. If the branch is
                    protected, open and merge a pull request.
                  </p>
                  <CopyableCode value={FIRST_JOB_WORKFLOW} label="Copy workflow" name="Workflow YAML" />
                  <p>
                    After committing the file to your default branch, open{' '}
                    <strong className="font-medium">Actions</strong> in GitHub. Select the workflow you added, then
                    choose <strong className="font-medium">Run workflow</strong>.
                  </p>
                  <p className="text-muted-foreground">
                    The example above is named <strong className="font-medium">BoxLite connection test</strong>. You
                    need GitHub write access to run it.
                  </p>
                  <p>
                    Open the run’s <strong className="font-medium">Verify runner</strong> job. Its log should contain{' '}
                    <code>BoxLite runner is working</code>.
                  </p>
                  <p className="text-muted-foreground">
                    This test uses temporary compute resources. GitHub Actions keeps the result and logs after the
                    runner is removed.
                  </p>
                </div>
              )}
            </details>
            <details open={helpOpen} onToggle={(event) => setHelpOpen(event.currentTarget.open)}>
              <summary className={summaryStyle}>Troubleshooting</summary>
              {helpOpen && (
                <div className="space-y-5 pt-3">
                  <dl className="space-y-4 text-muted-foreground">
                    <div>
                      <dt className="font-medium text-foreground">Waiting for a runner</dt>
                      <dd>
                        Check <code>runs-on: boxlite</code>, your GitHub connection, repository access and available
                        capacity in Runners.
                      </dd>
                    </div>
                    <div>
                      <dt className="font-medium text-foreground">No Run workflow button for the test</dt>
                      <dd>
                        Commit the test file to the default branch with <code>workflow_dispatch</code>, and check your
                        GitHub write access.
                      </dd>
                    </div>
                    <div>
                      <dt className="font-medium text-foreground">Job started but failed</dt>
                      <dd>Open the job in GitHub Actions and inspect the first failed step.</dd>
                    </div>
                  </dl>
                  <div className="flex flex-wrap gap-4">
                    <Link className="resource-guide-link" to={RoutePath.CI_CONNECTS} onClick={() => changeOpen(false)}>
                      Check connections and repository access
                    </Link>
                    <Link className="resource-guide-link" to={RoutePath.CI} onClick={() => changeOpen(false)}>
                      Check runner capacity
                    </Link>
                  </div>
                </div>
              )}
            </details>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function CopyableCode({
  value,
  label,
  name,
  diff = false,
}: {
  value: string
  label: string
  name: string
  diff?: boolean
}) {
  const [state, setState] = useState<'idle' | 'pending' | 'copied' | 'failed'>('idle')
  const generation = useRef(0)
  useEffect(
    () => () => {
      generation.current++
    },
    [],
  )
  const copy = async () => {
    const current = generation.current
    setState('pending')
    const copied = await copyToClipboard(value)
    if (current === generation.current) setState(copied ? 'copied' : 'failed')
  }
  const action = (
    <Button size="sm" variant="outline" disabled={state === 'pending'} onClick={() => void copy()}>
      {state === 'copied' ? <Check /> : <Copy />}
      {state === 'copied' ? 'Copied' : label}
    </Button>
  )
  return (
    <div className="space-y-2">
      {diff ? (
        <div className="overflow-hidden border border-border bg-muted/30">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
            <span className="min-w-0 break-all font-mono text-meta">
              .github/workflows/ci.yml <span className="font-sans text-muted-foreground">· Example</span>
            </span>
            {action}
          </div>
          <pre tabIndex={0} aria-label={name} className="overflow-x-auto py-4 font-mono text-body leading-relaxed">
            <code>
              <span className="block px-4">{'  jobs:'}</span>
              <span className="block px-4">{'    build:'}</span>
              <span className="block bg-destructive/10 px-4 text-destructive">
                <span aria-hidden="true">{'− '}</span>
                <span className="sr-only">Remove: </span>
                <del>{'    runs-on: ubuntu-latest'}</del>
              </span>
              <span className="block bg-success/10 px-4 text-success">
                <span aria-hidden="true">{'+ '}</span>
                <span className="sr-only">Add: </span>
                <ins className="no-underline">{'    runs-on: boxlite'}</ins>
              </span>
              <span className="block px-4">{'      steps:'}</span>
              <span className="block px-4 text-muted-foreground">{'        # Your existing steps'}</span>
            </code>
          </pre>
        </div>
      ) : (
        <>
          <div className="flex justify-end">{action}</div>
          <pre
            tabIndex={0}
            aria-label={name}
            className="overflow-x-auto border border-border bg-muted/30 p-4 font-mono text-body leading-relaxed"
          >
            <code>{value}</code>
          </pre>
        </>
      )}
      {state === 'failed' && (
        <div>
          <p role="alert">Couldn’t copy. Select and copy the code below.</p>
          <pre tabIndex={0} className="overflow-x-auto font-mono text-body">
            <code>{value}</code>
          </pre>
        </div>
      )}
    </div>
  )
}
