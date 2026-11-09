import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/smoke',
  timeout: 300_000,
  workers: 1,
  reporter: 'list',
});
