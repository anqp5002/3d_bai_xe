#!/usr/bin/env node
/**
 * E2E xuất K8 bằng UI thật (P7b, FE §7).
 *
 * Chạy::
 *
 *     cd sim3d/server && .venv/Scripts/python -m sim3d_server --root ../data
 *     node sim3d/tools/export_k8.mjs
 *
 * Script:
 * 1. Kiểm BE `GET /api/health` (bắt buộc đang chạy).
 * 2. Dựng `vite dev` nếu cổng chưa có server, mở app.
 * 3. Nạp K8 từ panel Kịch bản, chọn 2 cam + full/cam1/cam2, đặt tên `K8-kiem-thu`.
 * 4. Bấm Xuất, chờ `.verify` (WebCodecs+mediabunny; nếu không có H.264 thì UI tự
 *    chuyển PNG và ghi lý do — script sẽ in lý do và fail nếu verify không ok).
 * 5. In nội dung `sim3d/data/runs/<run_id>/verify.json`.
 *
 * Không cài gì global: `playwright` resolve từ `sim3d/web` (như `shot.mjs`).
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename } from 'node:path';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SIM3D_ROOT = resolve(HERE, '..');
const WEB_DIR = resolve(SIM3D_ROOT, 'web');
const RUNS_DIR = resolve(SIM3D_ROOT, 'data', 'runs');
const BE_URL = process.env.SIM3D_BE_URL ?? 'http://127.0.0.1:8010';
const DEFAULT_PORT = Number(process.env.SIM3D_PORT ?? 5199);
const DEFAULT_RUN_NAME = 'K8-kiem-thu';
const READY_TIMEOUT_MS = 90_000;
const EXPORT_TIMEOUT_MS = 10 * 60_000;

function parseArgs(argv) {
  const args = {
    port: DEFAULT_PORT,
    keepServer: false,
    scenario: null,
    scenarioName: null,
    name: DEFAULT_RUN_NAME,
    cams: '2cam',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--port') {
      args.port = Number(argv[index + 1]);
      index += 1;
    } else if (arg === '--scenario') {
      args.scenario = argv[index + 1];
      index += 1;
    } else if (arg === '--scenario-name') {
      args.scenarioName = argv[index + 1];
      index += 1;
    } else if (arg === '--name') {
      args.name = argv[index + 1];
      index += 1;
    } else if (arg === '--cams') {
      args.cams = argv[index + 1];
      index += 1;
    } else if (arg === '--keep-server') {
      args.keepServer = true;
    } else {
      throw new Error(`Tham số lạ: ${arg}`);
    }
  }
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) {
    throw new Error(`--port không hợp lệ: ${String(args.port)}`);
  }
  if (args.cams !== '1cam' && args.cams !== '2cam') {
    throw new Error(`--cams phải là 1cam hoặc 2cam, nhận ${String(args.cams)}`);
  }
  if (typeof args.name !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(args.name)) {
    throw new Error(`--name không hợp lệ: ${String(args.name)}`);
  }
  return args;
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

async function isUp(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isUp(url)) {
      return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
  }
  throw new Error(`Server không lên sau ${String(timeoutMs)} ms: ${url}`);
}

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

async function ensureBackend() {
  const health = await fetch(`${BE_URL}/api/health`, {
    signal: AbortSignal.timeout(5_000),
  })
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);
  if (health === null || health.ok !== true) {
    throw new Error(
      `BE chưa chạy/không khỏe ở ${BE_URL}/api/health.\n` +
        'Chạy: cd sim3d/server && .venv/Scripts/python -m sim3d_server --root ../data',
    );
  }
  return health;
}

async function loadK8(page, args) {
  await page.waitForFunction(
    () => document.body.innerText.includes('Bãi pucpr'),
    undefined,
    { timeout: READY_TIMEOUT_MS },
  );
  await page.waitForFunction(
    () => document.querySelectorAll('.car-row').length > 0,
    undefined,
    { timeout: READY_TIMEOUT_MS },
  );

  const scenarioPanel = page.locator('.bottom-grid .panel-section').first();
  const exportPanel = page.locator('.bottom-grid .panel-section').nth(1);

  // Số frame và số xe **lấy từ kịch bản**, không hằng số: trước đây script chỉ dùng được cho K8
  // (500 frame, 30 xe) nên `--scenario` với kịch bản khác (ví dụ đêm mưa 3000 frame, 48 xe đỗ)
  // chờ mãi ở `/ 500` rồi timeout. Đọc từ file khi có `--scenario`, còn lại giữ mặc định K8.
  let expectedFrames = 500;
  let expectedCars = 30;
  if (args.scenario !== null) {
    // K8-e8-grain: mở kịch bản đã lưu (có env/noise tuỳ biến) thay vì mẫu gốc.
    const scenario = JSON.parse(readFileSync(args.scenario, 'utf8'));
    if (!Number.isInteger(scenario.duration_frames) || scenario.duration_frames <= 0) {
      throw new Error(`${args.scenario}: duration_frames không hợp lệ`);
    }
    expectedFrames = scenario.duration_frames;
    // `placement` là danh sách chi tiết của `n_parked` (cùng số xe), nên chỉ lấy một trong hai.
    // **Không** cộng sự kiện `add_car`: xe thêm sau được tạo ở frame của sự kiện, nên ngay sau khi mở
    // kịch bản (frame 0) panel chỉ có xe đỗ sẵn. Cộng vào sẽ chờ mãi (gặp thực tế: kịch bản
    // đêm mưa 48 xe đỗ + 11 `add_car` ⇒ chờ 59 trong khi panel có 48).
    const parked = Number(scenario.initial?.n_parked ?? 0);
    const placement = Array.isArray(scenario.initial?.placement) ? scenario.initial.placement.length : 0;
    expectedCars = Math.max(parked, placement);
    // UI mở kịch bản theo **tên** trong danh sách "Đã lưu", không có ô nhập đường dẫn.
    // `--scenario` nhận đường dẫn file; tên trên BE là basename không đuôi `.sim3d.json`.
    const scenarioName =
      args.scenarioName ?? basename(args.scenario).replace(/\.sim3d\.json$/, '');
    const row = scenarioPanel.locator('.scenario-row', { hasText: scenarioName }).first();
    if ((await row.count()) === 0) {
      throw new Error(
        `Không thấy kịch bản "${scenarioName}" trong danh sách Đã lưu của UI`,
      );
    }
    await row.click();
  } else {
    await scenarioPanel.locator('select').selectOption('K8');
    await scenarioPanel.getByRole('button', { name: 'Nạp mẫu' }).click();
  }
  await page.waitForFunction(
    (frames) => document.querySelector('.timeline-clock')?.textContent?.includes(`/ ${String(frames)}`),
    expectedFrames,
    { timeout: READY_TIMEOUT_MS },
  );
  await page.waitForFunction(
    (cars) => document.querySelectorAll('.car-row').length === cars,
    expectedCars,
    { timeout: READY_TIMEOUT_MS },
  );

  await page
    .getByRole('button', { name: args.cams === '1cam' ? '1 cam' : '2 cam', exact: true })
    .click();
  await page.waitForTimeout(500);
  for (const checkbox of await exportPanel.locator('input[type="checkbox"]').all()) {
    if (await checkbox.isDisabled()) {
      continue;
    }
    if (!(await checkbox.isChecked())) {
      await checkbox.check();
    }
  }

  await exportPanel.locator('input[type="text"]').fill(args.name);
  const exportButton = exportPanel.getByRole('button', { name: 'Xuất', exact: true });
  await page.waitForFunction(
    () => {
      const panels = [...document.querySelectorAll('.bottom-grid .panel-section')];
      const panel = panels[1];
      const button = panel
        ? [...panel.querySelectorAll('button')].find((item) => item.textContent === 'Xuất')
        : null;
      return button instanceof HTMLButtonElement && !button.disabled;
    },
    undefined,
    { timeout: READY_TIMEOUT_MS },
  );
  await exportButton.click();
  return exportPanel;
}

function newestRunId(runName) {
  if (!existsSync(RUNS_DIR)) {
    return null;
  }
  const entries = readdirSync(RUNS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.includes(runName))
    .map((entry) => entry.name)
    .sort();
  return entries.at(-1) ?? null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const health = await ensureBackend();
  console.log(
    `BE ${BE_URL}: ok, version ${String(health.version)}, ffmpeg ${health.ffmpeg ? 'có' : 'không'}`,
  );

  const baseUrl = `http://127.0.0.1:${String(args.port)}`;
  const running = await isUp(`${baseUrl}/`);
  const server = running ? null : startDevServer(args.port);
  if (server !== null) {
    await waitForServer(`${baseUrl}/`);
  } else {
    console.log(`Dùng Vite dev sẵn có ở ${baseUrl}`);
  }

  const { chromium } = await loadPlaywright();
  let browser = null;
  try {
    browser = await chromium.launch({
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--disable-lcd-text',
      ],
    });
    const page = await browser.newPage({
      viewport: { width: 1600, height: 1000 },
      deviceScaleFactor: 1,
    });
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(`${error.name}: ${error.message}`));

    await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
    const exportPanel = await loadK8(page, args);
    const started = Date.now();

    await page.waitForFunction(
      () => {
        const panels = [...document.querySelectorAll('.bottom-grid .panel-section')];
        const panel = panels[1];
        if (!panel) {
          return false;
        }
        return panel.querySelector('.verify') !== null || panel.querySelector('.error') !== null;
      },
      undefined,
      { timeout: EXPORT_TIMEOUT_MS },
    );

    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    const verifyElement = exportPanel.locator('.verify');
    const verifyCount = await verifyElement.count();
    const panelText = await exportPanel.innerText();
    if (verifyCount === 0) {
      throw new Error(`Xuất lỗi (sau ${elapsed} s):\n${panelText}`);
    }
    const verifyClass = await verifyElement.getAttribute('class');
    if (!verifyClass?.includes('ok')) {
      throw new Error(`verify không ok:\n${panelText}`);
    }

    const runId = newestRunId(args.name);
    if (runId === null) {
      throw new Error(`Không thấy thư mục run ${args.name} trong ${RUNS_DIR}`);
    }
    const verifyPath = resolve(RUNS_DIR, runId, 'verify.json');
    if (!existsSync(verifyPath)) {
      throw new Error(`Không thấy ${verifyPath}`);
    }
    const verify = JSON.parse(readFileSync(verifyPath, 'utf8'));
    console.log(`\nXuất xong sau ${elapsed} s · run ${runId}`);
    console.log(`Thư mục: ${resolve(RUNS_DIR, runId)}`);
    console.log('verify.json:');
    console.log(JSON.stringify(verify, null, 2));

    if (pageErrors.length > 0) {
      console.log('PAGE_ERRORS:', JSON.stringify(pageErrors.slice(0, 10)));
    }
    if (verify.ok !== true) {
      process.exitCode = 1;
    }
  } finally {
    if (browser !== null) {
      await browser.close();
    }
    if (server !== null && !args.keepServer) {
      server.stop();
    } else if (server !== null) {
      console.log(`Dev server còn chạy ở ${baseUrl} (--keep-server)`);
    }
  }
}

main().catch((error) => {
  console.error(`export_k8.mjs lỗi: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
