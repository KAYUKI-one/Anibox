import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
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
    } catch (error) {
      throw new Error(`${label}: ${error.stderr?.toString() || error.stdout?.toString() || error.message}`);
    } finally {
      await unlink(file);
    }
  }
console.log('全部模板通过本地内核校验。未启动代理或修改系统设置。');
