#!/usr/bin/env node
/**
 * Chụp ảnh kiểm render tĩnh (P4a mục 6).
 *
 * Chạy::
 *
 *     cd sim3d/web
 *     node ../tools/shot.mjs                  # chụp cả 2 ảnh
 *     node ../tools/shot.mjs --mode dataset   # chỉ 1 ảnh
 *
 * Cách làm:
 * 1. Dựng `vite dev` (đã cấu hình proxy `/api` → BE) trên cổng trống.
 * 2. Mở `render.html?mode=...` bằng Playwright Chromium (SwiftShader để WebGL chạy
 *    trong headless), chờ `window.__SIM3D_READY__`.
 * 3. Chụp **đúng phần tử canvas** (không chụp cả trang) để ảnh đúng 640×640.
 *
 * Không cài gì global: `playwright` là devDependency của `sim3d/web`, browser tải bằng
 * `npx playwright install chromium`.
 *
 * Ghi ra: `sim3d/tools/out/static_dataset.png`, `sim3d/tools/out/static_free.png`.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = resolve(HERE, '..', 'web');
const OUT_DIR = resolve(HERE, 'out');

/**
 * `playwright` là devDependency của `sim3d/web` (không cài global), mà script này nằm ở
 * `sim3d/tools/` nên phải resolve qua `web/`. Thiếu thì báo cách cài, không im lặng.
 */
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

/** Cổng dev cố định; đổi được bằng `--port`. */
const DEFAULT_PORT = 5199;

/** Thời gian chờ tối đa cho một ảnh (ms). */
const READY_TIMEOUT_MS = 90_000;

/** Ảnh tĩnh P4a: tên file + query của trang. */
const STATIC_SHOTS = [
  { file: 'static_dataset.png', mode: 'dataset', cams: '1cam', env: null, label: 'camera dataset 640×640' },
  { file: 'static_free.png', mode: 'free', cams: '1cam', env: null, label: 'chế độ Tự do (orbit)' },
];

/**
 * Ảnh môi trường E1–E8 (P8 mục 4): cùng camera dataset, chỉ đổi kịch bản.
 *
 * `envT` chọn mốc **đặc trưng** của từng kịch bản (không lấy giữa) để 8 ảnh khác nhau rõ:
 * E2 ở 6h (mọc), E4 ở lúc mưa to, E5 ở 19h30 (đèn bật), E7 ở 5h30 (sương dày).
 */
const ENV_SHOTS = [
  { id: 'E1', envT: 0, label: 'trưa nắng 12h' },
  { id: 'E2', envT: 0, label: 'ngày nắng — 6h mọc' },
  { id: 'E3', envT: 0, label: 'trời mây 10h' },
  { id: 'E4', envT: 18, label: 'mưa chiều — mưa to' },
  { id: 'E5', envT: 30, label: 'chạng vạng 19h30 (đèn bật)' },
  { id: 'E6', envT: 0, label: 'đêm 22h (đèn bãi)' },
  { id: 'E7', envT: 0, label: 'sương sớm 5h30' },
  { id: 'E8', envT: 0, label: 'đêm mưa 21h' },
].map(({ id, envT, label }) => ({
  file: `env_${id}.png`,
  mode: 'dataset',
  cams: '1cam',
  env: id,
  envT,
  label: `môi trường ${id} — ${label}`,
}));

/**
 * Ảnh nhiễu: mỗi loại một ảnh, mức 0,85 để thấy rõ (P8 mục 4).
 *
 * `fps_drop` **không** đổi pixel của một frame đơn (nó chỉ nói frame nào giữ khung cũ) —
 * ảnh kiểm của nó giống `env_E1.png` là **đúng thiết kế**; logic được test riêng trong
 * `cameraNoise.test.ts`.
 */
const NOISE_SHOTS = [
  'shake',
  'grain',
  'jpeg',
  'downscale',
  'fps_drop',
  'flare',
  'drops',
  'smudge',
  'white_balance',
].map((kind) => ({
  file: `noise_${kind}.png`,
  mode: 'dataset',
  cams: '1cam',
  // `drops` chỉ có tác dụng khi mưa ⇒ chụp dưới E8 (đêm mưa) cho đúng điều kiện.
  env: kind === 'drops' ? 'E8' : 'E1',
  noise: kind,
  noiseLevel: 0.85,
  label: `nhiễu ${kind}`,
}));

/** Bộ ảnh mặc định: tĩnh + môi trường + nhiễu. */
const SHOTS = [...STATIC_SHOTS, ...ENV_SHOTS, ...NOISE_SHOTS];

/** Nhóm để chọn bằng `--group`: static | env | noise | all. */
const GROUPS = {
  static: STATIC_SHOTS,
  env: ENV_SHOTS,
  noise: NOISE_SHOTS,
  all: SHOTS,
};

function parseArgs(argv) {
  const args = { mode: null, group: 'all', port: DEFAULT_PORT, keepServer: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--mode') {
      args.mode = argv[index + 1];
      index += 1;
    } else if (arg === '--group') {
      args.group = argv[index + 1];
      index += 1;
    } else if (arg === '--port') {
      args.port = Number(argv[index + 1]);
      index += 1;
    } else if (arg === '--keep-server') {
      args.keepServer = true;
    } else {
      throw new Error(`Tham số lạ: ${arg}`);
    }
  }
  return args;
}

/** Chờ dev server trả lời (hoặc báo lỗi kèm log của vite). */
async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
  }
  throw new Error(`Dev server không lên sau ${timeoutMs} ms: ${String(lastError)}`);
}

/** Chạy `vite dev` trong `sim3d/web`, trả tiến trình + hàm dừng. */
function startDevServer(port) {
  const isWindows = process.platform === 'win32';
  const child = spawn(
    isWindows ? 'npx.cmd' : 'npx',
    ['vite', '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    {
      cwd: WEB_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: isWindows,
      // Nhóm tiến trình riêng để kill được cả cây (npx -> node -> vite) trên Windows.
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
      // `shell: true` trên Windows khiến `child.kill()` chỉ giết cmd, không giết vite.
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      return;
    }
    child.kill('SIGTERM');
  };
  return { child, stop, log };
}

async function captureOne(browser, baseUrl, shot) {
  const page = await browser.newPage({
    viewport: { width: 900, height: 900 },
    deviceScaleFactor: 1,
  });
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => consoleErrors.push(`${error.name}: ${error.message}`));

  const params = new URLSearchParams({ mode: shot.mode, cams: shot.cams });
  if (shot.env !== null && shot.env !== undefined) {
    params.set('env', shot.env);
  }
  if (shot.envT !== undefined) {
    params.set('env_t', String(shot.envT));
  }
  if (shot.noise !== undefined) {
    params.set('noise', shot.noise);
    params.set('noise_level', String(shot.noiseLevel ?? 1));
  }
  const url = `${baseUrl}/render.html?${params.toString()}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  try {
    await page.waitForFunction(
      () => window.__SIM3D_READY__ === true || window.__SIM3D_ERROR__ !== undefined,
      { timeout: READY_TIMEOUT_MS },
    );
  } catch (error) {
    const body = await page.locator('body').innerText().catch(() => '');
    throw new Error(
      `Hết ${READY_TIMEOUT_MS} ms chờ cảnh sẵn sàng (${shot.mode}).\n` +
        `Log trang: ${body.slice(0, 800)}\n` +
        `Console: ${consoleErrors.join(' | ').slice(0, 800)}\n` +
        `Gốc lỗi: ${String(error)}`,
    );
  }

  const failure = await page.evaluate(() => window.__SIM3D_ERROR__);
  if (failure !== undefined) {
    throw new Error(`Trang báo lỗi render: ${failure}`);
  }

  // Có thể có nhiều canvas (WebGL + canvas 2D phụ để áp nhiễu): chọn canvas **đang hiện**.
  const canvas = page.locator('canvas:visible').first();
  await canvas.waitFor({ state: 'visible', timeout: 10_000 });
  const size = await canvas.evaluate((element) => ({
    width: element.width,
    height: element.height,
  }));

  const path = resolve(OUT_DIR, shot.file);
  await canvas.screenshot({ path, type: 'png' });
  await page.close();
  return { path, ...size, mode: shot.mode, consoleErrors };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const group = GROUPS[args.group];
  if (group === undefined) {
    throw new Error(`--group phải là static | env | noise | all, nhận "${args.group}"`);
  }
  const targets = args.mode === null ? group : group.filter((shot) => shot.mode === args.mode);
  if (targets.length === 0) {
    throw new Error(`Không có ảnh nào cho --mode ${String(args.mode)} trong nhóm ${args.group}`);
  }
  if (!existsSync(resolve(WEB_DIR, 'node_modules', 'playwright'))) {
    throw new Error('Thiếu playwright trong sim3d/web: chạy `npm install -D playwright` rồi `npx playwright install chromium`');
  }
  mkdirSync(OUT_DIR, { recursive: true });

  const baseUrl = `http://127.0.0.1:${args.port}`;
  const { chromium } = await loadPlaywright();
  const server = startDevServer(args.port);
  const results = [];
  let browser = null;
  try {
    await waitForServer(`${baseUrl}/render.html`);
    browser = await chromium.launch({
      args: [
        // Headless không có GPU: buộc dùng SwiftShader để WebGL chạy được.
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--disable-lcd-text',
      ],
    });
    for (const shot of targets) {
      const result = await captureOne(browser, baseUrl, shot);
      results.push(result);
      console.log(
        `${shot.file}: ${result.width}×${result.height} (${shot.label})` +
          (result.consoleErrors.length > 0 ? ` · console error: ${result.consoleErrors.length}` : ''),
      );
      if (result.consoleErrors.length > 0) {
        for (const message of result.consoleErrors) {
          console.log(`  console: ${message}`);
        }
      }
    }
  } finally {
    if (browser !== null) {
      await browser.close();
    }
    if (!args.keepServer) {
      server.stop();
    } else {
      console.log(`Dev server còn chạy ở ${baseUrl} (--keep-server)`);
    }
  }
  return results;
}

main()
  .then((results) => {
    if (results.length === 0) {
      console.error('Không chụp được ảnh nào');
      process.exit(1);
    }
    console.log(`Xong: ${results.length} ảnh trong ${OUT_DIR}`);
    process.exit(0);
  })
  .catch((error) => {
    console.error(`shot.mjs lỗi: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
