#!/usr/bin/env node
/**
 * E2E xuất một kịch bản mẫu (K1…K8) bằng UI thật (P10b, tổng quát hoá `export_k8.mjs`).
 *
 * Chạy::
 *
 *     cd sim3d/server && .venv/Scripts/python -m sim3d_server --root ../data
 *     node sim3d/tools/export_template.mjs --template K2 --mode 2cam --name K2-kiem-thu
 *     node sim3d/tools/export_template.mjs --template K6 --mode 2cam --name K6-kiem-thu
 *
 * Khác `export_k8.mjs` ở chỗ **không hard-code** K8/500 frame/30 xe: đọc thông số thật của
 * template từ `data/templates/<K>.sim3d.json` (số xe đỗ sẵn, số frame) rồi chờ đúng các mốc
 * đó trước khi bấm Xuất. Nhờ vậy dùng được cho K2 (3000 frame, 0 xe đỗ sẵn) và K6 (3000 frame,
 * env E8 đêm mưa).
 *
 * Script:
 * 1. Kiểm BE `GET /api/health` (bắt buộc đang chạy).
 * 2. Dựng `vite dev` nếu cổng chưa có server, mở app.
 * 3. Nạp template từ panel Kịch bản, chọn số cam + full/cam1/cam2, đặt tên.
 * 4. Bấm Xuất, chờ `.verify` (WebCodecs + mediabunny; nếu không có H.264 thì UI tự chuyển PNG
 *    và ghi lý do — script in lý do và fail nếu verify không ok).
 * 5. In nội dung `sim3d/data/runs/<run_id>/verify.json`.
 *
 * Không cài gì global: `playwright` resolve từ `sim3d/web` (như `shot.mjs`).
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SIM3D_ROOT = resolve(HERE, '..');
const WEB_DIR = resolve(SIM3D_ROOT, 'web');
const RUNS_DIR = resolve(SIM3D_ROOT, 'data', 'runs');
const TEMPLATES_DIR = resolve(SIM3D_ROOT, 'data', 'templates');
const BE_URL = process.env.SIM3D_BE_URL ?? 'http://127.0.0.1:8010';
const DEFAULT_PORT = Number(process.env.SIM3D_PORT ?? 5199);
const READY_TIMEOUT_MS = 90_000;
/** Cấu hình Chromium riêng cho mỗi lần xuất (xoá đi xoá lại được). */
const TMP_DIR = resolve(tmpdir(), 'sim3d-export');
/**
 * K5 = 6000 frame ≈ 240 s video; ở ~0,35–0,55× thời gian thực ⇒ 250–700 s. Chừa 20 phút cho
 * máy bận, vẫn dưới mốc "quá 15 phút thì báo" của TASK (báo = ghi số đo, không phải fail).
 */
const EXPORT_TIMEOUT_MS = 20 * 60_000;

/** Cổng TCP trống, để Chromium mở remote debugging mà không đụng cổng khác. */
function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.on('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        rejectPort(new Error('không lấy được cổng trống'));
        return;
      }
      const { port } = address;
      server.close(() => resolvePort(port));
    });
  });
}

/** Mã template hợp lệ (K1…K8). */
const TEMPLATE_IDS = ['K1', 'K2', 'K3', 'K4', 'K5', 'K6', 'K7', 'K8'];

function parseArgs(argv) {
  const args = {
    port: DEFAULT_PORT,
    keepServer: false,
    template: 'K8',
    name: null,
    cams: '2cam',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--port') {
      args.port = Number(argv[index + 1]);
      index += 1;
    } else if (arg === '--template') {
      args.template = argv[index + 1];
      index += 1;
    } else if (arg === '--name') {
      args.name = argv[index + 1];
      index += 1;
    } else if (arg === '--cams' || arg === '--mode') {
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
  if (!TEMPLATE_IDS.includes(args.template)) {
    throw new Error(`--template phải là ${TEMPLATE_IDS.join('|')}, nhận ${String(args.template)}`);
  }
  if (args.cams !== '1cam' && args.cams !== '2cam') {
    throw new Error(`--cams/--mode phải là 1cam hoặc 2cam, nhận ${String(args.cams)}`);
  }
  if (args.name === null) {
    args.name = `${args.template}-${args.cams}`;
  }
  if (typeof args.name !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(args.name)) {
    throw new Error(`--name không hợp lệ: ${String(args.name)}`);
  }
  return args;
}

/**
 * Đọc thông số thật của template để biết phải chờ bao nhiêu frame / bao nhiêu xe.
 * **Không** hard-code: K8 có 30 xe / 500 frame, K2 và K6 có 0 xe / 3000 frame.
 */
function templateInfo(templateId) {
  const path = resolve(TEMPLATES_DIR, `${templateId}.sim3d.json`);
  if (!existsSync(path)) {
    throw new Error(
      `Không thấy ${path}. Chạy trước: python sim3d/tools/gen_templates.py`,
    );
  }
  const scenario = JSON.parse(readFileSync(path, 'utf8'));
  const duration = Number(scenario.duration_frames);
  const parked = Number(scenario.initial?.n_parked ?? 0);
  if (!Number.isInteger(duration) || duration <= 0) {
    throw new Error(`${path}: duration_frames không hợp lệ (${String(scenario.duration_frames)})`);
  }
  return {
    duration,
    parked,
    envPreset: scenario.env?.preset ?? null,
    events: Array.isArray(scenario.events) ? scenario.events.length : 0,
    noiseOn: Object.entries(scenario.noise ?? {})
      .filter(([key, value]) => key !== 'seed' && value?.on === true)
      .map(([key]) => key),
  };
}

/**
 * Mở Chromium **bằng tiến trình riêng** với stderr bị bỏ, rồi nối qua CDP.
 *
 * Vì sao không dùng `chromium.launch()`: SwiftShader ghi
 * `GPU stall due to ReadPixels` **thẳng vào stderr của tiến trình** cho mỗi frame đọc
 * pixel; `chromium.launch()` bắt stderr đó bằng `PipeTransport` và cộng dồn vào **một
 * chuỗi** — xuất dài (K5 6000 frame) vượt 512 MB ⇒ `ERR_STRING_TOO_LONG` giết cả script
 * ở frame ~5900 (đo thật; `--disable-logging/--log-level=3/--silent` KHÔNG chặn được vì
 * đây là log của driver GL, không phải của Chromium). Mở tiến trình với `stdio: 'ignore'`
 * thì log đó đi vào hư không; CDP chỉ truyền lệnh/kết quả của script.
 */
async function launchQuietBrowser(chromium) {
  const port = await freePort();
  const isWindows = process.platform === 'win32';
  const child = spawn(
    chromium.executablePath(),
    [
      '--headless=new',
      `--remote-debugging-port=${String(port)}`,
      `--user-data-dir=${resolve(TMP_DIR, `chromium-export-${String(port)}`)}`,
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--disable-lcd-text',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
    ],
    { stdio: 'ignore' },
  );
  const stop = () => {
    if (child.exitCode !== null || child.killed) {
      return;
    }
    if (isWindows) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      return;
    }
    child.kill('SIGTERM');
  };
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${String(port)}`);
      return { browser, stop };
    } catch {
      if (child.exitCode !== null) {
        throw new Error(
          `Chromium thoát sớm (mã ${String(child.exitCode)}) khi mở cổng debug ${String(port)}`,
        );
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
    }
  }
  stop();
  throw new Error(`Không nối được CDP tới Chromium sau 30 s (cổng ${String(port)})`);
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

async function loadTemplate(page, args, info) {
  await page.waitForFunction(
    () => document.body.innerText.includes('Bãi pucpr'),
    undefined,
    { timeout: READY_TIMEOUT_MS },
  );

  const scenarioPanel = page.locator('.bottom-grid .panel-section').first();
  const exportPanel = page.locator('.bottom-grid .panel-section').nth(1);

  await scenarioPanel.locator('select').selectOption(args.template);
  await scenarioPanel.getByRole('button', { name: 'Nạp mẫu' }).click();

  // Chờ đúng thông số của **template này** (không hard-code 500 frame / 30 xe).
  await page.waitForFunction(
    (duration) => {
      const clock = document.querySelector('.timeline-clock');
      return clock !== null && clock.textContent?.includes(`/ ${String(duration)}`) === true;
    },
    info.duration,
    { timeout: READY_TIMEOUT_MS },
  );
  await page.waitForFunction(
    (parked) => document.querySelectorAll('.car-row').length === parked,
    info.parked,
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
  await exportPanel.getByRole('button', { name: 'Xuất', exact: true }).click();
  return exportPanel;
}

/**
 * Chờ kết quả xuất bằng cách **poll thư mục run**, không poll DOM.
 *
 * Kiểm `verify.json` của run mới nhất (BE chỉ ghi file này sau khi đã có đủ video + GT +
 * config), đồng thời vẫn theo dõi lỗi hiện trên panel để báo sớm khi UI báo hỏng. Nếu trang
 * chết giữa đường thì vẫn tiếp tục chờ file — không ném lỗi chỉ vì DOM không đọc được.
 */
async function waitForExportArtifact(runName, startedMs, timeoutMs, page, exportPanel) {
  const deadline = startedMs + timeoutMs;
  let lastUiError = null;
  while (Date.now() < deadline) {
    const runId = newestRunId(runName);
    if (runId !== null && existsSync(resolve(RUNS_DIR, runId, 'verify.json'))) {
      return runId;
    }
    // Đọc panel chỉ để phát hiện lỗi sớm; trang chết thì bỏ qua, không coi là lỗi xuất.
    try {
      const text = await exportPanel.innerText();
      const match = /(?:lỗi|error)[^\n]{0,160}/i.exec(text);
      if (match !== null) {
        lastUiError = match[0];
      }
    } catch {
      // Trang đã đóng — vẫn chờ file như bình thường.
    }
    void page;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
  }
  const extra =
    lastUiError === null ? '' : `\nLỗi UI gần nhất: ${lastUiError}`;
  throw new Error(
    `Hết ${String(Math.round(timeoutMs / 1000))} s mà chưa có verify.json cho "${runName}"${extra}`,
  );
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
  const info = templateInfo(args.template);
  console.log(
    `Template ${args.template}: ${String(info.duration)} frame · ${String(info.parked)} xe đỗ sẵn · ` +
      `env ${String(info.envPreset)} · ${String(info.events)} sự kiện · ` +
      `noise ${info.noiseOn.length === 0 ? 'tắt hết' : info.noiseOn.join(',')}`,
  );
  if (info.noiseOn.length === 0) {
    console.log('  (nhiễu tắt hết trong template — đúng như TASK: "nhiễu mặc định của template")');
  }

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
  let chromeStop = null;
  try {
    // Mở Chromium với stderr bị bỏ (xem `launchQuietBrowser`: log GL của SwiftShader làm
    // pipe của Playwright vượt 512 MB ở xuất dài). Vẫn giữ GL flags để pixel giống hệt.
    mkdirSync(TMP_DIR, { recursive: true });
    const launched = await launchQuietBrowser(chromium);
    browser = launched.browser;
    chromeStop = launched.stop;
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(`${error.name}: ${error.message}`));

    await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
    const exportPanel = await loadTemplate(page, args, info);
    const started = Date.now();

    // Chờ **`verify.json` trên đĩa** chứ không chờ DOM: xuất rất dài (K5 6000 frame) có thể
    // làm tiến trình Chromium chết ngay sau khi BE ghi xong kết quả (đo thật: chết ở
    // ~5900/6000 frame khi upload 114 MB mp4). Khi đó DOM không đọc được nữa nhưng kết quả
    // đã có — chờ DOM sẽ báo lỗi giả.
    await waitForExportArtifact(args.name, started, EXPORT_TIMEOUT_MS, page, exportPanel);

    const elapsed = ((Date.now() - started) / 1000).toFixed(1);

    const runId = newestRunId(args.name);
    if (runId === null) {
      throw new Error(`Không thấy thư mục run ${args.name} trong ${RUNS_DIR}`);
    }
    const verifyPath = resolve(RUNS_DIR, runId, 'verify.json');
    if (!existsSync(verifyPath)) {
      let panelText = '(không đọc được panel: trang đã đóng)';
      try {
        panelText = await exportPanel.innerText();
      } catch {
        // Trang đã chết — giữ thông báo mặc định ở trên.
      }
      throw new Error(
        `Xuất chưa xong (sau ${elapsed} s): không thấy ${verifyPath}\n${panelText}`,
      );
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
    // `browser.close()` chỉ ngắt CDP; phải kill tiến trình Chromium mình đã spawn.
    if (chromeStop !== null) {
      chromeStop();
    }
    if (browser !== null) {
      await browser.close().catch(() => undefined);
    }
    if (server !== null && !args.keepServer) {
      server.stop();
    } else if (server !== null) {
      console.log(`Dev server còn chạy ở ${baseUrl} (--keep-server)`);
    }
  }
}

main().catch((error) => {
  console.error(
    `export_template.mjs lỗi: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
