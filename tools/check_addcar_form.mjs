/**
 * Kiểm form "Thêm xe" (P14a) trên app thật (BRIEF_P14 "lead tự mở web và thử 3 thao tác").
 *
 * Chạy: cd sim3d/web && node ../tools/check_addcar_form.mjs
 * Cần BE đang chạy ở :8010.
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = resolve(HERE, '..', 'web');
const OUT_DIR = resolve(HERE, 'out');
const PORT = 5191;
const BE = 'http://127.0.0.1:8010';


/** Chạy sim tới frame `target` bằng ô "Tua tới frame" trên Timeline. */
async function seekTo(page, target) {
  const input = page.locator('label:has-text("Tua tới frame") input').first();
  await input.fill(String(target));
  await page.getByRole('button', { name: 'Tua' }).click();
  await page.waitForTimeout(900);
}

const { chromium } = createRequire(resolve(WEB_DIR, 'package.json'))('playwright');

async function up(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
}

if (!(await up(`${BE}/api/health`))) {
  console.error(`BE chưa chạy ở ${BE}. Chạy: cd sim3d/server && .venv/Scripts/python -m sim3d_server --root ../data`);
  process.exit(1);
}

const server = spawn('npx.cmd', ['vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
  cwd: WEB_DIR,
  shell: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((r) => setTimeout(r, 8000));

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
let failures = 0;
const record = (ok, name, detail) => {
  if (!ok) failures += 1;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
};

try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.innerText.includes('Bãi pucpr'), undefined, { timeout: 90000 });

  // Tạo map trống (0 xe đỗ sẵn) để có 100 ô trống.
  await page.locator('label:has-text("Xe đỗ sẵn") input[type="number"]').first().fill('0');
  await page.getByRole('button', { name: 'Tạo map' }).click();
  await page.waitForTimeout(1200);

  const form = page.locator('.add-car-form');
  record((await form.count()) === 1, 'Có form "Thêm xe"', '');

  // --- Thao tác 1: thêm 3 xe một lần ---
  const countInput = form.locator('input[type="number"]').first();
  await countInput.fill('3');
  await form.getByRole('button', { name: /Thêm/ }).click();
  await page.waitForTimeout(800);
  // Sự kiện được sinh ở frame hiện tại, +50, +100 ⇒ phải chạy sim tới frame sau cùng mới thấy đủ xe.
  await seekTo(page, 220);
  const afterBatch = await page.locator('.car-row').count();
  record(afterBatch >= 3, 'Thêm 3 xe một lần', `panel Xe = ${String(afterBatch)}`);

  const notice = await page.locator('.badge').first().innerText().catch(() => '?');
  record(true, 'Badge xe', String(notice));

  // --- Thao tác 2: bấm "Thêm" 10 lần liên tiếp (lỗi 4) ---
  await countInput.fill('1');
  const before = await page.locator('.car-row').count();
  let clickErrors = 0;
  for (let index = 0; index < 10; index += 1) {
    const button = form.getByRole('button', { name: /Thêm/ });
    if (await button.isDisabled()) break;
    await button.click();
    await page.waitForTimeout(120);
    const err = await page.locator('.error').count();
    if (err > 0) clickErrors += 1;
  }
  await seekTo(page, 900);
  const afterClicks = await page.locator('.car-row').count();
  record(
    afterClicks - before === 10,
    'Bấm "Thêm" 10 lần ⇒ thêm 10 xe (lỗi 4 đã sửa)',
    `+${String(afterClicks - before)} xe, ${String(clickErrors)} lần có lỗi`,
  );

  // --- Thao tác 3: chọn ô đích qua dropdown ---
  const select = form.locator('select').first();
  const options = await select.locator('option').allInnerTexts();
  const firstSlot = options.find((text) => /^S\d{3}/.test(text.trim()));
  record(firstSlot !== undefined, 'Dropdown ô đích có mã ô', `ví dụ: ${firstSlot ?? '?'}`);
  if (firstSlot !== undefined) {
    await select.selectOption({ label: firstSlot });
    await form.getByRole('button', { name: /Thêm/ }).click();
    await page.waitForTimeout(600);
    const text = await page.locator('body').innerText();
    record(text.includes('Đã thêm 1 xe'), 'Chọn ô cụ thể rồi thêm', firstSlot.slice(0, 4));
  }

  mkdirSync(OUT_DIR, { recursive: true });
  await page.screenshot({ path: resolve(OUT_DIR, 'addcar_form.png') });
  console.log(`Ảnh: ${resolve(OUT_DIR, 'addcar_form.png')}`);

  record(errors.length === 0, 'Không lỗi console', `${String(errors.length)} lỗi`);
  if (errors.length > 0) console.log(errors.slice(0, 3).join('\n'));
} finally {
  await browser.close();
  spawn('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
}

console.log(failures === 0 ? '\nTẤT CẢ ĐẠT' : `\n${String(failures)} FAIL`);
process.exit(failures === 0 ? 0 : 1);
