// End-to-end tests against the full local stack: Hosting, Auth, Firestore and Functions
// emulators (project demo-ai-planner) with the backend's fake external services.
// Run with: npm run test:e2e:emulator   (scripts/e2e/run-emulator-e2e.sh)
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
    testDir: './tests/emulator',
    globalSetup: require.resolve('./tests/emulator/global-setup.js'),
    timeout: 90 * 1000,
    expect: { timeout: 20 * 1000 },
    fullyParallel: false,
    workers: 1,
    retries: process.env.CI ? 1 : 0,
    forbidOnly: !!process.env.CI,
    reporter: [['list'], ['html', { outputFolder: 'playwright-report-emulator', open: 'never' }]],
    use: {
        baseURL: 'http://localhost:5050',
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        serviceWorkers: 'block',
    },
    projects: [
        { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
        { name: 'desktop-firefox', use: { ...devices['Desktop Firefox'] } },
        { name: 'desktop-webkit', use: { ...devices['Desktop Safari'] } },
        { name: 'mobile-chrome', use: { ...devices['Pixel 7'] } },
        { name: 'mobile-safari', use: { ...devices['iPhone 15'] } },
    ],
});
