const { defineConfig } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const dir = process.env.RP_E2E_DIR;
if (!dir || !fs.existsSync(path.join(dir,'test-instance.json'))) throw Error('Use python3 scripts/e2e.py; an isolated test instance is required.');
module.exports = defineConfig({
  testDir: '.', testMatch: '*.spec.cjs', workers: 1, fullyParallel: false,
  forbidOnly: true, retries: 0, timeout: 120000, globalTimeout: 30*60*1000,
  expect: { timeout: 10000 },
  outputDir: path.join(dir,'playwright-output'),
  reporter: [['./reporter.cjs']],
  use: { baseURL: `http://localhost:${process.env.RP_APP_PORT}`, browserName: 'chromium',
    viewport: { width: 1280, height: 900 }, trace: 'off', video: 'off', screenshot: 'off' },
});
