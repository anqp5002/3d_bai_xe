#!/usr/bin/env node
/**
 * P14b — đo FPS khung xem live theo preset môi trường (bản gọn, tự chứa).
 *
 * Chạy::
 *
 *     node sim3d/tools/fps_live.mjs
 *
 * Cần BE ở :8010 và Vite ở :5198 (script KHÔNG tự spawn để tránh treo).
 * Đo bằng cách đếm khung `requestAnimationFrame` trong 2 giây cho mỗi preset.
 */

import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = resolve(HERE, '..', 'web');
const BE_URL = process.env.SIM3D_BE_URL ?? 'http://127.0.0.1:8010';
const PAGE_URL = process.env.PAGE_URL ?? 'http://127.0.0.1:5198/';
const DURATION_MS = Number(process.env.FPS_MS ?? 2000);

const PRESETS = [
  { id: 'E1', label: 'E1 — trưa nắng (sạch)' },
  { id: 'E2', label: 'E2 — ngày nắng' },
  { id: 'E3', label: 'E3 — mây nặng' },
  { id: 'E4', label: 'E4 — mưa chiều' },
  { id: 'E5', label: 'E5 — chạng vạng' },
  { id: 'E6', label: 'E6 — đêm' },
];

async function healthOk() {
  try {
    const response = await fetch(`${BE_URL}/api/health`, { signal: AbortSignal.timeout(4000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function pageOk(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await healthOk())) {
    console.error(`BE chưa chạy ở ${BE_URL}. Chạy: cd sim3d/server && .venv/Scripts/python -m sim3d_server --root ../data`);
    process.exitCode = 1;
    return;
  }
  if (!(await pageOk(PAGE_URL))) {
    console.error(`Vite chưa chạy ở ${PAGE_URL}. Chạy: cd sim3d/web && npx vite --port 5198 --strictPort`);
    process.exitCode = 1;
    return;
  }

  const webRequire = createRequire(resolve(WEB_DIR, 'package.json'));
  const { chromium } = webRequire('playwright');
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('select')].some((select) =>
          [...select.querySelectorAll('option')].some((option) => option.value === 'E1'),
        ),
      undefined,
      { timeout: 120_000 },
    );

    const rows = [];
    for (const preset of PRESETS) {
      const changed = await page.evaluate((presetId) => {
        for (const select of document.querySelectorAll('select')) {
          const has = [...select.querySelectorAll('option')].some(
            (option) => option.value === presetId,
          );
          if (!has) continue;
          select.value = presetId;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
        return false;
      }, preset.id);
      if (!changed) {
        rows.push({ ...preset, ok: false });
        continue;
      }
      await page.waitForTimeout(800);
      const stats = await page.evaluate(async (durationMs) => {
        let frames = 0;
        const start = performance.now();
        await new Promise((done) => {
          const tick = (now) => {
            frames += 1;
            if (now - start >= durationMs) {
              done();
              return;
            }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
        const elapsed = performance.now() - start;
        return { frames, elapsedMs: elapsed, fps: (frames / elapsed) * 1000 };
      }, DURATION_MS);
      rows.push({ ...preset, ok: true, ...stats });
    }

    console.log(`\nFPS khung xem live — mỗi preset đo ${String(DURATION_MS)} ms\n`);
    console.log('preset                          khung   fps');
    console.log('─'.repeat(46));
    for (const row of rows) {
      if (row.ok === false) {
        console.log(`${row.label.padEnd(30)}  (không đổi được preset)`);
        continue;
      }
      console.log(
        `${row.label.padEnd(30)} ${String(row.frames).padStart(6)} ${row.fps.toFixed(1).padStart(5)}`,
      );
    }
    const measured = rows.filter((row) => row.ok !== false);
    if (measured.length > 0) {
      const worst = measured.reduce((min, row) => (row.fps < min.fps ? row : min));
      const base = measured[0];
      console.log(
        `\nThấp nhất: ${worst.label} — ${worst.fps.toFixed(1)} fps` +
          ` (nền ${base.label}: ${base.fps.toFixed(1)} fps, giảm ${(100 * (1 - worst.fps / base.fps)).toFixed(1)} %)`,
      );
      console.log(worst.fps < 20 ? '⇒ DƯỚI 20 fps: cần giảm tải' : '⇒ trên ngưỡng 20 fps');
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`fps_live.mjs lỗi: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
