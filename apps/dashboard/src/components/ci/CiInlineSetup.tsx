/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { ArrowRightIcon, ArrowUpRight, ChevronDown } from '@/components/ui/icon'
import { RoutePath } from '@/enums/RoutePath'
import { CopyableCode, FIRST_JOB_WORKFLOW } from './CiFirstJobGuide'

/** Configuration help only; neither copying nor an existing connection certifies a job. */
export function CiInlineSetup({ connected }: { connected: boolean }) {
  const workflow = (
    <div className="min-w-0 space-y-3">
      <CopyableCode value="runs-on: boxlite" label="Copy runs-on" name="Example workflow change" diff />
      <p className="text-meta text-muted-foreground">No BoxLite API key required.</p>
    </div>
  )
  return (
    <section aria-label="CI workflow setup" className="mx-auto w-full max-w-5xl py-6 font-sans text-body md:py-8">
      {connected ? (
        <>
          <div className="mb-7">
            <h2 className="text-section font-medium">No active runners</h2>
            <p className="mt-2 text-muted-foreground">
              Runners appear while eligible GitHub Actions jobs run. Results and logs stay in GitHub Actions.
            </p>
          </div>
          <details open className="group border-y border-border">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 py-4 font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
              Configure a workflow
              <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
            </summary>
            <div className="grid items-start gap-6 pb-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] lg:gap-10">
              <div className="space-y-4">
                <p>
                  Change <code className="font-mono">runs-on</code> in your existing workflow.
                </p>
                <p className="text-muted-foreground">Commit the change and trigger your workflow as usual.</p>
                <Link
                  className="resource-guide-link inline-flex items-center gap-1"
                  to={RoutePath.CI_CONNECTS}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Check repository access <ArrowUpRight className="size-3.5" />
                </Link>
              </div>
              {workflow}
            </div>
          </details>
        </>
      ) : (
        <ol
          aria-label="CI setup steps"
          className="grid list-none items-start gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] lg:gap-10"
        >
          <li className="min-w-0">
            <div className="mb-4 flex items-center gap-3" aria-hidden="true">
              <span className="flex size-7 shrink-0 items-center justify-center border border-foreground/50 font-mono text-meta">
                01
              </span>
              <span className="h-px flex-1 bg-border" />
              <ArrowRightIcon className="hidden size-4 text-muted-foreground lg:block" />
            </div>
            <h2 className="text-section font-medium">
              <span className="sr-only">Step 1: </span>Connect GitHub to get started
            </h2>
            <p className="mt-3 max-w-sm leading-relaxed text-muted-foreground">
              Authorize your repositories to run GitHub Actions jobs on BoxLite.
            </p>
            <Button asChild className="mt-6">
              <Link to={RoutePath.CI_CONNECTS} target="_blank" rel="noopener noreferrer">
                Set up GitHub <ArrowUpRight className="size-4" />
              </Link>
            </Button>
          </li>
          <li className="min-w-0">
            <div className="mb-4 flex items-center gap-3 text-muted-foreground" aria-hidden="true">
              <span className="flex size-7 shrink-0 items-center justify-center border border-border font-mono text-meta">
                02
              </span>
              <span className="h-px flex-1 bg-border" />
            </div>
            <h2 className="mb-3 text-section font-medium">
              <span className="sr-only">Step 2: </span>Update your workflow
            </h2>
            {workflow}
          </li>
        </ol>
      )}
      <CiInlineHelp />
    </section>
  )
}

function CiInlineHelp() {
  const [testOpen, setTestOpen] = useState(false)
  const summaryClass =
    'flex cursor-pointer list-none items-center justify-between gap-3 py-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden'
  return (
    <div className="mt-6 border-t border-border">
      <details open={testOpen} onToggle={(event) => setTestOpen(event.currentTarget.open)} className="group/test">
        <summary className={summaryClass}>
          Try a test workflow
          <ChevronDown className="size-4 text-muted-foreground group-open/test:rotate-180" />
        </summary>
        {testOpen && (
          <div className="max-w-3xl space-y-4 pb-5">
            <p className="text-muted-foreground">
              Commit <code className="break-all font-mono">.github/workflows/boxlite-smoke.yml</code> to your
              repository’s default branch.
            </p>
            <CopyableCode value={FIRST_JOB_WORKFLOW} label="Copy workflow" name="Test workflow YAML" />
            <p>
              In GitHub, open <strong className="font-medium">Actions → BoxLite connection test → Run workflow</strong>.
            </p>
          </div>
        )}
      </details>
      <details className="group/help border-t border-border">
        <summary className={summaryClass}>
          Troubleshooting
          <ChevronDown className="size-4 text-muted-foreground group-open/help:rotate-180" />
        </summary>
        <dl className="max-w-3xl space-y-4 pb-5 text-muted-foreground">
          <div>
            <dt className="font-medium text-foreground">Waiting for a runner</dt>
            <dd>Check the runner label, repository access and available CI slots.</dd>
          </div>
          <div>
            <dt className="font-medium text-foreground">No Run workflow button</dt>
            <dd>Commit the test file to the default branch and check your GitHub write access.</dd>
          </div>
          <div>
            <dt className="font-medium text-foreground">Job failed</dt>
            <dd>Open the job in GitHub Actions and inspect the first failed step.</dd>
          </div>
        </dl>
      </details>
    </div>
  )
}
