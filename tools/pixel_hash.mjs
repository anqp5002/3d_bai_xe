#!/usr/bin/env node
/**
 * Pixel tất định giữa hai lần chạy (P9d mục 2; QA_CHECKLIST mục 3 "chưa kiểm được").
 *
 * Chạy::
 *
 *     cd sim3d/server && .venv/Scripts/python -m sim3d_server --root ../data   # cần cho /api/lot
 *     cd sim3d/web && node ../tools/pixel_hash.mjs
 *     node ../tools/pixel_hash.mjs --seed-tag A      # để so hai lần chạy khác tiến trình
 *
 * Cách làm
 * --------
 * Dùng **`render.html`** (không phải UI chính): trang đó dựng **một** frame theo query
 * `mode/count/env/envT/noise/level/frame/crop` rồi dừng — đúng thứ cần để băm pixel.
 * UI chính không áp env/noise lên canvas live (`SceneController` chỉ dựng cảnh), nên băm
 * UI chính sẽ ra cùng một ảnh cho mọi frame và **không** kiểm được gì.
 *
 * Mỗi frame được dựng ở **hai trang riêng biệt** (`page.close()` rồi mở lại), để WebGL
 * context, cache shader và bộ đệm đều mới — nếu chỉ reload trong cùng page thì lớp tất
 * định có thể do context cũ, không chứng minh được gì.
 *
 * Băm **FNV-1a 32-bit trên toàn bộ byte RGBA** đọc từ canvas. Cố ý không dùng SHA-256 để
 * khi lệch còn đếm được số pixel khác nhau.
 *
 * Nếu Chromium headless/SwiftShader không tất định thật thì script **ghi số đo cụ thể**
 * (bao nhiêu pixel khác, nhiều nhất ở đâu) và thoát mã 1 — KHÔNG ép pass (TASK P9d).
 *
 * Không cài gì global: `playwright` resolve từ `sim3d/web`.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SIM3D_ROOT = resolve(HERE, '..');
const WEB_DIR = resolve(SIM3D_ROOT, 'web');
const OUT_DIR = resolve(HERE, 'out');
const BE_URL = process.env.SIM3D_BE_URL ?? 'http://127.0.0.1:8010';
const DEFAULT_PORT = Number(process.env.SIM3D_PORT ?? 5202);

/** Frame mẫu: đầu, giữa, cuối của K8 (500 frame). */
const SAMPLE_FRAMES = [0, 100, 499];

/** Cùng một bộ tham số cho cả hai lần — "cùng seed và cùng env/noise" theo TASK. */
const RENDER_QUERY = 'mode=record&count=2cam&env=E8&envT=30&noise=grain&level=0.5&crop=full';

function parseArgs(argv) {
  const args = { port: DEFAULT_PORT, keepServer: false, tag: 'A' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--port') {
      args.port = Number(argv[index + 1]);
      index += 1;
    } else if (arg === '--tag') {
      args.tag = argv[index + 1];
      index += 1;
    } else if (arg === '--keep-server') {
      args.keepServer = true;
    } else {
      throw new Error(`Tham số lạ: ${arg}`);
    }
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

/**
 * Dựng một frame ở **trang mới** rồi trả ảnh RGBA thô.
 *
 * Trả `{width, height, data, noiseHash}`; `data` là `number[]` (Playwright chuyển được
 * `Uint8Array` về mảng thường).
 */
async function renderOne(browser, baseUrl, frame) {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  try {
    const url = `${baseUrl}/render.html?${RENDER_QUERY}&frame=${String(frame)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => window.__SIM3D_READY__ === true || typeof window.__SIM3D_ERROR__ === 'string',
      undefined,
      { timeout: 90_000 },
    );
    const error = await page.evaluate(() => window.__SIM3D_ERROR__ ?? null);
    if (error !== null) {
      throw new Error(`render.html lỗi ở frame ${String(frame)}: ${error}`);
    }
    return await page.evaluate(() => {
      // Ảnh có thể nằm ở canvas WebGL gốc hoặc canvas 2D thay thế khi đã áp nhiễu.
      const source =
        document.getElementById('sim3d-noise') ?? document.querySelector('canvas');
      if (!(source instanceof HTMLCanvasElement)) {
        throw new Error('không thấy canvas sau khi render');
      }
      const copy = document.createElement('canvas');
      copy.width = source.width;
      copy.height = source.height;
      const context = copy.getContext('2d', { willReadFrequently: true });
      if (context === null) {
        throw new Error('không lấy được 2D context để đọc pixel');
      }
      context.drawImage(source, 0, 0);
      const data = context.getImageData(0, 0, copy.width, copy.height).data;
      return {
        width: copy.width,
        height: copy.height,
        data: Array.from(data),
        noiseHash: window.__SIM3D__?.noiseHash ?? null,
      };
    });
  } finally {
    await page.close();
  }
}

/** FNV-1a 32-bit trên mảng byte — ổn định, không phụ thuộc thư viện. */
function fnv1a(bytes) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= bytes[index];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Đếm pixel khác nhau giữa hai ảnh cùng kích thước + vị trí khác đầu tiên. */
function diffPixels(a, b) {
  if (a.width !== b.width || a.height !== b.height) {
    return { comparable: false, count: -1, first: null, total: 0 };
  }
  const total = a.width * a.height;
  let count = 0;
  let first = null;
  let maxDelta = 0;
  for (let index = 0; index < total; index += 1) {
    const offset = index * 4;
    const d0 = Math.abs(a.data[offset] - b.data[offset]);
    const d1 = Math.abs(a.data[offset + 1] - b.data[offset + 1]);
    const d2 = Math.abs(a.data[offset + 2] - b.data[offset + 2]);
    if (d0 !== 0 || d1 !== 0 || d2 !== 0) {
      count += 1;
      maxDelta = Math.max(maxDelta, d0, d1, d2);
      if (first === null) {
        first = { x: index % a.width, y: Math.floor(index / a.width), delta: Math.max(d0, d1, d2) };
      }
    }
  }
  return { comparable: true, count, first, total, maxDelta };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!(await isUp(`${BE_URL}/api/health`))) {
    throw new Error(
      `BE chưa chạy ở ${BE_URL}/api/health (render.html cần /api/lot).\n` +
        'Chạy: cd sim3d/server && .venv/Scripts/python -m sim3d_server --root ../data',
    );
  }

  const baseUrl = `http://127.0.0.1:${String(args.port)}`;
  const running = await isUp(`${baseUrl}/`);
  const server = running ? null : startDevServer(args.port);
  if (server === null) {
    console.log(`Dùng Vite dev sẵn có ở ${baseUrl}`);
  } else {
    await waitForServer(`${baseUrl}/`);
  }

  const { chromium } = await loadPlaywright();
  const results = [];
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

    console.log(`Tham số render: ${RENDER_QUERY}`);
    console.log(
      `So 2 lần dựng ở trang riêng · frame mẫu ${SAMPLE_FRAMES.join(', ')} · tag ${args.tag}`,
    );
    console.log('');

    for (const frame of SAMPLE_FRAMES) {
      const first = await renderOne(browser, baseUrl, frame);
      const second = await renderOne(browser, baseUrl, frame);
      const hashA = fnv1a(first.data);
      const hashB = fnv1a(second.data);
      const diff = diffPixels(first, second);
      const same = hashA === hashB;
      results.push({
        frame,
        size: [first.width, first.height],
        hashA,
        hashB,
        same,
        noiseHashA: first.noiseHash,
        noiseHashB: second.noiseHash,
        diff: { count: diff.count, total: diff.total, first: diff.first, maxDelta: diff.maxDelta },
      });
      const detail =
        same
          ? `giống hệt (${String(first.width)}×${String(first.height)})`
          : `${String(diff.count)}/${String(diff.total)} pixel khác` +
            (diff.first === null
              ? ''
              : ` · khác đầu tiên (${String(diff.first.x)},${String(diff.first.y)}) Δ=${String(diff.first.delta)}`) +
            ` · Δ lớn nhất ${String(diff.maxDelta)}`;
      console.log(
        `frame ${String(frame).padStart(3)}: ${same ? 'GIỐNG' : 'KHÁC  '} ${hashA} / ${hashB} · ${detail}`,
      );
    }

    const allSame = results.every((item) => item.same);
    const payload = {
      ok: allSame,
      query: RENDER_QUERY,
      frames: SAMPLE_FRAMES,
      tag: args.tag,
      note:
        'FNV-1a 32-bit trên byte RGBA canvas; mỗi lần là một trang mới (WebGL context mới). ' +
        'Dùng render.html vì UI chính không áp env/noise lên canvas live.',
      results,
    };
    mkdirSync(OUT_DIR, { recursive: true });
    const path = resolve(OUT_DIR, `pixel_hash_${args.tag}.json`);
    writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

    console.log('');
    if (allSame) {
      console.log(`KẾT LUẬN: TẤT ĐỊNH — ${String(results.length)}/${String(results.length)} frame khớp byte.`);
    } else {
      const differing = results.filter((item) => !item.same);
      console.log(
        `KẾT LUẬN: KHÔNG TẤT ĐỊNH — ${String(differing.length)}/${String(results.length)} frame khác nhau:`,
      );
      for (const item of differing) {
        console.log(
          `  frame ${String(item.frame)}: ${String(item.diff.count)}/${String(item.diff.total)} pixel khác`,
        );
      }
      console.log(
        'Đây là kết quả ĐO, không phải lỗi test: Chromium headless + SwiftShader có thể ' +
          'không tất định ở mức pixel. GT không phụ thuộc phần này.',
      );
    }
    console.log(`Chi tiết: ${path}`);
    process.exitCode = allSame ? 0 : 1;
  } finally {
    if (browser !== null) {
      await browser.close();
    }
    if (server !== null && !args.keepServer) {
      server.stop();
    }
  }
}

main().catch((error) => {
  console.error(`pixel_hash.mjs lỗi: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
