import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for Fabrik regression tests.
 *
 * Reporters:
 * - CTRF-JSON: machine-readable aggregation (dev-gui/Verbund-Auswertung)
 * - JUnit: CI standard (GitHub Actions, GitLab CI)
 *
 * See https://playwright.dev/docs/test-configuration for more options.
 */
export default defineConfig({
  testDir: './tests/regression',
  testMatch: '**/*.spec.ts',

  /* Run tests in files in parallel. */
  fullyParallel: true,

  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,

  /* Retry on CI only. */
  retries: process.env.CI ? 2 : 0,

  /* Opt out of parallel tests on CI. */
  workers: process.env.CI ? 1 : undefined,

  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: [
    ['html', { outputFolder: 'playwright-report' }],
    ['junit', { outputFile: 'test-results/junit.xml' }],
    ['json', { outputFile: 'test-results/results.json' }],
    ['playwright-ctrf-json-reporter', { outputDir: 'test-results' }],
  ],

  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /*
     * Base URL to use in actions like `await page.goto('/')`.
     * Set at runtime by scripts/run-regression.sh (regression-runner AC2/AC3/AC5):
     * resolved target ("local" -> http://localhost:<preview_port>, "url" -> the
     * declared suite URL). Undefined when run directly via `npx playwright test`
     * without the runner (falls back to Playwright's default: no base URL).
     */
    baseURL: process.env.REGRESSION_BASE_URL,

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',
  },

  /* Configure projects for major browsers.
   * NUR Chromium: das Runtime-Image installiert bewusst nur chromium
   * (Dockerfile: `npx playwright install --with-deps chromium`), um den
   * Image-Zuwachs klein zu halten. firefox/webkit würden mit
   * "Executable doesn't exist" fehlschlagen (Browser nicht im Image). Wer
   * Cross-Browser braucht, ergänzt hier UND den Dockerfile-Install gemeinsam. */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },

    /* Test against mobile viewports. */
    // {
    //   name: 'Mobile Chrome',
    //   use: { ...devices['Pixel 5'] },
    // },
    // {
    //   name: 'Mobile Safari',
    //   use: { ...devices['iPhone 12'] },
    // },

    /* Test against branded browsers. */
    // {
    //   name: 'Microsoft Edge',
    //   use: { ...devices['Desktop Edge'], channel: 'msedge' },
    // },
    // {
    //   name: 'Google Chrome',
    //   use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    // },
  ],

  /* Run your local dev server before starting the tests */
  // webServer: {
  //   command: 'npm run start',
  //   url: 'http://127.0.0.1:3000',
  //   reuseExistingServer: !process.env.CI,
  // },
});
