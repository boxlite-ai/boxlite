import { defineConfig } from '@playwright/test'
import path from 'node:path'

const reports = process.env.REFERRAL_REPORT_DIR
if (!reports) throw new Error('Use make test:apps:referral:browser with REFERRAL_ARTIFACTS_DIR')
export default defineConfig({
  testDir: '.',
  testMatch: 'referral.browser.spec.ts',
  workers: 1,
  fullyParallel: false,
  timeout: 45000,
  expect: { timeout: 15000 },
  outputDir: path.join(reports, 'browser'),
  reporter: [['list'], ['json', { outputFile: path.join(reports, 'browser.json') }]],
  use: {
    browserName: 'chromium',
    baseURL: 'http://127.0.0.1:4390',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command:
        'yarn ts-node --project api/tsconfig.app.json --transpile-only --require tsconfig-paths/register api/src/organization-referral/test-support/browser-server.ts',
      cwd: path.resolve(__dirname, '..'),
      url: 'http://127.0.0.1:4491/__test__/ready',
      timeout: 120000,
      reuseExistingServer: false,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 50000 },
    },
    {
      command: 'yarn vite --config dashboard/vite.config.mts --host 127.0.0.1 --port 4390 --strictPort',
      cwd: path.resolve(__dirname, '..'),
      env: { DASHBOARD_API_PROXY_TARGET: 'http://127.0.0.1:4491', VITE_ENABLE_MOCKING: 'false' },
      url: 'http://127.0.0.1:4390/register',
      timeout: 60000,
      reuseExistingServer: false,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 10000 },
    },
  ],
})
