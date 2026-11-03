// Core traffic targets loopback only. Rule updates use the documented public provider.
// System proxy roundtrips and route-free TUN driver checks are explicit opt-ins.
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { spawn, execFileSync } from 'node:child_process';
import { createServer as createHttpServer, request } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const proxySnapshot = () =>
  JSON.parse(
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$r=Get-Item -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';$v=@{};foreach($n in @('ProxyEnable','ProxyServer','ProxyOverride','AutoConfigURL')){$v[$n]=$r.GetValue($n,$null,'DoNotExpandEnvironmentNames')};$v | ConvertTo-Json -Compress",
      ],
      { encoding: 'utf8', windowsHide: true },
    ),
  );
async function freePort() {
  const server = createTcpServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
let templateModule;
async function generatedConfig(core, mode, port = 10808) {
  if (!templateModule) {
    const result = await build({
      stdin: {
        contents:
          'export {parseImport} from "./src/domain/import.ts"; export {buildConfig} from "./src/domain/config.ts"; export {emptyData} from "./src/domain/storage.ts";',
        resolveDir: process.cwd(),
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      write: false,
    });
    templateModule = await import(
      'data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64')
    );
  }
  const { parseImport, buildConfig, emptyData } = templateModule;
  const link =
    core === 'xray'
      ? 'vless://11111111-1111-4111-8111-111111111111@127.0.0.1:443?security=tls&sni=example.com'
      : 'hysteria2://test-password@127.0.0.1:443?sni=example.com';
  const data = emptyData();
  data.mode = mode;
  data.settings.port = port;
  return JSON.parse(buildConfig(parseImport(link).nodes[0], data).config);
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
let blocker;
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
  if (['1', 'frame'].includes(process.env.ANIBOX_CHECK_WINDOW)) {
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
          ...(process.env.ANIBOX_CHECK_WINDOW === 'frame' ? ['-GeometryOnly'] : []),
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 15000 },
      ).trim(),
    );
  }
  if (process.env.ANIBOX_CHECK_WINDOW) {
    await invoke('plugin:window|toggle_maximize', { label: 'main' });
    await page.waitForFunction(() => document.querySelector('.app-shell')?.classList.contains('maximized'));
    await invoke('plugin:window|toggle_maximize', { label: 'main' });
    await page.waitForFunction(() => !document.querySelector('.app-shell')?.classList.contains('maximized'));
    console.log('PASS maximize and restore rounded frame');
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
    blocker = createTcpServer();
    await new Promise((resolve, reject) =>
      blocker.once('error', reject).listen(proxyPort, '127.0.0.1', resolve),
    );
    const config =
      core === 'xray'
        ? {
            log: { loglevel: 'info' },
            inbounds: [
              {
                tag: 'socks-in',
                listen: '127.0.0.1',
                port: proxyPort,
                protocol: 'socks',
                settings: { udp: true },
              },
              { tag: 'http-in', listen: '127.0.0.1', port: proxyPort + 1, protocol: 'http', settings: {} },
            ],
            outbounds: [{ protocol: 'freedom', tag: 'direct' }],
          }
        : {
            log: { level: 'info' },
            inbounds: [
              { type: 'socks', tag: 'socks-in', listen: '127.0.0.1', listen_port: proxyPort },
              { type: 'http', tag: 'http-in', listen: '127.0.0.1', listen_port: proxyPort + 1 },
            ],
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
    assert.notEqual(started.localPorts.socks, proxyPort, 'Occupied SOCKS port must be replaced');
    assert.equal(started.localPorts.http, started.localPorts.socks + 1);
    assert.match(started.message, /端口被占用/);
    const actual = JSON.parse(await invoke('current_config'));
    assert.equal(actual.inbounds[1][core === 'xray' ? 'port' : 'listen_port'], started.localPorts.http);
    await invoke('traffic_stats');
    const response = await new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port: started.localPorts.http,
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
    const liveLog = await invoke('runtime_logs');
    assert(liveLog.length > 0 && !liveLog.includes('\x1b'), 'Live native output must be readable');
    const logFile = path.join(process.env.LOCALAPPDATA, 'io.anibox.qa', 'logs', 'core.log');
    await pause(400);
    assert((await readFile(logFile, 'utf8')).length > 0, 'Core output must reach disk');
    await invoke('clear_logs', { kind: 'core' });
    assert.equal(await invoke('runtime_logs'), '');
    assert.equal(await readFile(logFile, 'utf8'), '');
    assert.equal((await invoke('runtime_status')).state, 'running', 'Clearing logs must not stop the core');
    assert.equal((await invoke('stop_core')).state, 'stopped');
    const native = structuredClone(config);
    if (core === 'sing-box') native.route = { final: 'direct' };
    await assert.rejects(
      invoke('start_core', { core, config: JSON.stringify(native), mode: 'local', managed: false }),
      /bind|address already|socket address|占用|10048/i,
    );
    const failure = await invoke('runtime_status');
    assert.equal(failure.state, 'error');
    assert.match(failure.message, /bind|address already|socket address|10048/i);
    await new Promise((resolve) => blocker.close(resolve));
    blocker = null;
    console.log(
      `PASS ${core}: occupied port → automatic replacement → real transfer; native bind failure retains core output`,
    );
  }
  if (process.env.ANIBOX_CHECK_TUN === '1') {
    for (const core of ['xray', 'sing-box']) {
      const previousProxy = proxySnapshot();
      const config = await generatedConfig(core, 'tun');
      // Preserve full DNS, routing and protocol options; only disable host interception for this driver test.
      const inbound = config.inbounds.find((i) => (i.protocol ?? i.type) === 'tun');
      if (core === 'xray') {
        inbound.settings.gateway = ['172.31.247.1/30'];
        inbound.settings.dns = [];
        inbound.settings.autoSystemRoutingTable = [];
      } else {
        Object.assign(inbound, {
          address: ['172.31.247.1/30'],
          auto_route: false,
          strict_route: false,
          dns_mode: 'disabled',
        });
      }
      console.log(
        `Checking ${core} TUN helper; Windows may request administrator authorization. No default routes or DNS interception are enabled.`,
      );
      try {
        const status = await invoke('start_core', {
          core,
          config: JSON.stringify(config),
          mode: 'tun',
          managed: true,
        });
        assert.equal(status.state, 'running');
        assert.equal(
          proxySnapshot().ProxyEnable,
          0,
          'TUN must bypass stale HTTP/SOCKS system proxy endpoints',
        );
        assert.equal(proxySnapshot().AutoConfigURL, null, 'TUN must suspend PAC routing');
        await pause(1200);
        assert.equal((await invoke('runtime_status')).state, 'running');
      } finally {
        await invoke('stop_core');
        assert.deepEqual(
          proxySnapshot(),
          previousProxy,
          'TUN stop must restore previous Windows proxy settings',
        );
      }
      console.log(
        `PASS ${core}: full DNS/routing template → elevated TUN driver start → status → stop (no default routes or DNS changes)`,
      );
    }
  }
  if (process.env.ANIBOX_CHECK_SYSTEM === '1') {
    const snapshot = () =>
      JSON.parse(
        execFileSync(
          'powershell',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            "$r=Get-Item -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';$v=@{};foreach($n in @('ProxyEnable','ProxyServer','ProxyOverride','AutoConfigURL')){$v[$n]=$r.GetValue($n,$null,'DoNotExpandEnvironmentNames')};$v | ConvertTo-Json -Compress",
          ],
          { encoding: 'utf8', windowsHide: true },
        ),
      );
    const previous = snapshot();
    for (const core of ['xray', 'sing-box']) {
      const port = await freePort();
      blocker = createTcpServer();
      await new Promise((resolve, reject) =>
        blocker.once('error', reject).listen(port, '127.0.0.1', resolve),
      );
      const config = await generatedConfig(core, 'system', port);
      try {
        const status = await invoke('start_core', {
          core,
          config: JSON.stringify(config),
          mode: 'system',
          managed: true,
        });
        assert.notEqual(status.localPorts.socks, port);
        const active = snapshot();
        assert.equal(active.ProxyEnable, 1);
        assert.equal(active.ProxyServer, `127.0.0.1:${status.localPorts.http}`);
      } finally {
        await invoke('stop_core');
        await new Promise((resolve) => blocker.close(resolve));
        blocker = null;
        const restored = snapshot();
        assert(
          Object.keys(previous).every(
            (key) => JSON.stringify(previous[key]) === JSON.stringify(restored[key]),
          ),
          'Previous system proxy settings must be restored',
        );
      }
      console.log(
        `PASS ${core}: full DNS/routing template → occupied port → correct Windows system proxy endpoint → original settings restored`,
      );
    }
  }
  await invoke('append_app_log', { entry: 'QA persisted application log' });
  assert((await invoke('app_logs')).includes('QA persisted application log'));
  await invoke('clear_logs', { kind: 'app' });
  assert.equal(await invoke('app_logs'), '');
  console.log(
    'PASS application/core logs persist to disk; live core logs can be cleared without disconnecting',
  );
  if (process.env.ANIBOX_CHECK_TUN_TRAFFIC === '1') {
    const { checkTunTraffic } = await import('./check-tun-traffic.mjs');
    await checkTunTraffic(invoke);
  }
  console.log('桌面集成验证通过；未访问外部节点。');
} finally {
  blocker?.close();
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
