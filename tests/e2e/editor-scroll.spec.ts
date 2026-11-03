import { expect, test } from '@playwright/test';

test('long nested JSON scrolls without a duplicate sticky code layer', async ({ page }) => {
  await page.goto('/');
  const config = JSON.stringify(
    {
      routing: {
        rules: Array.from({ length: 180 }, (_, i) => ({
          type: 'field',
          domain: [`domain:fixture-${i}.test`],
          outboundTag: 'direct',
        })),
      },
      outbounds: [{ protocol: 'freedom', tag: 'direct' }],
    },
    null,
    2,
  );
  await page.getByRole('button', { name: '导入节点', exact: true }).click();
  await page.getByRole('textbox', { name: '导入内容' }).fill(config);
  await page.getByRole('dialog').getByRole('button', { name: '导入', exact: true }).click();
  await page.getByRole('button', { name: '内核', exact: true }).click();
  await page.getByRole('button', { name: '导入的 xray 配置', exact: true }).click();
  const editor = page.locator('.code-container .monaco-editor').first();
  await expect(editor).toBeVisible();
  await editor.locator('textarea.inputarea').focus();
  await page.keyboard.press('Control+End');
  await expect(editor.locator('.view-lines')).toContainText('freedom');
  await expect(editor.locator('.sticky-widget')).toBeHidden();
  await page.screenshot({ path: '.local/screenshots/editor-scroll.png' });
  await page.getByRole('button', { name: '日志', exact: true }).click();
  await page.getByLabel('日志来源').selectOption('core');
  await expect(page.getByLabel('内核日志')).toContainText('无内核输出');
});
