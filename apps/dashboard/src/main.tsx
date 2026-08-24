/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { NuqsAdapter } from 'nuqs/adapters/react-router/v6'
import React, { Suspense } from 'react'
import ReactDOM from 'react-dom/client'
import { ErrorBoundary } from 'react-error-boundary'
import { BrowserRouter, useLocation } from 'react-router-dom'
import App from './App'
import { ErrorBoundaryFallback } from './components/ErrorBoundaryFallback'
import LoadingFallback from './components/LoadingFallback'
import { PostHogProviderWrapper } from './components/PostHogProviderWrapper'
import { ThemeProvider } from './contexts/ThemeContext'
import { RoutePath } from './enums/RoutePath'
import './index.css'
import Status from './pages/Status'
import { ConfigProvider } from './providers/ConfigProvider'
import { QueryProvider } from './providers/QueryProvider'

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement)

function Application() {
  const location = useLocation()

  if (location.pathname === RoutePath.STATUS || location.pathname === `${RoutePath.STATUS}/`) {
    return <Status />
  }

  return (
    <Suspense fallback={<LoadingFallback />}>
      <ConfigProvider>
        <PostHogProviderWrapper>
          <NuqsAdapter>
            <App />
          </NuqsAdapter>
        </PostHogProviderWrapper>
      </ConfigProvider>
    </Suspense>
  )
}

async function enableMocking() {
  if (import.meta.env.VITE_ENABLE_MOCKING !== 'true') {
    return
  }

  const { worker } = await import('./mocks/browser')
  return worker.start()
}

enableMocking().then(() =>
  root.render(
    <React.StrictMode>
      <ErrorBoundary FallbackComponent={ErrorBoundaryFallback}>
        <QueryProvider>
          <ThemeProvider>
            <BrowserRouter>
              <Application />
            </BrowserRouter>
          </ThemeProvider>
        </QueryProvider>
      </ErrorBoundary>
    </React.StrictMode>,
  ),
)
