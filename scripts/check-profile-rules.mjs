import { readFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';

export async function checkProfileRules(invoke, page, port, targetPort) {
  const root = path.resolve('.local/qa/Anibox/rules');
  const filenames = ['geosite-google.srs', 'geosite-private.srs'];
  const backups = [];
  const original = await invoke('load_data');
  for (const name of filenames) {
    const file = path.join(root, name),
      backup = file + '.qa-backup-' + randomUUID();
    try {
      await rename(file, backup);
      backups.push([file, backup]);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      backups.push([file, null]);
    }
  }
  const config = JSON.stringify({
    log: { level: 'info' },
    inbounds: [{ type: 'http', tag: 'test-http', listen: '127.0.0.1', listen_port: port }],
    outbounds: [{ type: 'direct', tag: 'direct' }],
    route: {
      final: 'direct',
      rules: [{ rule_set: ['geosite-private'], outbound: 'direct' }],
      rule_set: [
        {
          type: 'local',
          tag: 'google-alias',
          format: 'binary',
          path: 'Z:\\missing-machine\\geosite-google.srs',
        },
      ],
    },
  });
  try {
    const pending = await invoke('prepare_config_rules', { core: 'sing-box', config, download: false });
    assert.equal(pending.missing.length, 2);
    assert(
      pending.missing.every((rule) =>
        rule.source.startsWith('https://raw.githubusercontent.com/2dust/sing-box-rules/'),
      ),
    );
    await assert.rejects(
      invoke('start_core', { core: 'sing-box', config, mode: 'local', managed: false }),
      /缺少规则集/,
    );
    await invoke('stop_core');
    const workspace = JSON.parse(original);
    const id = randomUUID();
    workspace.profiles.push({ id, name: '规则集测试', core: 'sing-box', content: config });
    workspace.selectedProfileId = id;
    workspace.mode = 'local';
    await invoke('save_data', { data: JSON.stringify(workspace) });
    await page.reload();
    await page.getByRole('heading', { level: 1 }).waitFor();
    await page.getByRole('button', { name: '连接', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '缺少规则集' });
    await dialog.waitFor();
    await page.screenshot({ path: '.local/screenshots/rule-download.png' });
    assert.equal((await invoke('runtime_status')).state, 'stopped');
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal((await invoke('runtime_status')).state, 'stopped');
    await page.getByRole('button', { name: '连接', exact: true }).click();
    await dialog.getByRole('button', { name: '下载并连接', exact: true }).click();
    let connected = false;
    for (let i = 0; i < 260; i++) {
      const status = await invoke('runtime_status');
      if (status.state === 'error') throw Error(status.message);
      if (status.state === 'running') {
        connected = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert(connected, 'Download/start failed: ' + (await page.locator('.toast').allTextContents()).join(' '));
    const current = JSON.parse(await invoke('current_config'));
    assert(
      current.route.rule_set.every((rule) => rule.path.startsWith('rules/') && !path.isAbsolute(rule.path)),
    );
    for (const name of filenames)
      assert((await readFile(path.join(root, name))).subarray(0, 3).toString() === 'SRS');
    const body = await new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port,
          path: `http://127.0.0.1:${targetPort}/portable-rules`,
          headers: { Host: `127.0.0.1:${targetPort}` },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => resolve(body));
        },
      );
      req.on('error', reject);
      req.setTimeout(5000, () => req.destroy(new Error('Portable profile request timed out')));
      req.end();
    });
    assert.equal(body, 'ANIBOX_LOOPBACK_OK');
    await invoke('stop_core');
    const unknown = JSON.stringify({ route: { rule_set: [{ type: 'local', tag: 'company-internal' }] } });
    const plan = await invoke('prepare_config_rules', { core: 'sing-box', config: unknown, download: false });
    assert.equal(plan.missing[0].source, null);
    await assert.rejects(
      invoke('prepare_config_rules', { core: 'sing-box', config: unknown, download: true }),
      /未找到默认公共来源/,
    );
    console.log(
      'PASS missing/undefined/legacy rules → download consent/cancel → public SRS validation → relative paths → real native profile transfer; unknown sources stay explicit',
    );
  } finally {
    await invoke('stop_core').catch(() => {});
    await invoke('save_data', { data: original });
    await page.reload();
    for (const [file, backup] of backups) {
      await unlink(file).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (backup) await rename(backup, file);
    }
  }
}
