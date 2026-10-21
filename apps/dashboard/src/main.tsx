/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { NuqsAdapter } from 'nuqs/adapters/react-router/v6'
import React, { Suspense } from 'react'
import ReactDOM from 'react-dom/client'
import { ErrorBoundary } from 'react-error-boundary'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { ErrorBoundaryFallback } from './components/ErrorBoundaryFallback'
import LoadingFallback from './components/LoadingFallback'
import { PostHogProviderWrapper } from './components/PostHogProviderWrapper'
import { ThemeProvider } from './contexts/ThemeContext'
import './index.css'
import { ConfigProvider } from './providers/ConfigProvider'
import { QueryProvider } from './providers/QueryProvider'

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement)

async function enableMocking() {
  if (import.meta.env.VITE_ENABLE_MOCKING !== 'true') {
    return
  }

  const { worker } = await import('./mocks/browser')
  // Served under a base path (the Apps console lives at /console/), the worker
  // script sits there too. Requests MSW has no handler for (the console API)
  // go to the network untouched.
  return worker.start({
    serviceWorker: { url: `${import.meta.env.BASE_URL}mockServiceWorker.js` },
    onUnhandledRequest: 'bypass',
  })
}

enableMocking().then(() =>
  root.render(
    <React.StrictMode>
      <ErrorBoundary FallbackComponent={ErrorBoundaryFallback}>
        <QueryProvider>
          <ThemeProvider>
            <Suspense fallback={<LoadingFallback />}>
              <ConfigProvider>
                <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
                  <PostHogProviderWrapper>
                    <NuqsAdapter>
                      <App />
                    </NuqsAdapter>
                  </PostHogProviderWrapper>
                </BrowserRouter>
              </ConfigProvider>
            </Suspense>
          </ThemeProvider>
        </QueryProvider>
      </ErrorBoundary>
    </React.StrictMode>,
  ),
)
