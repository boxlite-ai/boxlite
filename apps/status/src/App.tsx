// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { useCallback, useEffect, useState } from 'react'
import {
  fetchStatusSnapshot,
  isStatusSnapshotFresh,
  STATUS_SNAPSHOT_MAX_AGE_MS,
  type ServiceStatus,
  type StatusSnapshot,
} from './status-snapshot'

const PUBLIC_STATUS_PATH = '/public-status.json'
const REFRESH_INTERVAL_MS = 60 * 1000

const STATUS_LABELS: Record<ServiceStatus, string> = {
  operational: 'Operational',
  partial_outage: 'Partial outage',
  outage: 'Outage',
}

function StatusMark({ status }: { status: ServiceStatus }) {
  return (
    <span className={`status-mark status-mark--${status}`}>
      <span className="status-mark__dot" aria-hidden="true" />
      {STATUS_LABELS[status]}
    </span>
  )
}

function StatusUnavailable() {
  return (
    <section className="notice" role="status">
      <div className="notice__title">
        <span className="notice__dot" aria-hidden="true" />
        <h2>Status unavailable</h2>
      </div>
      <p>Current service health could not be verified. No operational claim is being made.</p>
    </section>
  )
}

function RegionStatus({ region }: { region: StatusSnapshot['regions'][number] }) {
  const [isExpanded, setIsExpanded] = useState(true)
  const serviceListId = `region-services-${region.id}`

  return (
    <section className="region">
      <h2 className="region__heading">
        <button
          type="button"
          className="region__toggle"
          aria-controls={serviceListId}
          aria-expanded={isExpanded}
          onClick={() => setIsExpanded((expanded) => !expanded)}
        >
          <span className="region__identity">
            <span className={`region__chevron${isExpanded ? '' : ' region__chevron--collapsed'}`} aria-hidden="true">
              ▾
            </span>
            <span>
              <span className="region__eyebrow">AWS region</span>
              <span className="region__name">{region.id}</span>
            </span>
          </span>
          <StatusMark status={region.status} />
        </button>
      </h2>
      <ul id={serviceListId} className="services" hidden={!isExpanded}>
        {region.services.map((service) => (
          <li key={service.id} className="service">
            <span>{service.name}</span>
            <StatusMark status={service.status} />
          </li>
        ))}
      </ul>
    </section>
  )
}

export default function App() {
  const [snapshot, setSnapshot] = useState<StatusSnapshot | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [hasError, setHasError] = useState(false)
  const [freshnessNow, setFreshnessNow] = useState(() => Date.now())

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const nextSnapshot = await fetchStatusSnapshot(PUBLIC_STATUS_PATH, signal)
      setSnapshot(nextSnapshot)
      setFreshnessNow(Date.now())
      setHasError(false)
    } catch {
      if (!signal?.aborted) {
        setHasError(true)
      }
    } finally {
      if (!signal?.aborted) {
        setIsLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    const intervalId = window.setInterval(() => void refresh(controller.signal), REFRESH_INTERVAL_MS)
    return () => {
      controller.abort()
      window.clearInterval(intervalId)
    }
  }, [refresh])

  useEffect(() => {
    if (!snapshot) return

    const expiresAt = Date.parse(snapshot.generatedAt) + STATUS_SNAPSHOT_MAX_AGE_MS
    const checkFreshness = () => setFreshnessNow(Date.now())
    const timeoutId = window.setTimeout(checkFreshness, Math.max(0, expiresAt - Date.now() + 1))
    document.addEventListener('visibilitychange', checkFreshness)
    return () => {
      window.clearTimeout(timeoutId)
      document.removeEventListener('visibilitychange', checkFreshness)
    }
  }, [snapshot])

  const snapshotIsFresh = snapshot ? isStatusSnapshotFresh(snapshot, freshnessNow) : false
  const consoleUrl = import.meta.env.VITE_CONSOLE_URL || 'https://boxlite.ai'

  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="brand" href={consoleUrl} aria-label="BoxLite console">
          <span className="brand__mark" aria-hidden="true">
            B
          </span>
          <span>BoxLite</span>
        </a>
        <span className="site-header__label">System status</span>
      </header>

      <main className="page">
        <div className="page__intro">
          <p className="eyebrow">Platform availability</p>
          <h1>BoxLite Status</h1>
          <p>Current availability of API, Runner, and Proxy services by AWS region.</p>
        </div>

        {isLoading ? (
          <div className="notice" role="status">
            Loading current status…
          </div>
        ) : hasError || !snapshot || !snapshotIsFresh ? (
          <StatusUnavailable />
        ) : (
          <div className="status-content">
            <section className="summary" aria-label="Status update time">
              <div>
                <span className="eyebrow">Last updated</span>
                <time dateTime={snapshot.generatedAt}>{new Date(snapshot.generatedAt).toLocaleString()}</time>
              </div>
              <span>AWS</span>
            </section>
            <div className="regions">
              {snapshot.regions.map((region) => (
                <RegionStatus key={region.id} region={region} />
              ))}
            </div>
          </div>
        )}
      </main>

      <footer className="site-footer">
        <span>BoxLite infrastructure status</span>
        <a href={consoleUrl}>Open BoxLite</a>
      </footer>
    </div>
  )
}
