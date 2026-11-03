/**
 * Contract C-B (phía FE) — **file duy nhất biết URL** của BE (MEGAPLAN C-B, BE §3).
 *
 * Không file nào khác trong `web/src/` được viết `'/api/...'` hay `fetch(...)`.
 * Lúc phát triển, Vite proxy `/api` → `http://127.0.0.1:8010` (xem `vite.config.ts`);
 * lúc production, BE phục vụ luôn `web/dist` nên vẫn là đường dẫn tương đối.
 *
 * Mọi lỗi đều ném `ApiError` kèm mã HTTP và `detail` của BE — không nuốt (R2).
 */

import type { LotMap } from '../contracts/lot';
import type { Scenario } from '../contracts/scenario';
import { validateScenario } from '../contracts/scenario';

/** Tiền tố duy nhất của API. */
const API_BASE = '/api';

/** Lỗi gọi API; giữ mã HTTP + `detail` để UI hiện đúng. */
export class ApiError extends Error {
  override readonly name = 'ApiError';

  constructor(
    readonly status: number,
    readonly detail: string,
    readonly path: string,
  ) {
    super(`${path} → HTTP ${status}: ${detail}`);
  }
}

/** BE §3 `GET /api/health`. */
export interface HealthResponse {
  readonly ok: boolean;
  readonly version: string;
  readonly ffmpeg: boolean;
}

/** Một kịch bản mẫu trong thư viện K1–K8 (BE §3 `GET /api/templates`). */
export interface TemplateEntry {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

/** Một kịch bản đã lưu (BE §3 `GET /api/scenarios`). */
export interface ScenarioEntry {
  readonly name: string;
  /** ISO 8601. */
  readonly modified_at: string;
}

/** Body `POST /api/runs` (BE §3). */
export interface CreateRunRequest {
  readonly name: string;
  readonly outputs: readonly ('full' | 'cam1' | 'cam2')[];
  readonly duration_frames: number;
  readonly fps: number;
}

export interface CreateRunResponse {
  readonly run_id: string;
}

/** Một mục kiểm trong `verify.json` (BE §6). */
export interface VerifyItem {
  readonly id: number;
  readonly ok: boolean;
  readonly detail: string;
}

/** `verify.json` (BE §6). */
export interface VerifyReport {
  readonly ok: boolean;
  readonly run_id: string;
  readonly generated_at: string;
  readonly items: readonly VerifyItem[];
  readonly export_seconds: number;
  readonly realtime_ratio: number;
}

/** Chi tiết một lần xuất (BE §3 `GET /api/runs/<run_id>`). */
export interface RunDetail {
  readonly run_id: string;
  readonly created_at: string;
  readonly files: readonly string[];
  readonly verify: VerifyReport | null;
}

/** `export_log.json` (BE §2, D13). */
export interface ExportLog {
  readonly run_id: string;
  readonly started_at: string;
  readonly finished_at: string | null;
  readonly duration_frames: number;
  readonly fps: number;
  readonly render_fps: number | null;
  readonly warnings: readonly string[];
}

interface ErrorBody {
  readonly error?: string;
  readonly detail?: string;
}

async function readErrorBody(response: Response): Promise<string> {
  const text = await response.text();
  if (text.length === 0) {
    return response.statusText;
  }
  try {
    const body = JSON.parse(text) as ErrorBody;
    return body.detail ?? body.error ?? text;
  } catch (error) {
    // Không phải JSON: vẫn phải báo nội dung thô, không nuốt lỗi (R2).
    if (error instanceof SyntaxError) {
      return text;
    }
    throw error;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${API_BASE}${path}`;
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new ApiError(response.status, await readErrorBody(response), url);
  }
  return (await response.json()) as T;
}

/** Gọi JSON không cần đọc body trả về (204). */
async function requestVoid(path: string, init?: RequestInit): Promise<void> {
  const url = `${API_BASE}${path}`;
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new ApiError(response.status, await readErrorBody(response), url);
  }
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export const api = {
  /** `GET /api/health`. */
  health(): Promise<HealthResponse> {
    return request<HealthResponse>('/health');
  },

  /** `GET /api/lot/pucpr`. */
  lot(): Promise<LotMap> {
    return request<LotMap>('/lot/pucpr');
  },

  /** `GET /api/templates`. */
  templates(): Promise<readonly TemplateEntry[]> {
    return request<readonly TemplateEntry[]>('/templates');
  },

  /** `GET /api/templates/<id>`. */
  template(id: string): Promise<Scenario> {
    return request<unknown>(`/templates/${encodeURIComponent(id)}`).then(validateScenario);
  },

  /** `GET /api/scenarios`. */
  scenarios(): Promise<readonly ScenarioEntry[]> {
    return request<readonly ScenarioEntry[]>('/scenarios');
  },

  /** `GET /api/scenarios/<name>`. */
  scenario(name: string): Promise<Scenario> {
    return request<unknown>(`/scenarios/${encodeURIComponent(name)}`).then(validateScenario);
  },

  /** `PUT /api/scenarios/<name>` — BE trả 400 nếu schema/trường bắt buộc sai. */
  async saveScenario(name: string, scenario: Scenario): Promise<void> {
    validateScenario(scenario);
    await requestVoid(`/scenarios/${encodeURIComponent(name)}`, jsonInit('PUT', scenario));
  },

  /** `DELETE /api/scenarios/<name>`. */
  async deleteScenario(name: string): Promise<void> {
    await requestVoid(`/scenarios/${encodeURIComponent(name)}`, { method: 'DELETE' });
  },

  /** `POST /api/runs`. */
  createRun(body: CreateRunRequest): Promise<CreateRunResponse> {
    return request<CreateRunResponse>('/runs', jsonInit('POST', body));
  },

  /**
   * `PUT /api/runs/<run_id>/files/<path>` — gửi nguyên file.
   * `relPath` phải nằm trong danh sách cho phép của BE (§2, §5) và **không** chứa `..`.
   */
  async putRunFile(runId: string, relPath: string, body: Blob | ArrayBuffer): Promise<void> {
    if (relPath.includes('..') || relPath.startsWith('/') || relPath.startsWith('\\')) {
      throw new Error(`putRunFile: đường dẫn không hợp lệ "${relPath}"`);
    }
    await requestVoid(`/runs/${encodeURIComponent(runId)}/files/${relPath}`, {
      method: 'PUT',
      body,
    });
  },

  /** `POST /api/runs/<run_id>/frames` — đường dự phòng PNG → ffmpeg (BE §4.3). */
  async postRunFrame(runId: string, frameIndex: number, png: Blob): Promise<void> {
    const form = new FormData();
    form.set('frame_index', String(frameIndex));
    form.set('file', png, `${String(frameIndex).padStart(6, '0')}.png`);
    await requestVoid(`/runs/${encodeURIComponent(runId)}/frames`, {
      method: 'POST',
      body: form,
    });
  },

  /** `POST /api/runs/<run_id>/finalize` — ghép ffmpeg (nếu cần) + chạy kiểm §6. */
  finalize(runId: string): Promise<VerifyReport> {
    return request<VerifyReport>(`/runs/${encodeURIComponent(runId)}/finalize`, { method: 'POST' });
  },

  /** `GET /api/runs`. */
  runs(): Promise<readonly RunDetail[]> {
    return request<readonly RunDetail[]>('/runs');
  },

  /** `GET /api/runs/<run_id>`. */
  run(runId: string): Promise<RunDetail> {
    return request<RunDetail>(`/runs/${encodeURIComponent(runId)}`);
  },

  /** `POST /api/runs/<run_id>/open-folder` — chỉ có tác dụng trên Windows. */
  async openRunFolder(runId: string): Promise<void> {
    await requestVoid(`/runs/${encodeURIComponent(runId)}/open-folder`, { method: 'POST' });
  },
};
