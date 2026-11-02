// Core traffic targets loopback only. Rule updates use the documented public provider.
// No system proxy, DNS, or global route settings are changed.
import { chromium } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { createServer as createHttpServer, request } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function freePort() {
  const server = createTcpServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
const debugPort = await freePort();
const executable = path.resolve(process.env.ANIBOX_TEST_EXE || '.local/qa/Anibox/Anibox.exe');
const app = spawn(executable, [], {
  windowsHide: true,
  stdio: 'ignore',
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}` },
});
app.on('error', (error) => console.error(error.message));
let browser, page;
const target = createHttpServer((_req, res) => res.end('ANIBOX_LOOPBACK_OK'));
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (app.exitCode !== null) throw new Error('应用提前退出；请确认已有实例已退出。');
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      if (response.ok) break;
    } catch {
      /* WebView2 is starting. */
    }
    if (attempt === 99) throw new Error('WebView2 调试端口未就绪');
    await pause(200);
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  for (let attempt = 0; attempt < 50; attempt++) {
    page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().includes('tauri.localhost'));
    if (page) break;
    await pause(100);
  }
  assert(page, '找不到桌面主页面');
  await page.getByRole('heading', { level: 1 }).waitFor();
  const invoke = (command, args = {}) =>
    page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
  const discovered = await invoke('discover_cores');
  assert(discovered.length === 2 && discovered.every((core) => core.available), '打包后的两种内核都应可检测');
  assert.equal((await invoke('runtime_status')).state, 'stopped', '测试需要一个未连接的实例');
  console.log('PASS native startup, IPC and packaged core discovery');
  if (process.env.ANIBOX_CHECK_WINDOW === '1') {
    await invoke('plugin:window|show', { label: 'main' });
    await page.waitForTimeout(250);
    console.log(
      execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          'scripts/check-window.ps1',
          '-ApplicationProcessId',
          String(app.pid),
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 15000 },
      ).trim(),
    );
  }
  const originalData = await invoke('load_data');
  const roundtripData =
    originalData ??
    JSON.stringify({
      version: 1,
      nodes: [],
      subscriptions: [],
      profiles: [],
      selectedId: null,
      selectedProfileId: null,
      mode: 'local',
      route: 'bypass-cn',
      settings: { port: 10808, closeBehavior: 'ask', appearance: {} },
    });
  await invoke('save_data', { data: roundtripData });
  assert.equal(await invoke('load_data'), roundtripData);
  console.log('PASS native workspace persistence roundtrip');
  await page.waitForTimeout(400);
  assert(
    !(await page.locator('.toast').allTextContents()).some((text) => text.includes('保存失败')),
    '工作区保存不应报错',
  );
  await mkdir('.local/screenshots', { recursive: true });
  await page.screenshot({ path: '.local/screenshots/desktop.png' });

  // Verify the bundled editor and its workers inside the actual WebView2.
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('button', { name: '内核', exact: true }).click();
  await page.locator('.monaco-editor').first().waitFor();
  await page.screenshot({ path: '.local/screenshots/desktop-editor.png' });
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('PASS native JSON editor loads without CDN');
  const ruleState = await invoke('rules_status');
  assert(ruleState.ready, 'Packaged mainland SRS rules must be available offline');
  console.log('PASS packaged SRS rule bootstrap');
  const updatedRules = await invoke('update_rules', { force: true });
  assert(updatedRules.ready, 'Updating rules must keep a usable generation');
  console.log('PASS public rule update and cache activation');

  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  const targetPort = target.address().port;
  for (const core of ['xray', 'sing-box']) {
    const proxyPort = await freePort();
    const config =
      core === 'xray'
        ? {
            log: { loglevel: 'warning' },
            inbounds: [{ tag: 'test', listen: '127.0.0.1', port: proxyPort, protocol: 'http', settings: {} }],
            outbounds: [{ protocol: 'freedom', tag: 'direct' }],
          }
        : {
            log: { level: 'warn' },
            inbounds: [{ type: 'http', tag: 'test', listen: '127.0.0.1', listen_port: proxyPort }],
            outbounds: [{ type: 'direct', tag: 'direct' }],
            route: {
              final: 'direct',
              rule_set: [
                { type: 'local', tag: 'geosite-cn', format: 'binary', path: 'rules/geosite-cn.srs' },
                { type: 'local', tag: 'geoip-cn', format: 'binary', path: 'rules/geoip-cn.srs' },
              ],
            },
          };
    // The raw draft has relative resource paths. Managed start resolves those to the active cache generation.
    if (core === 'xray')
      assert.equal(await invoke('validate_config', { core, config: JSON.stringify(config) }), '内核校验通过');
    const started = await invoke('start_core', {
      core,
      config: JSON.stringify(config),
      mode: 'local',
      managed: true,
    });
    assert.equal(started.state, 'running');
    await invoke('traffic_stats');
    const response = await new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port: proxyPort,
          path: `http://127.0.0.1:${targetPort}/health`,
          headers: { Host: `127.0.0.1:${targetPort}` },
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => resolve(body));
        },
      );
      req.setTimeout(5000, () => req.destroy(new Error('本机代理请求超时')));
      req.on('error', reject);
      req.end();
    });
    assert.equal(response, 'ANIBOX_LOOPBACK_OK');
    await pause(250);
    const stats = await invoke('traffic_stats');
    assert(stats.available, core + ' statistics must be real and available');
    assert(stats.downloadTotal >= 19 && stats.uploadTotal > 0, core + ' must count the loopback request');
    console.log(
      'PASS ' + core + ' real counters: ' + stats.uploadTotal + ' up / ' + stats.downloadTotal + ' down',
    );
    assert.equal((await invoke('stop_core')).state, 'stopped');
    console.log(`PASS ${core}: validate → start → local HTTP proxy transfer → stop`);
  }
  console.log('桌面集成验证通过；未改变系统代理，未访问外部节点。');
} finally {
  target.close();
  if (page && !page.isClosed()) {
    try {
      await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('close_app', { action: 'exit' }));
    } catch {
      /* The window closes before IPC resolves. */
    }
  }
  if (browser) await browser.close().catch(() => {});
  await pause(500);
  if (app.exitCode === null) app.kill();
}
