#!/usr/bin/env node
/**
 * Kiểm nhanh "một lệnh chạy" (P10c phần B mục 4): BE phục vụ `web/dist` ở 8010.
 * Mở http://127.0.0.1:8010, xác nhận canvas 3D + bản đồ nạp + không lỗi console.
 *
 * Chạy:: cd sim3d/web && node ../tools/check_dist.mjs
 */
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = resolve(HERE, '..', 'web');
const URL = process.env.SIM3D_URL ?? 'http://127.0.0.1:8010';

const webRequire = createRequire(resolve(WEB_DIR, 'package.json'));
const { chromium } = webRequire('playwright');

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(`${error.name}: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.innerText.includes('Bãi pucpr'), undefined, {
    timeout: 90_000,
  });
  const canvases = await page.locator('canvas').count();
  const cars = await page.locator('.car-row').count();
  const text = await page.locator('body').innerText();
  console.log(`URL ${URL}`);
  console.log(`canvas: ${String(canvases)} · .car-row: ${String(cars)}`);
  console.log(`thấy "Bãi pucpr": ${String(text.includes('Bãi pucpr'))}`);
  console.log(`lỗi console/pageerror: ${String(errors.length)}`);
  for (const line of errors.slice(0, 5)) console.log(`  ${line}`);
  if (canvases === 0 || errors.length > 0) {
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}
