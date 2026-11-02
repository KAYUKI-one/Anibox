import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { cp, mkdir, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const project = process.cwd();
const source = path.resolve('.local/qa/Anibox');
const fixture = path.resolve('.local/update-test/Anibox');
const profile = path.resolve(process.env.LOCALAPPDATA, 'io.anibox.qa');
const coreCache = path.join(profile, 'cores');
const backup = path.join(profile, 'cores-update-test-backup');
assert(fixture.startsWith(path.join(project, '.local') + path.sep));
assert(coreCache.startsWith(profile + path.sep) && backup.startsWith(profile + path.sep));
assert(!existsSync(backup), 'An earlier update test needs its backup restored first');
await mkdir(fixture, { recursive: true });
await cp(path.join(source, 'Anibox.exe'), path.join(fixture, 'Anibox.exe'));
await cp(path.join(source, 'rules'), path.join(fixture, 'rules'), { recursive: true });
// A fixture with no packaged cores exercises first installation without replacing a user's core.
assert(!existsSync(path.join(fixture, 'cores')), 'Use a fresh .local/update-test/Anibox directory');
const hadCache = existsSync(coreCache);
if (hadCache) await rename(coreCache, backup);
const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const debugPort = server.address().port;
await new Promise((resolve) => server.close(resolve));
const app = spawn(path.join(fixture, 'Anibox.exe'), [], {
  windowsHide: true,
  stdio: 'ignore',
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}` },
});
let browser, invoke;
try {
  for (let i = 0; i < 100; i++) {
    if (app.exitCode !== null) throw new Error('Isolated app exited before startup');
    try {
      if ((await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok) break;
    } catch {
      /* Starting. */
    }
    await pause(150);
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  let page;
  for (let attempt = 0; attempt < 60; attempt++) {
    page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((p) => p.url().includes('tauri.localhost'));
    if (page) break;
    await pause(100);
  }
  assert(page);
  await page.getByRole('heading', { level: 1 }).waitFor();
  invoke = (command, args = {}) =>
    page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
  assert((await invoke('discover_cores')).every((core) => !core.available));
  const releases = await invoke('check_core_updates', { force: true });
  assert.equal(releases.length, 2);
  assert(
    releases.every((item) => item.available && !item.error),
    JSON.stringify(releases),
  );
  console.log('PASS official release discovery, architecture selection and new-version comparison');
  await assert.rejects(invoke('install_core_update', { core: 'xray', version: '../invalid' }));
  const xray = releases.find((item) => item.core === 'xray');
  await page.getByRole('button', { name: '内核', exact: true }).click();
  await page.getByRole('button', { name: '检查内核更新', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '内核更新' });
  await dialog.waitFor();
  const xrayRow = dialog.locator('.core-update-item').filter({ hasText: 'Xray' });
  await xrayRow.getByRole('button', { name: '更新', exact: true }).click();
  await xrayRow.getByRole('button', { name: '已是最新', exact: true }).waitFor({ timeout: 180000 });
  const installed = (await invoke('check_core_updates', { force: false })).find(
    (item) => item.core === 'xray',
  );
  assert.equal(installed.currentVersion, xray.latestVersion);
  assert(!installed.available && installed.rollbackAvailable);
  let discovered = await invoke('discover_cores');
  assert(discovered.find((item) => item.core === 'xray').path.includes('io.anibox.qa'));
  console.log('PASS Xray official download, SHA256, extraction, native validation and activation');
  await mkdir('.local/screenshots', { recursive: true });
  await page.screenshot({ path: '.local/screenshots/core-updates.png' });

  const sing = releases.find((item) => item.core === 'sing-box');
  await assert.rejects(
    invoke('install_core_update', {
      core: 'sing-box',
      version: sing.latestVersion,
      config: '{"outbounds":[{"type":"unsupported-test-protocol"}]}',
      managed: false,
    }),
    /校验/,
  );
  assert(!(await invoke('discover_cores')).find((item) => item.core === 'sing-box').available);
  assert(!existsSync(path.join(coreCache, 'sing-box', 'active.json')));
  console.log('PASS incompatible configuration leaves active core selection unchanged');

  const portServer = createServer();
  await new Promise((resolve) => portServer.listen(0, '127.0.0.1', resolve));
  const proxyPort = portServer.address().port;
  await new Promise((resolve) => portServer.close(resolve));
  const config = JSON.stringify({
    inbounds: [{ protocol: 'http', tag: 'http-in', listen: '127.0.0.1', port: proxyPort }],
    outbounds: [{ protocol: 'freedom', tag: 'direct' }],
  });
  const running = await invoke('start_core', { core: 'xray', config, mode: 'local', managed: true });
  const singInstall = invoke('install_core_update', { core: 'sing-box', version: sing.latestVersion });
  await pause(100);
  await assert.rejects(
    invoke('install_core_update', { core: 'sing-box', version: sing.latestVersion }),
    /正在更新/,
  );
  assert.equal((await singInstall).currentVersion, sing.latestVersion);
  assert.equal((await invoke('runtime_status')).pid, running.pid);
  await invoke('stop_core');
  console.log('PASS sing-box install, duplicate-update guard and uninterrupted existing connection');
  discovered = await invoke('discover_cores');
  for (const item of discovered) {
    assert(item.available && item.path.includes('io.anibox.qa'));
    await invoke('validate_config', {
      core: item.core,
      config:
        item.core === 'xray' ? '{"outbounds":[{"protocol":"freedom"}]}' : '{"outbounds":[{"type":"direct"}]}',
    });
  }
  assert(
    existsSync(
      path.join(path.dirname(discovered.find((item) => item.core === 'sing-box').path), 'wintun.dll'),
    ),
  );
  const current = await invoke('check_core_updates', { force: false });
  assert(current.every((item) => !item.available && !item.error));
  await assert.rejects(invoke('rollback_core', { core: 'xray' }));
  assert((await invoke('discover_cores')).find((item) => item.core === 'xray').path.includes('io.anibox.qa'));
  await cp(path.join(source, 'cores'), path.join(fixture, 'cores'), { recursive: true });
  for (const core of ['xray', 'sing-box']) await invoke('rollback_core', { core });
  const recovered = await invoke('discover_cores');
  const expectedRoot = path.toNamespacedPath(fixture).toLowerCase() + path.sep;
  assert(
    recovered.every((item) => path.toNamespacedPath(item.path).toLowerCase().startsWith(expectedRoot)),
    JSON.stringify(recovered),
  );
  console.log(
    'PASS updated cores validate, latest-version cache, safe failed rollback and bundled-version recovery',
  );
} finally {
  if (invoke) {
    try {
      await invoke('close_app', { action: 'exit' });
    } catch {
      /* Exiting. */
    }
  }
  if (browser) await browser.close();
  if (app.exitCode === null)
    await Promise.race([new Promise((resolve) => app.once('exit', resolve)), pause(2000)]);
  if (app.exitCode === null) app.kill();
  await pause(300);
  if (existsSync(coreCache)) await rm(coreCache, { recursive: true });
  if (hadCache) await rename(backup, coreCache);
  if (existsSync(path.join(fixture, 'cores'))) await rm(path.join(fixture, 'cores'), { recursive: true });
}
