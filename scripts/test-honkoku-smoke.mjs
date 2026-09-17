import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--config', 'playwright.honkoku-line.config.ts'], {
  stdio: 'inherit', env: { ...process.env, HONKOKU_REAL_SMOKE: '1' },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
