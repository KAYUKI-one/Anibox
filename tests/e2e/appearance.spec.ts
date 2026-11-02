import { expect, test } from '@playwright/test';

test('rounded frame, usable glass, live preview and proportional focus crop', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1600;
    canvas.height = 500;
    const ctx = canvas.getContext('2d')!;
    const gradient = ctx.createLinearGradient(0, 0, 1600, 500);
    gradient.addColorStop(0, '#183a36');
    gradient.addColorStop(0.5, '#a8c77d');
    gradient.addColorStop(1, '#e4f6bc');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 1600, 500);
    for (let x = 1150; x < 1450; x += 15)
      for (let y = 80; y < 400; y += 15) {
        ctx.fillStyle = (x + y) % 30 ? '#c45d5d' : '#f7e4da';
        ctx.fillRect(x, y, 15, 15);
      }
    const data = JSON.parse(localStorage.getItem('anibox.workspace.v1')!);
    data.settings.appearanceVersion = 2;
    data.settings.appearance.home = {
      image: canvas.toDataURL('image/jpeg'),
      opacity: 28,
      blur: 0,
      focusMode: 'auto',
    };
    localStorage.setItem('anibox.workspace.v1', JSON.stringify(data));
  });
  await page.reload();
  const image = page.locator('.main-panel > .page-background img');
  await expect(image).toBeVisible();
  await expect.poll(async () => Number(await image.getAttribute('data-focus-x'))).toBeGreaterThan(0.65);
  expect(await image.evaluate((el) => getComputedStyle(el).objectFit)).toBe('cover');
  expect(await page.locator('.app-shell').evaluate((el) => getComputedStyle(el).borderRadius)).toBe('32px');
  expect(await page.locator('.proxy-panel').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
    'rgba(255, 255, 255, 0.28)',
  );
  expect(await page.locator('.proxy-panel').evaluate((el) => getComputedStyle(el).backdropFilter)).toBe(
    'blur(5px)',
  );
  expect(await page.locator('.connection-panel').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
    'rgba(255, 255, 255, 0.72)',
  );
  await page.screenshot({ path: '.local/screenshots/glass-28.png' });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByLabel('背景与卡片预览')).toBeVisible();
  await page.getByLabel('卡片不透明度').fill('54');
  await expect(page.locator('.preview-sample')).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.54)');
  await page.getByLabel('背景对焦').selectOption('manual');
  await page.getByLabel('水平焦点').fill('10');
  await expect(page.locator('.appearance-preview img')).toHaveAttribute('data-focus-x', '0.100');
  await page.getByLabel('背景对焦').selectOption('auto');
  await page.getByRole('button', { name: '主界面', exact: true }).click();
  await expect(page.locator('.proxy-panel')).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.54)');
  await page.screenshot({ path: '.local/screenshots/glass-54.png' });
  await page.setViewportSize({ width: 900, height: 620 });
  await expect(image).toBeVisible();
  await expect.poll(async () => Number(await image.getAttribute('data-focus-x'))).toBeGreaterThan(0.65);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
