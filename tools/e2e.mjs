#!/usr/bin/env node
/**
 * E2E của web SIM3D (MEGAPLAN dòng P9, P9c mục 2).
 *
 * Chạy::
 *
 *     cd sim3d/web
 *     node ../tools/e2e.mjs                  # chạy hết
 *     node ../tools/e2e.mjs --skip-export    # bỏ bước xuất
 *     node ../tools/e2e.mjs --port 5200      # đổi cổng Vite
 *
 * Điều kiện: **BE phải đang chạy** (`cd sim3d/server && .venv/Scripts/python -m sim3d_server --root ../data`).
 * Script kiểm `/api/health` trước; BE không chạy thì dừng với lý do rõ ràng (không im lặng).
 *
 * Các bước (in PASS / FAIL / SKIP, thoát mã 1 nếu có FAIL):
 * 1. BE trả lời + UI Vite lên + trang nạp bản đồ.
 * 2. Tạo map 30 xe đỗ sẵn.
 * 3. Thêm 3 xe.
 * 4. Cho 1 xe rời đi.
 * 5. Lưu kịch bản.
 * 6. Mở lại kịch bản.
 * 7. Chế độ Quay (C2): đúng pixel, không UI trong khung, Esc thoát, 3 frame đánh dấu.
 * 8. Xuất video (chờ P7b ⇒ SKIP có lý do).
 * 9. Chụp `out/ui_env.png`.
 *
 * `playwright` là devDependency của `sim3d/web` (không cài global).
 */

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = resolve(HERE, '..', 'web');
const OUT_DIR = resolve(HERE, 'out');

/** Cổng BE mặc định (BE §1). */
const API_PORT = 8010;
/** Cổng Vite của e2e (khác `shot.mjs` để chạy song song được). */
const DEFAULT_UI_PORT = 5200;
/** Chờ cảnh sẵn sàng. */
const READY_TIMEOUT_MS = 90_000;
/** Số xe đỗ sẵn theo kịch bản e2e của MEGAPLAN. */
const PARKED = 30;
/** Số xe thêm thêm. */
const ADDED = 3;

/** Kết quả từng bước. */
const results = [];

function record(status, name, detail) {
  results.push({ status, name, detail });
  const label = status === 'PASS' ? 'PASS' : status === 'FAIL' ? 'FAIL' : 'SKIP';
  console.log(`[${label}] ${name}${detail === undefined ? '' : ` — ${detail}`}`);
}

async function loadPlaywright() {
  const webRequire = createRequire(resolve(WEB_DIR, 'package.json'));
  try {
    return webRequire('playwright');
  } catch (error) {
    throw new Error(
      'Không nạp được playwright từ sim3d/web. Chạy:\n' +
        '  cd sim3d/web && npm install -D playwright && npx playwright install chromium\n' +
        `Gốc lỗi: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseArgs(argv) {
  const args = { port: DEFAULT_UI_PORT, skipExport: false, keepServer: false, keepBrowser: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--port') {
      args.port = Number(argv[index + 1]);
      index += 1;
    } else if (arg === '--skip-export') {
      args.skipExport = true;
    } else if (arg === '--keep-server') {
      args.keepServer = true;
    } else if (arg === '--keep-browser') {
      args.keepBrowser = true;
    } else {
      throw new Error(`Tham số lạ: ${arg}`);
    }
  }
  return args;
}

/** Chờ một URL trả lời 2xx, trả body text. */
async function waitForUrl(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return await response.text();
      }
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
  }
  throw new Error(`Không chờ được ${url} sau ${timeoutMs} ms: ${String(last)}`);
}

/** Chạy `vite dev` cho UI. */
function startDevServer(port) {
  const isWindows = process.platform === 'win32';
  const child = spawn(
    isWindows ? 'npx.cmd' : 'npx',
    ['vite', '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    {
      cwd: WEB_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: isWindows,
      detached: !isWindows,
    },
  );
  const log = [];
  child.stdout.on('data', (chunk) => log.push(chunk.toString()));
  child.stderr.on('data', (chunk) => log.push(chunk.toString()));
  const stop = () => {
    if (child.exitCode !== null || child.killed) {
      return;
    }
    if (isWindows && child.pid !== undefined) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      return;
    }
    child.kill('SIGTERM');
  };
  return { child, stop, log };
}

/** Số xe đang hiện trên panel (badge cạnh tiêu đề "Xe"). */
async function readCarCount(page) {
  const badge = page
    .locator('section.panel-section')
    .filter({ hasText: 'Xe' })
    .locator('.badge')
    .first();
  const text = await badge.innerText();
  const value = Number.parseInt(text.trim(), 10);
  if (!Number.isFinite(value)) {
    throw new Error(`Không đọc được số xe từ badge "${text}"`);
  }
  return value;
}

/** Toàn bộ chữ trên thanh trạng thái + notice (để tìm thông báo). */
async function readStatusText(page) {
  return (await page.locator('body').innerText()).replace(/\s+/g, ' ');
}

/** Chờ tới khi `predicate` đúng (poll mỗi 200 ms). */
async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  throw new Error(`Hết ${String(timeoutMs)} ms chờ ${label}`);
}

/**
 * Chế độ Quay (C2, FE §2 dòng 17-21, P9d).
 *
 * Kiểm 4 điều spec đòi, bằng DOM thật chứ không phải ảnh:
 * 1. Canvas đúng pixel, **không co giãn**: `1cam` = 640×640, `2cam` = 800×640 (thuộc tính
 *    `width`/`height`) và CSS cũng đúng số đó (`getBoundingClientRect`).
 * 2. Không còn phần tử UI nào phủ lên khung hình: `elementsFromPoint` ở tâm và 4 góc phải
 *    trả `CANVAS` trước tiên (chỉ canvas + các div bọc, không button/panel/tooltip).
 * 3. Esc thoát về chế độ `dataset` (thấy lại panel).
 * 4. 3 frame trắng đánh dấu: bấm Play ⇒ hiện `.record-leader` in "1", rồi tự hết sau ~3
 *    frame và sim mới chạy. Có công tắc tắt.
 */
async function checkRecordMode(page) {
  const problems = [];
  const sizes = { '1cam': [640, 640], '2cam': [800, 640] };

  for (const [label, expected] of Object.entries(sizes)) {
    await page.getByRole('button', { name: label === '1cam' ? '1 cam' : '2 cam', exact: true }).click();
    await page.waitForTimeout(300);
    await page.getByRole('banner').getByRole('button', { name: 'Quay', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.app.record') !== null, undefined, {
      timeout: 30_000,
    });
    await page.waitForTimeout(1200);

    const measured = await page.evaluate(() => {
      const canvas = document.querySelector('.app.record canvas');
      if (!(canvas instanceof HTMLCanvasElement)) {
        return { error: 'không thấy canvas ở chế độ Quay' };
      }
      const rect = canvas.getBoundingClientRect();
      const points = [
        [rect.left + rect.width / 2, rect.top + rect.height / 2],
        [rect.left + 4, rect.top + 4],
        [rect.right - 4, rect.top + 4],
        [rect.left + 4, rect.bottom - 4],
        [rect.right - 4, rect.bottom - 4],
      ];
      const covering = points.map(([x, y]) => {
        const top = document.elementsFromPoint(x, y)[0];
        return top === undefined ? 'NONE' : top.tagName + '.' + top.className;
      });
      const interactive = [...document.querySelectorAll('.app.record button, .app.record input, .app.record .panel, .app.record .tooltip')]
        .filter((element) => {
          const box = element.getBoundingClientRect();
          // Nằm ngoài khung quay thì không dính vào hình.
          return !(box.right < rect.left || box.left > rect.right || box.bottom < rect.top || box.top > rect.bottom);
        })
        .map((element) => element.tagName + '.' + element.className);
      return {
        attr: [canvas.width, canvas.height],
        css: [Math.round(rect.width), Math.round(rect.height)],
        covering,
        insideFrame: interactive,
      };
    });

    if (measured.error !== undefined) {
      problems.push(`${label}: ${measured.error}`);
      await page.keyboard.press('Escape');
      continue;
    }
    const [wantW, wantH] = expected;
    if (measured.attr[0] !== wantW || measured.attr[1] !== wantH) {
      problems.push(`${label}: canvas ${measured.attr.join('×')}, cần ${wantW}×${wantH}`);
    }
    if (measured.css[0] !== wantW || measured.css[1] !== wantH) {
      problems.push(`${label}: CSS co giãn còn ${measured.css.join('×')}, cần đúng ${wantW}×${wantH}`);
    }
    const notCanvas = measured.covering.filter((name) => !name.startsWith('CANVAS'));
    if (notCanvas.length > 0) {
      problems.push(`${label}: phần tử phủ lên khung quay: ${notCanvas.join(', ')}`);
    }
    if (measured.insideFrame.length > 0) {
      problems.push(`${label}: UI nằm trong khung quay: ${measured.insideFrame.join(', ')}`);
    }

    if (label === '1cam') {
      // Ảnh bằng chứng cho REPORT.
      mkdirSync(OUT_DIR, { recursive: true });
      await page.screenshot({ path: resolve(OUT_DIR, 'record_mode.png') });
    }

    // Esc phải thoát về dataset (thấy lại panel).
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    const escaped = await page.evaluate(
      () => document.querySelector('.app.record') === null && document.querySelector('.panel') !== null,
    );
    if (!escaped) {
      problems.push(`${label}: Esc không thoát về chế độ thường`);
    }
  }

  // 3 frame trắng đánh dấu (C2).
  // "Về 0" nằm trên Timeline — Timeline bị ẩn ở chế độ Quay, nên phải về 0 TRƯỚC khi vào.
  const resetToZero = async () => {
    await page.getByRole('button', { name: 'Về 0' }).click();
    await page.waitForTimeout(300);
  };
  const enterRecord = async () => {
    await page.getByRole('banner').getByRole('button', { name: 'Quay', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.app.record') !== null, undefined, {
      timeout: 30_000,
    });
    await page.waitForTimeout(500);
  };

  await page.getByRole('button', { name: '1 cam', exact: true }).click();
  await page.waitForTimeout(200);
  await resetToZero();
  await enterRecord();

  const leaderToggle = page.locator('.record-toggle input[type="checkbox"]');
  if ((await leaderToggle.count()) === 0) {
    problems.push('không thấy công tắc "3 frame đồng bộ"');
  } else if (!(await leaderToggle.isChecked())) {
    await leaderToggle.check();
  }

  await page.keyboard.press(' ');
  let leaderSeen = false;
  try {
    await page.waitForFunction(() => document.querySelector('[data-testid="record-leader"]') !== null, undefined, {
      timeout: 5_000,
    });
    leaderSeen = true;
  } catch {
    leaderSeen = false;
  }
  if (!leaderSeen) {
    problems.push('bấm Play không thấy frame trắng đánh dấu');
  } else {
    const firstLabel = await page.locator('[data-testid="record-leader"]').innerText();
    if (firstLabel.trim() !== '1') {
      problems.push(`frame đánh dấu đầu in "${firstLabel.trim()}", cần "1"`);
    }
    // Chuỗi 3 frame ở 25 fps ≈ 120 ms; chờ nó tự hết rồi sim mới chạy.
    try {
      await page.waitForFunction(() => document.querySelector('[data-testid="record-leader"]') === null, undefined, {
        timeout: 10_000,
      });
    } catch {
      problems.push('frame đánh dấu không tự hết');
    }
    // Sau khi hết chuỗi, sim phải tự chạy (frame > 0) — chứng minh "rồi mới chạy từ frame 0".
    try {
      await page.waitForFunction(
        () => {
          const node = document.querySelector('[data-testid="record-state"]');
          return node !== null && Number(node.getAttribute('data-frame')) > 0;
        },
        undefined,
        { timeout: 15_000 },
      );
    } catch {
      problems.push('sau frame đánh dấu sim không tự chạy');
    }
  }

  // Tắt công tắc ⇒ bấm Play không hiện frame trắng nữa.
  if ((await leaderToggle.count()) > 0) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await resetToZero();
    await enterRecord();
    await leaderToggle.scrollIntoViewIfNeeded();
    if (await leaderToggle.isChecked()) {
      await leaderToggle.click({ force: true });
      await page.waitForTimeout(200);
    }
    if (await leaderToggle.isChecked()) {
      problems.push('không tắt được công tắc "3 frame đồng bộ"');
    }
    await page.keyboard.press(' ');
    let showedWhenOff = false;
    try {
      await page.waitForFunction(() => document.querySelector('[data-testid="record-leader"]') !== null, undefined, {
        timeout: 1_500,
      });
      showedWhenOff = true;
    } catch {
      showedWhenOff = false;
    }
    if (showedWhenOff) {
      problems.push('tắt công tắc mà vẫn hiện frame trắng');
    }
    await page.keyboard.press(' ');
    await page.waitForTimeout(200);
    if (!(await leaderToggle.isChecked())) {
      await leaderToggle.click({ force: true });
      await page.waitForTimeout(200);
    }
  }

  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  // Trả app về trạng thái sạch cho bước sau: dừng phát + về frame 0. Nếu để sim tiếp
  // tục chạy thì nó giành CPU với bước Xuất (đo được: 0,55× → 0,45× thời gian thực).
  if ((await page.getByRole('button', { name: 'Tạm dừng' }).count()) > 0) {
    await page.getByRole('button', { name: 'Tạm dừng' }).click();
    await page.waitForTimeout(200);
  }
  await resetToZero();

  if (problems.length === 0) {
    record(
      'PASS',
      'Chế độ quay (C2)',
      '1cam 640×640 · 2cam 800×640 đúng pixel · không UI trong khung · Esc thoát · 3 frame đánh dấu 1-2-3 rồi chạy',
    );
  } else {
    record('FAIL', 'Chế độ quay (C2)', problems.join(' | '));
  }
}

/**
 * Chạy sim tới frame `target` bằng ô "Tua tới frame" trên Timeline.
 *
 * Vì sao cần: form "Thêm xe" (P14a) sinh sự kiện ở frame tương lai, nên xe chỉ
 * xuất hiện khi sim chạy qua các frame đó. Không tua thì bộ đếm xe không đổi và test sẽ báo sai.
 */
async function seekToFrame(page, target) {
  const input = page.locator('label:has-text("Tua tới frame") input').first();
  await input.fill(String(target));
  await page.getByRole('button', { name: 'Tua', exact: true }).click();
  // `seekTo` chạy `stepFrames` đồng bộ nhưng React cần một nhịp để vẽ lại danh sách.
  await page.waitForTimeout(500);
}

async function deselectByClickingSky(page) {
  const canvas = page.locator('.viewport canvas').first();
  const box = await canvas.boundingBox();
  if (box === null) {
    throw new Error('Không lấy được kích thước canvas khung xem');
  }
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.06);
  await page.waitForTimeout(250);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(OUT_DIR, { recursive: true });
  const { chromium } = await loadPlaywright();

  // 1. BE phải chạy: kiểm trước, dừng với lý do rõ nếu không.
  try {
    const health = await waitForUrl(`http://127.0.0.1:${API_PORT}/api/health`, 5_000);
    record('PASS', 'BE đang chạy', health.replace(/\s+/g, ' ').trim().slice(0, 90));
  } catch (error) {
    record(
      'FAIL',
      'BE đang chạy',
      `Không thấy http://127.0.0.1:${API_PORT}/api/health — chạy ` +
        '`cd sim3d/server && .venv/Scripts/python -m sim3d_server --root ../data` trước. ' +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
    return;
  }

  const baseUrl = `http://127.0.0.1:${args.port}`;
  const server = startDevServer(args.port);
  let browser = null;
  try {
    await waitForUrl(`${baseUrl}/`, 60_000);
    record('PASS', 'UI Vite lên', baseUrl);

    browser = await chromium.launch({
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
    });
    const consoleErrors = [];
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
      }
    });
    page.on('pageerror', (error) => consoleErrors.push(`${error.name}: ${error.message}`));

    await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
    await waitUntil(
      async () => {
        const text = await page.locator('body').innerText();
        return text.includes('Bãi pucpr') && !text.includes('Đang tải bản đồ');
      },
      READY_TIMEOUT_MS,
      'trang nạp xong bản đồ',
    );
    record('PASS', 'Trang mở + nạp bản đồ', 'thấy “Bãi pucpr”');

    // 2. Tạo map 30 xe.
    await page.locator('label:has-text("Seed") input[type="number"]').first().fill('8811');
    await page
      .locator('label:has-text("Xe đỗ sẵn") input[type="number"]')
      .first()
      .fill(String(PARKED));
    await page.getByRole('button', { name: 'Tạo map' }).click();
    let afterMap = -1;
    try {
      await waitUntil(
        async () => {
          afterMap = await readCarCount(page);
          return afterMap === PARKED;
        },
        15_000,
        `${String(PARKED)} xe trên panel`,
      );
      record('PASS', `Tạo map ${String(PARKED)} xe`, `panel Xe = ${String(afterMap)}`);
    } catch (error) {
      record(
        'FAIL',
        `Tạo map ${String(PARKED)} xe`,
        `panel Xe = ${String(afterMap)}, cần ${String(PARKED)} — ${await readStatusText(page)}${
          error instanceof Error ? ` (${error.message})` : ''
        }`,
      );
    }

    // 3. Thêm 3 xe bằng **form mới** (P14a): điền số xe, bấm 1 lần.
    //
    // Form sinh sự kiện `add_car` ở frame **hiện tại** và cách nhau `giãn cách × 25` frame,
    // nên xe **chưa** xuất hiện ngay — phải chạy sim tới frame sau cùng mới đếm được.
    // Vì vậy bước này kiểm: (a) form có đủ trường P14a, (b) thêm 1 lần ra đúng N xe,
    // (c) bấm thêm 1 lần nữa vẫn thêm được (lỗi 4: "thêm 2 xe là hết").
    const addForm = page.locator('.add-car-form');
    let added = 0;
    let formReady = false;
    try {
      await addForm.waitFor({ state: 'visible', timeout: 15_000 });
      // Tìm theo **nhãn**, không theo vị trí: nếu ai đổi nhãn/đổi thứ tự trường thì test phải đỏ,
      // chứ không âm thầm chỉ kiểm được một phần (lỗi đã mắc khi dùng `nth()`).
      const fieldInput = (label) => addForm.locator(`label:has-text("${label}") input`).first();
      const countInput = fieldInput('Số xe');
      const speedInput = fieldInput('Tốc độ');
      const gapInput = fieldInput('Giãn cách');
      const startInput = fieldInput('Giây bắt đầu');
      const slotSelect = addForm.locator('label:has-text("Ô đích") select').first();
      const missing = [];
      if ((await countInput.count()) !== 1) missing.push('Số xe');
      if ((await speedInput.count()) !== 1) missing.push('Tốc độ');
      if ((await gapInput.count()) !== 1) missing.push('Giãn cách');
      if ((await startInput.count()) !== 1) missing.push('Giây bắt đầu');
      if ((await slotSelect.count()) !== 1) missing.push('Ô đích');
      formReady = missing.length === 0;
      if (!formReady) {
        throw new Error(`form thiếu trường: ${missing.join(', ')}`);
      }
      // Ô đích phải có tuỳ chọn "ngẫu nhiên".
      const slotOptions = await slotSelect.locator('option').allInnerTexts();
      if (!slotOptions.some((text) => text.trim() === 'ngẫu nhiên')) {
        throw new Error('ô đích thiếu tuỳ chọn "ngẫu nhiên"');
      }
      // Giãn cách mặc định phải là 2 s (BRIEF_P14).
      const gapValue = await gapInput.inputValue();
      if (Number.parseFloat(gapValue) !== 2) {
        throw new Error(`giãn cách mặc định phải là 2 s, nhận ${gapValue}`);
      }
      await countInput.fill(String(ADDED));
    } catch (error) {
      formReady = false;
      console.log(
        `  (form Thêm xe: ${error instanceof Error ? error.message : String(error)})`,
      );
    }

    if (!formReady) {
      record('FAIL', `Thêm ${String(ADDED)} xe`, `form Thêm xe không dùng được`);
    } else {
      // (b) bấm 1 lần với số xe = ADDED.
      const before = await readCarCount(page);
      await addForm.getByRole('button', { name: /Thêm/ }).click();
      // Sự kiện nằm ở frame hiện tại + ADDED lần giãn cách → chạy tới frame 300 để chắc chắn qua hết.
      await seekToFrame(page, 300);
      let afterBatch = before;
      try {
        await waitUntil(
          async () => {
            afterBatch = await readCarCount(page);
            return afterBatch >= before + ADDED;
          },
          15_000,
          `${String(ADDED)} xe xuất hiện sau khi chạy tới frame 300`,
        );
        added = afterBatch - before;
      } catch (error) {
        afterBatch = await readCarCount(page);
        added = afterBatch - before;
        console.log(
          `  (thêm ${String(ADDED)} xe: ${error instanceof Error ? error.message : String(error)})`,
        );
      }

      // (c) lỗi 4: bấm thêm 1 lần nữa, phải vẫn thêm được (không bị "hết ô"/"dùng lại ô cũ").
      const countInput = addForm.locator('input[type="number"]').first();
      await countInput.fill('1');
      const beforeSecond = await readCarCount(page);
      await addForm.getByRole('button', { name: /Thêm/ }).click();
      await seekToFrame(page, 700);
      let secondAdded = 0;
      try {
        await waitUntil(
          async () => {
            secondAdded = (await readCarCount(page)) - beforeSecond;
            return secondAdded >= 1;
          },
          15_000,
          'xe thứ 2 thêm được (lỗi 4)',
        );
      } catch (error) {
        secondAdded = (await readCarCount(page)) - beforeSecond;
        console.log(
          `  (thêm lần 2: ${error instanceof Error ? error.message : String(error)})`,
        );
      }

      if (added === ADDED && secondAdded >= 1) {
        record(
          'PASS',
          `Thêm ${String(ADDED)} xe`,
          `form mới: +${String(added)} xe 1 lần, rồi +${String(secondAdded)} xe lần 2 (lỗi 4 OK)`,
        );
      } else {
        record(
          'FAIL',
          `Thêm ${String(ADDED)} xe`,
          `lần 1 +${String(added)}/${String(ADDED)}, lần 2 +${String(secondAdded)} — ${await readStatusText(page)}`,
        );
      }
    }

    // 4. Cho 1 xe rời đi.
    // Xe rời đi còn chạy ra bãi (state `leaving_slot` → `driving_to_exit`) nên **không**
    // biến mất ngay khỏi danh sách; kiểm đúng dấu hiệu: thông báo "rời đi" + trạng thái xe
    // khác `parked`.
    await page.locator('.car-list button, .car-list li').first().click();
    await page.waitForTimeout(300);
    const selectedText = await readStatusText(page);
    await page.getByRole('button', { name: 'Xe rời đi' }).click();
    let leftOk = false;
    try {
      await waitUntil(
        async () => {
          const text = await readStatusText(page);
          return /rời đi ở frame/.test(text) || /leaving_slot|driving_to_exit/.test(text);
        },
        12_000,
        'thông báo xe rời đi',
      );
      leftOk = true;
    } catch {
      leftOk = false;
    }
    if (leftOk) {
      record('PASS', 'Cho 1 xe rời đi', 'có lệnh rời đi + xe chuyển trạng thái ra khỏi ô');
    } else {
      record(
        'FAIL',
        'Cho 1 xe rời đi',
        `không thấy dấu hiệu — trước đó: "${selectedText.slice(0, 80)}" — ${await readStatusText(page)}`,
      );
    }

    // 5. Lưu kịch bản.
    const scenarioName = `e2e-${String(Date.now())}`;
    await page.locator('label:has-text("Tên kịch bản") input').first().fill(scenarioName);
    await page.getByRole('button', { name: /^Lưu/ }).first().click();
    let savedOk = false;
    try {
      await waitUntil(
        async () => {
          const list = page.locator('.scenario-list');
          if ((await list.count()) === 0) {
            return false;
          }
          return (await list.innerText()).includes(scenarioName);
        },
        15_000,
        'kịch bản xuất hiện trong danh sách Đã lưu',
      );
      savedOk = true;
    } catch {
      savedOk = false;
    }
    if (savedOk) {
      record('PASS', 'Lưu kịch bản', scenarioName);
    } else {
      record('FAIL', 'Lưu kịch bản', `không thấy "${scenarioName}" — ${await readStatusText(page)}`);
    }

    // 6. Mở lại kịch bản: theo D9, mở là về frame 0 và **chạy lại nhật ký từ đầu**, nên
    // số xe trên panel là số xe đỗ sẵn ban đầu (chưa phát sự kiện nào).
    const row = page.locator('.scenario-row', { hasText: scenarioName });
    if ((await row.count()) === 0) {
      record('FAIL', 'Mở lại kịch bản', `không có dòng "${scenarioName}" để bấm`);
    } else {
      await row.first().click();
      let reopened = -1;
      let opened = false;
      try {
        await waitUntil(
          async () => {
            const text = await readStatusText(page);
            if (!/Đã mở kịch bản/.test(text)) {
              return false;
            }
            reopened = await readCarCount(page);
            return true;
          },
          15_000,
          'thông báo mở kịch bản',
        );
        opened = true;
      } catch {
        opened = false;
      }
      if (opened && reopened === PARKED) {
        record(
          'PASS',
          'Mở lại kịch bản',
          `${String(reopened)} xe đỗ sẵn ở frame 0 (đúng D9: chạy lại nhật ký từ đầu)`,
        );
      } else if (opened) {
        record(
          'FAIL',
          'Mở lại kịch bản',
          `${String(reopened)} xe, cần ${String(PARKED)} ở frame 0 — ${await readStatusText(page)}`,
        );
      } else {
        record('FAIL', 'Mở lại kịch bản', `không thấy thông báo mở — ${await readStatusText(page)}`);
      }
    }

    // 7. Chế độ Quay (C2, P9d): toàn màn hình, đúng pixel, không UI, Esc thoát,
    //     và 3 frame trắng đánh dấu trước khi chạy frame 0.
    await checkRecordMode(page);

    // 8. Xuất video (chờ P7b).
    if (args.skipExport) {
      record('SKIP', 'Xuất video', 'bỏ qua theo --skip-export');
    } else {
      const exportPanel = page.locator('section.panel-section').filter({ hasText: 'Xuất video' });
      const exportText = (await exportPanel.count()) === 0 ? '' : await exportPanel.innerText();
      const exportButton = page.getByRole('button', { name: /^Xuất$/ }).first();
      if ((await exportButton.count()) === 0) {
        record('SKIP', 'Xuất video', 'panel Xuất chưa có nút — P7b chưa xong');
      } else if ((await exportButton.isDisabled()) && exportText.includes('P7b')) {
        record('SKIP', 'Xuất video', 'panel Xuất đang chờ P7b (nút bị khoá, có ghi chú)');
      } else {
        await exportButton.click();
        let verifyText = null;
        try {
          // `setDefaultTimeout` không áp cho `waitForFunction` có timeout riêng, nên truyền
          // thẳng ở đây. Đo thật (máy này, Chromium headless + SwiftShader): xuất 3000 frame
          // mất 223–307 s tuỳ cảnh, tức 0,40–0,55× thời gian thực. Chừa 600 s (gấp đôi lần
          // chậm nhất đo được) để không flaky khi máy đang chạy việc khác — P10c từng trượt
          // đúng vì để 240 s mà máy bận, dừng ở 2745/3000 frame.
          await page.waitForFunction(() => /verify\s*(OK|FAIL)/i.test(document.body.innerText), undefined, {
            timeout: 600_000,
          });
          const text = await page.locator('body').innerText();
          verifyText = /verify\s*OK/i.test(text) ? 'OK' : 'FAIL';
        } catch (error) {
          verifyText = null;
          console.log(`  (không thấy verify: ${error instanceof Error ? error.message : String(error)})`);
        }
        if (verifyText === 'OK') {
          record('PASS', 'Xuất video', 'verify OK');
        } else if (verifyText === 'FAIL') {
          record('FAIL', 'Xuất video', 'verify FAIL — xem panel Xuất');
        } else {
          record('FAIL', 'Xuất video', `không thấy verify sau 600 s — ${await readStatusText(page)}`);
        }
      }
    }

    // 9. Chụp ảnh UI có panel môi trường.
    const envPanel = page.locator('.env-panel');
    if ((await envPanel.count()) === 0) {
      record('FAIL', 'Chụp ui_env.png', 'không thấy panel môi trường (.env-panel) trên trang');
    } else {
      const path = resolve(OUT_DIR, 'ui_env.png');
      await page.screenshot({ path, fullPage: false });
      record('PASS', 'Chụp ui_env.png', path);
    }

    if (consoleErrors.length > 0) {
      record('FAIL', 'Không có lỗi console', `${String(consoleErrors.length)} lỗi: ${consoleErrors[0]}`);
    } else {
      record('PASS', 'Không có lỗi console', '0 lỗi');
    }

    if (args.keepBrowser) {
      console.log('--keep-browser: giữ trình duyệt mở, nhấn Ctrl+C để thoát.');
      await new Promise(() => {});
    }
  } finally {
    if (browser !== null) {
      await browser.close().catch(() => undefined);
    }
    if (!args.keepServer) {
      server.stop();
    } else {
      console.log(`UI còn chạy ở ${baseUrl} (--keep-server)`);
    }
  }
}

function summarize() {
  const failed = results.filter((entry) => entry.status === 'FAIL');
  const skipped = results.filter((entry) => entry.status === 'SKIP');
  const passed = results.filter((entry) => entry.status === 'PASS');
  console.log('');
  console.log(
    `Tổng: ${String(passed.length)} PASS · ${String(failed.length)} FAIL · ${String(skipped.length)} SKIP`,
  );
  for (const entry of skipped) {
    console.log(`  SKIP ${entry.name}: ${entry.detail ?? ''}`);
  }
  for (const entry of failed) {
    console.log(`  FAIL ${entry.name}: ${entry.detail ?? ''}`);
  }
  return failed.length === 0 ? 0 : 1;
}

main()
  .then(() => {
    process.exit(summarize());
  })
  .catch((error) => {
    record('FAIL', 'Chạy e2e', error instanceof Error ? error.message : String(error));
    process.exit(summarize());
  });
