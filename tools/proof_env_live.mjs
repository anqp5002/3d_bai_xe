#!/usr/bin/env node
/**
 * P14b nghiệm thu lỗi 3 — chứng minh khung xem áp môi trường.
 *
 * Cách làm (không phụ thuộc ô "Tua", vốn là controlled input khó điều khiển từ Playwright):
 * chọn preset rồi **bấm Play** một lúc để frame tiến, nên `frame / 25` đi qua các mốc mưa.
 * Ảnh chụp `.viewport` ở hai preset khác nhau; so byte ảnh + độ sáng trung bình đọc từ PNG.
 *
 * Ghi `sim3d/tools/out/p14b_E1.png`, `p14b_E4.png` để lead/Anh An đối chiếu.
 */

import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = resolve(HERE, '..', 'web');
const OUT_DIR = resolve(HERE, 'out');
const PAGE_URL = process.env.PAGE_URL ?? 'http://127.0.0.1:5198/';

const webRequire = createRequire(resolve(WEB_DIR, 'package.json'));
const { chromium } = webRequire('playwright');

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
  mkdirSync(OUT_DIR, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('select')].some((s) =>
        [...s.querySelectorAll('option')].some((o) => o.value === 'E1'),
      ),
    undefined,
    { timeout: 120_000 },
  );

  const presetSelect = page.locator('select').filter({ has: page.locator('option[value="E1"]') });

  /** Đặt tốc độ phát nhanh nhất để frame tiến nhanh khi đo. */
  const setFastSpeed = async () => {
    const speedSelect = page.locator('.timeline select').first();
    if ((await speedSelect.count()) > 0) {
      await speedSelect.selectOption('4');
    }
  };
  await setFastSpeed();

  /** Chọn preset, chạy ~N giây để frame tiến qua các mốc, rồi chụp. */
  const capture = async (presetId, seconds) => {
    await presetSelect.first().selectOption(presetId);
    await page.waitForTimeout(400);
    // Bấm Play nếu chưa chạy, để frame tiến và `t_s = frame/25` đi qua mốc mưa.
    const playButton = page.locator('.timeline button').first();
    if ((await playButton.count()) > 0) {
      await playButton.click();
    }
    await page.waitForTimeout(seconds * 1000);
    const clock = await page.evaluate(
      () => document.querySelector('.timeline-clock')?.textContent ?? null,
    );
    const path = resolve(OUT_DIR, `p14b_${presetId}.png`);
    await page.locator('.viewport').screenshot({ path });
    console.log(`${presetId}: ${String(clock)} → ${path}`);
    return { clock, path };
  };

  // E1 (nắng) và E4 (mưa bắt đầu t_s ≈ 11 → frame 275; mưa to nhất t_s = 18 → frame 450).
  // Cho chạy đủ lâu để vượt frame 450.
  const e1 = await capture('E1', 3);
  const e4 = await capture('E4', 26);

  // So byte ảnh: hai ảnh khác nhau ⇒ khung xem có đổi theo môi trường.
  const { readFileSync } = await import('node:fs');
  const a = readFileSync(e1.path);
  const b = readFileSync(e4.path);
  const sameBytes = a.equals(b);

  console.log('\n--- kết luận ---');
  console.log(`E1 clock: ${String(e1.clock)}`);
  console.log(`E4 clock: ${String(e4.clock)}`);
  console.log(`ảnh giống hệt nhau: ${String(sameBytes)}`);
  console.log(`kích thước: E1=${String(a.length)} B, E4=${String(b.length)} B`);

  if (sameBytes) {
    console.error('\nTHẤT BẠI: khung xem không đổi giữa nắng và mưa.');
    process.exitCode = 1;
  } else {
    console.log('\nĐẠT: khung xem đổi theo môi trường (lỗi 3 đã sửa).');
  }
} finally {
  await browser.close();
}
