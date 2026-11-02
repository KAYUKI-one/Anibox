import { build } from 'esbuild';
import { execFileSync, spawn } from 'node:child_process';
import { createServer, createConnection } from 'node:net';
import { mkdir, readdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePair() {
  for (let attempt = 0; attempt < 64; attempt++) {
    const first = createServer();
    await new Promise((resolve, reject) => first.once('error', reject).listen(0, '127.0.0.1', resolve));
    const port = first.address().port;
    const second = createServer();
    try {
      if (port === 65535) continue;
      await new Promise((resolve, reject) =>
        second.once('error', reject).listen(port + 1, '127.0.0.1', resolve),
      );
      return port;
    } catch {
      // Try another pair without touching an existing listener.
    } finally {
      await Promise.all([first, second].map((server) => new Promise((resolve) => server.close(resolve))));
    }
  }
  throw new Error('No free local test ports');
}
async function startTemplate(exe, file, folder, port) {
  const child = spawn(exe, ['run', '-c', file], {
    cwd: folder,
    windowsHide: true,
    env: { ...process.env, XRAY_LOCATION_ASSET: folder },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '',
    failure,
    exited = false;
  const closed = new Promise((resolve) => child.once('close', resolve));
  child.on('error', (error) => {
    failure = error;
  });
  child.on('exit', () => {
    exited = true;
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (data) => {
      output = (output + data.toString()).slice(-65536);
    });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (failure || exited) break;
      ready = await new Promise((resolve) => {
        const socket = createConnection({ host: '127.0.0.1', port });
        const finish = (value) => {
          socket.destroy();
          resolve(value);
        };
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
        socket.setTimeout(100, () => finish(false));
      });
      if (ready) break;
      await pause(50);
    }
    await pause(250);
    if (failure || exited || !ready)
      throw new Error(`Full template startup failed: ${failure?.message ?? output.trim()}`);
  } finally {
    if (!exited) child.kill();
    await closed;
  }
}
const bundled = await build({
  stdin: {
    contents:
      'export {parseImport} from "./src/domain/import.ts"; export {buildConfig} from "./src/domain/config.ts"; export {emptyData} from "./src/domain/storage.ts";',
    resolveDir: root,
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
});
const { parseImport, buildConfig, emptyData } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
);
const folders = await readdir(root);
const xrayDir = folders.find((folder) => folder.toLowerCase().startsWith('xray-'));
const singDir = folders.find((folder) => folder.toLowerCase().startsWith('sing-box-'));
if (!xrayDir || !singDir) throw new Error('请先将 Xray 和 sing-box 的 Windows 内核目录放在项目根目录。');
const links = [
  ['VLESS TLS', 'vless://11111111-1111-4111-8111-111111111111@127.0.0.1:443?security=tls&sni=example.com'],
  [
    'VLESS REALITY',
    'vless://11111111-1111-4111-8111-111111111111@127.0.0.1:443?security=reality&sni=example.com&fp=chrome&pbk=CQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&flow=xtls-rprx-vision',
  ],
  [
    'VLESS WebSocket',
    'vless://11111111-1111-4111-8111-111111111111@127.0.0.1:443?security=tls&type=ws&path=%2Fproxy&sni=example.com',
  ],
  [
    'VLESS XHTTP',
    'vless://11111111-1111-4111-8111-111111111111@127.0.0.1:443?security=tls&type=xhttp&path=%2Fproxy&sni=example.com',
  ],
  ['Trojan', 'trojan://test-password@127.0.0.1:443?sni=example.com'],
  ['Shadowsocks', `ss://${Buffer.from('aes-128-gcm:test-password').toString('base64url')}@127.0.0.1:8388`],
  ['Hysteria2', 'hysteria2://test-password@127.0.0.1:443?sni=example.com'],
  ['TUIC', 'tuic://11111111-1111-4111-8111-111111111111:test-password@127.0.0.1:443?sni=example.com'],
];
await mkdir(path.join(root, '.local'), { recursive: true });
for (const mode of ['local', 'tun'])
  for (const [label, link] of links) {
    const result = parseImport(link);
    if (result.errors.length) throw new Error(`${label}: ${result.errors.join(', ')}`);
    const node = result.nodes[0];
    const generated = buildConfig(node, {
      ...emptyData(),
      route: 'bypass-cn',
      mode,
      settings: { ...emptyData().settings, port: mode === 'local' ? await freePair() : 10808 },
    });
    const file = path.join(root, '.local', `check-${node.core}-${process.pid}.json`);
    const config = JSON.parse(generated.config);
    if (config.route?.rule_set)
      for (const rule of config.route.rule_set)
        rule.path = path.join(root, 'assets/rules', rule.tag + '.srs');
    await writeFile(file, JSON.stringify(config));
    const folder = path.join(root, generated.core === 'xray' ? xrayDir : singDir);
    const args = generated.core === 'xray' ? ['run', '-test', '-c', file] : ['check', '-c', file];
    try {
      execFileSync(path.join(folder, generated.core === 'xray' ? 'xray.exe' : 'sing-box.exe'), args, {
        cwd: folder,
        timeout: 15000,
        windowsHide: true,
        stdio: 'pipe',
        env: { ...process.env, XRAY_LOCATION_ASSET: folder },
      });
      console.log(`PASS ${label} / ${mode} → ${generated.core}`);
      if (mode === 'local') {
        await startTemplate(
          path.join(folder, generated.core === 'xray' ? 'xray.exe' : 'sing-box.exe'),
          file,
          folder,
          config.inbounds[1][generated.core === 'xray' ? 'port' : 'listen_port'],
        );
        console.log(`PASS ${label}: full DNS, rules and outbound template actually starts`);
      }
    } catch (error) {
      throw new Error(`${label}: ${error.stderr?.toString() || error.stdout?.toString() || error.message}`);
    } finally {
      await unlink(file);
    }
  }
console.log('全部模板通过校验；本地完整模板已实际启动。仅绑定临时回环端口，未修改系统代理、DNS 或路由。');
