import { chromium, expect } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const profile = path.resolve(process.env.LOCALAPPDATA, 'io.anibox.qa');
const testRoot = path.resolve('.local/storage-test/' + Date.now());
const directoryA = path.join(testRoot, '原位置');
const directoryB = path.join(testRoot, '新目录 data');
assert(testRoot.startsWith(path.resolve('.local') + path.sep));
const files = ['workspace.json', 'workspace.previous.json', 'storage.json', 'storage.previous.json'];
const saved = new Map();
for (const file of files) {
  const target = path.join(profile, file);
  assert(target.startsWith(profile + path.sep));
  saved.set(target, existsSync(target) ? await readFile(target) : null);
}
let app, browser, page, invoke;
async function launch() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  app = spawn(path.resolve('.local/qa/Anibox/Anibox.exe'), [], {
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
  });
  for (let i = 0; i < 100; i++) {
    if (app.exitCode !== null) throw new Error('QA app exited');
    try {
      if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break;
    } catch {
      /* Starting. */
    }
    await pause(150);
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  for (let i = 0; i < 60; i++) {
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
  await pause(200);
}
async function close() {
  if (invoke) {
    try {
      await invoke('close_app', { action: 'exit' });
    } catch {
      /* Exiting. */
    }
  }
  if (browser) await browser.close();
  if (app && app.exitCode === null)
    await Promise.race([new Promise((resolve) => app.once('exit', resolve)), pause(2000)]);
  if (app && app.exitCode === null) app.kill();
  invoke = browser = page = app = null;
  await pause(200);
}
try {
  await launch();
  const original = await invoke('load_data');
  await invoke('set_storage_directory', { directory: directoryA, data: original });
  const photo = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 8;
    canvas.height = 8;
    const c = canvas.getContext('2d');
    c.fillStyle = '#67b6e8';
    c.fillRect(0, 0, 8, 8);
    return canvas.toDataURL('image/png');
  });
  const data = JSON.parse(original);
  const content = '{\n "outbounds": [{"protocol":"freedom","tag":"direct"}],\n "future_field": 42\n}';
  data.profiles = [
    {
      id: 'storage-profile',
      name: 'storage-test',
      core: 'xray',
      content,
      updatedAt: new Date().toISOString(),
    },
  ];
  data.settings.appearance.home = { opacity: 78, blur: 0, image: photo };
  data.settings.appearance.cores = { opacity: 70, blur: 3, image: photo };
  await invoke('save_data', { data: JSON.stringify(data) });
  await page.reload();
  await page.getByRole('heading', { level: 1 }).waitFor();
  const raw = await invoke('load_data');
  const migrated = JSON.parse(raw);
  assert(!raw.includes('data:image'));
  assert.equal(migrated.profiles[0].content, content);
  const homeFile = migrated.settings.appearance.home.imageFile;
  assert.equal(await invoke('load_background', { name: homeFile }), photo);
  assert(existsSync(path.join(directoryA, 'backgrounds', homeFile)));
  await expect(page.locator('.main-panel > .page-background img')).toHaveAttribute('src', /data:image\/png/);
  console.log('PASS legacy embedded backgrounds migrate to independent files; native JSON is preserved');
  const portable = JSON.parse(await invoke('export_data', { data: raw }));
  assert.equal(portable.settings.appearance.home.image, photo);
  assert(!portable.settings.appearance.home.imageFile);
  await invoke('set_storage_directory', { directory: directoryB, data: raw });
  await close();
  await launch();
  const paths = await invoke('storage_info');
  assert.equal(path.resolve(paths.directory).toLowerCase(), directoryB.toLowerCase());
  assert.equal(JSON.parse(await invoke('load_data')).profiles[0].content, content);
  assert.equal(await invoke('load_background', { name: homeFile }), photo);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByLabel('配置文件', { exact: true })).toHaveValue(paths.configFile);
  await expect(page.getByLabel('背景文件夹', { exact: true })).toHaveValue(paths.backgroundDirectory);
  await page.getByRole('button', { name: '更改存储目录', exact: true }).click();
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'scripts/cancel-folder-dialog.ps1',
      '-ApplicationProcessId',
      String(app.pid),
    ],
    { windowsHide: true, timeout: 15000 },
  );
  await expect(page.getByRole('button', { name: '更改存储目录', exact: true })).toBeEnabled();
  assert.equal((await invoke('storage_info')).directory, paths.directory);
  console.log(
    'PASS custom storage survives restart; settings paths and native folder-picker cancellation work',
  );
  const foreign = path.join(testRoot, 'foreign');
  await mkdir(foreign, { recursive: true });
  await writeFile(path.join(foreign, 'workspace.json'), 'KEEP_EXISTING_DATA');
  await assert.rejects(invoke('set_storage_directory', { directory: foreign, data: raw }), /已有/);
  assert.equal(await readFile(path.join(foreign, 'workspace.json'), 'utf8'), 'KEEP_EXISTING_DATA');
  assert.equal((await invoke('storage_info')).directory, paths.directory);
  await unlink(path.join(directoryB, 'backgrounds', homeFile));
  await page.getByRole('button', { name: '主界面', exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.main-panel > .page-background img')).toHaveCount(0);
  console.log(
    'PASS existing destinations are preserved; deleted image files fall back to the default background',
  );
  await invoke('save_data', { data: JSON.stringify(portable) });
  await page.reload();
  await page.getByRole('heading', { level: 1 }).waitFor();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '恢复全部默认', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已恢复默认背景');
  const reset = JSON.parse(await invoke('load_data'));
  assert(Object.values(reset.settings.appearance).every((a) => !a.image && !a.imageFile));
  assert(!existsSync(path.join(directoryB, 'backgrounds', homeFile)));
  for (const file of ['workspace.json', 'workspace.previous.json']) {
    const target = path.join(directoryB, file);
    if (existsSync(target))
      assert(!(await readFile(target, 'utf8').then((text) => text.includes('data:image'))));
  }
  console.log('PASS portable backup restoration and complete background reset, including recovery copies');
} finally {
  await close();
  for (const [file, bytes] of saved) {
    if (bytes) await writeFile(file, bytes);
    else if (existsSync(file)) await unlink(file);
  }
}
