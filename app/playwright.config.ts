import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './test',
  testMatch: ['e2e/**/*.spec.ts', 'visual/**/*.spec.ts'],
  tsconfig: './tsconfig.node.json',
  timeout: 120_000,
  workers: 1,
  reporter: [['list']],
  projects: [
    { name: 'e2e', testMatch: 'e2e/**/*.spec.ts' },
    // Pixel comparison against private reference screenshots; opt-in.
    { name: 'visual', testMatch: 'visual/**/*.spec.ts' },
  ],
})
