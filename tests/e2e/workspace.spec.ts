import { expect, test } from '@playwright/test';

const link =
  'vless://11111111-1111-4111-8111-111111111111@127.0.0.1:443?security=tls&sni=example.com#Test%20VLESS';

test('import, automatic engine choice, local persistence and honest preview connection', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('button', { name: '导入配置', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '导入节点', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: '导入内容' }).fill(link);
  await dialog.getByRole('button', { name: '导入', exact: true }).click();
  await expect(page.getByRole('button', { name: '选择 Test VLESS' })).toBeVisible();
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('需要 Windows 桌面版');
  await expect(page.getByText('已停止', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: '选择 Test VLESS' })).toBeVisible();
  await page.getByRole('textbox', { name: '搜索节点' }).fill('does-not-exist');
  await expect(page.getByText('无匹配节点')).toBeVisible();
  await page.getByRole('button', { name: '清除搜索' }).click();
  await page.screenshot({ path: '.local/screenshots/home-populated.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('native profile keeps unknown fields and survives reload; editor is bundled locally', async ({
  page,
}) => {
  const external: string[] = [];
  page.on('request', (request) => {
    if (!request.url().startsWith('http://127.0.0.1:1420') && !request.url().startsWith('data:'))
      external.push(request.url());
  });
  await page.goto('/');
  const source = '{\n "outbounds": [{"protocol":"freedom","future_field":42}],\n "inbounds": []\n}';
  await page.getByRole('button', { name: '导入节点', exact: true }).click();
  await page.getByRole('textbox', { name: '导入内容' }).fill(source);
  await page.getByRole('dialog').getByRole('button', { name: '导入', exact: true }).click();
  await page.getByRole('button', { name: '内核', exact: true }).click();
  await page.getByRole('button', { name: '导入的 xray 配置', exact: true }).click();
  await expect(page.locator('.monaco-editor').first()).toBeVisible();
  await expect(page.locator('.monaco-editor').first()).toContainText('future_field');
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await page.reload();
  const stored = await page.evaluate(
    () => JSON.parse(localStorage.getItem('anibox.workspace.v1')!).profiles[0].content,
  );
  expect(stored).toBe(source);
  expect(external).toEqual([]);
});

test('close asks repeatedly until remembered; background belongs to its page', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '关闭窗口', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '关闭窗口' })).toBeVisible();
  await page.getByRole('button', { name: '关闭弹窗' }).click();
  await page.getByRole('button', { name: '关闭窗口', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: /以后不再询问/ })).not.toBeChecked();
  await page.getByRole('button', { name: '关闭弹窗' }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('关闭窗口时').selectOption('tray');
  await page.getByLabel('卡片不透明度').fill('90');
  await page.reload();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByLabel('关闭窗口时')).toHaveValue('tray');
  await expect(page.getByLabel('卡片不透明度')).toHaveValue('90');
});

test('empty workspace layout at desktop minimum size', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '连接', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '连接', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/screenshots/home-empty.png', fullPage: true });
});

test('editing a native outbound updates its displayed endpoint and preserves extra fields', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '导入节点', exact: true }).click();
  await page.getByRole('textbox', { name: '导入内容' }).fill(link);
  await page.getByRole('dialog').getByRole('button', { name: '导入', exact: true }).click();
  await page.getByRole('button', { name: '节点', exact: true }).click();
  await page.getByRole('button', { name: 'Test VLESS', exact: false }).click();
  await page.getByRole('textbox', { name: '节点名称' }).fill('My edited node');
  const editor = page.locator('.monaco-editor textarea.inputarea');
  await editor.focus();
  await page.keyboard.press('ControlOrMeta+A');
  await editor.evaluate(
    (element, text) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', text);
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
    },
    JSON.stringify(
      {
        protocol: 'vless',
        settings: {
          vnext: [
            {
              address: '127.0.0.2',
              port: 8443,
              users: [{ id: '11111111-1111-4111-8111-111111111111', encryption: 'none' }],
            },
          ],
        },
        future_field: { keep: true },
      },
      null,
      2,
    ),
  );
  await page.getByRole('button', { name: '保存出站', exact: true }).click();
  await page.getByRole('button', { name: '主界面', exact: true }).click();
  await expect(page.getByRole('button', { name: '选择 My edited node' })).toContainText('127.0.0.2:8443');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('anibox.workspace.v1')!).nodes[0]);
  expect(saved.outbound.future_field).toEqual({ keep: true });
  expect(saved.locallyEdited).toBe(true);
});

for (const size of [
  { width: 900, height: 620 },
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
]) {
  test('pages fit the viewport at ' + size.width + 'x' + size.height, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto('/');
    for (const label of ['主界面', '订阅', '节点', '内核', '日志']) {
      await page.getByRole('button', { name: label, exact: true }).click();
      if (label === '内核') await expect(page.locator('.monaco-editor').first()).toBeVisible();
      const sizes = await page
        .locator('.page-content')
        .evaluate((element) => ({ scroll: element.scrollHeight, height: element.clientHeight }));
      expect(sizes.scroll).toBeLessThanOrEqual(sizes.height + 1);
      const box = await page.locator('.page-content').boundingBox();
      expect(box.y + box.height).toBeLessThanOrEqual(size.height);
      if (label === '内核' && size.width === 1024)
        await page.screenshot({ path: '.local/screenshots/v02-editor.png' });
    }
    await page.getByRole('button', { name: '主界面', exact: true }).click();
    await expect(page.getByRole('button', { name: '连接', exact: true })).toBeInViewport();
    await expect(page.getByText('让连接')).toHaveCount(0);
    if (size.width === 1024) await page.screenshot({ path: '.local/screenshots/v02-home.png' });
  });
}
