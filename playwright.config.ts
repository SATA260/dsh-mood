import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests/web', timeout: 45_000, workers: 1,
  outputDir: 'test-results/browser', reporter: [['list'], ['html', { open: 'never' }]],
  use: { viewport: { width: 1440, height: 1100 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: process.env.DSH_MOOD_TEST_URL ? undefined : { command: 'node scripts/web-test-server.mjs', url: `http://127.0.0.1:${process.env.DSH_MOOD_TEST_PORT ?? 18782}`, timeout: 120_000, reuseExistingServer: false, wait: { stdout: /MOOD_WEB_TEST_READY/ }, gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 } },
})
