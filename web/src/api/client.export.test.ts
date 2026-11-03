import { describe, expect, it, vi, afterEach } from 'vitest';
import { ApiError, api } from './client';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Giả `fetch` trả response và ghi lại URL đã gọi. */
function stubFetch(handler: (url: string, init?: RequestInit) => Response): string[] {
  const calls: string[] = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    return Promise.resolve(handler(url, init));
  });
  return calls;
}

describe('api/client — endpoint xuất (P7a mục 4)', () => {
  it('createRun POST /api/runs với body đúng', async () => {
    let body = '';
    const calls = stubFetch((_url, init) => {
      const rawBody = init?.body;
      body = typeof rawBody === 'string' ? rawBody : '';
      return new Response(JSON.stringify({ run_id: 'r1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const result = await api.createRun({
      name: 'x',
      outputs: ['full', 'cam1'],
      duration_frames: 500,
      fps: 25,
    });
    expect(result.run_id).toBe('r1');
    expect(calls[0]).toBe('/api/runs');
    expect(JSON.parse(body)).toEqual({
      name: 'x',
      outputs: ['full', 'cam1'],
      duration_frames: 500,
      fps: 25,
    });
  });

  it('putRunFile PUT /api/runs/<id>/files/<path>', async () => {
    const calls = stubFetch(() => new Response(null, { status: 204 }));
    await api.putRunFile('r1', 'techgar_config/calibration.json', new ArrayBuffer(4));
    expect(calls).toEqual(['/api/runs/r1/files/techgar_config/calibration.json']);
  });

  it('putRunFile chặn ".." trước khi gọi mạng (BE §8 chặn path traversal)', async () => {
    const calls = stubFetch(() => new Response(null, { status: 204 }));
    await expect(api.putRunFile('r1', '../backend/x.json', new ArrayBuffer(0))).rejects.toThrow(
      /đường dẫn không hợp lệ/,
    );
    expect(calls).toEqual([]);
  });

  it('postRunFrame gửi multipart với frame_index + tên file %06d', async () => {
    let form: FormData | null = null;
    const calls = stubFetch((_url, init) => {
      form = init?.body as FormData;
      return new Response(null, { status: 204 });
    });
    await api.postRunFrame('r1', 7, new Blob([new Uint8Array([1])], { type: 'image/png' }));
    expect(calls).toEqual(['/api/runs/r1/frames']);
    expect(form).not.toBeNull();
    const data = form as unknown as FormData;
    expect(data.get('frame_index')).toBe('7');
    const file = data.get('file') as File;
    expect(file.name).toBe('000007.png');
  });

  it('finalize POST và trả verify', async () => {
    const verify = {
      ok: true,
      run_id: 'r1',
      generated_at: '2026-10-31T05:00:00Z',
      items: [{ id: 1, ok: true, detail: 'ok' }],
      export_seconds: 2,
      realtime_ratio: 1,
    };
    const calls = stubFetch(
      () =>
        new Response(JSON.stringify(verify), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const result = await api.finalize('r1');
    expect(calls).toEqual(['/api/runs/r1/finalize']);
    expect(result).toEqual(verify);
  });

  it('lỗi BE có detail thì ApiError giữ nguyên detail (không nuốt lỗi)', async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ error: 'bad_request', detail: 'outputs rỗng' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const error = await api
      .createRun({ name: 'x', outputs: [], duration_frames: 1, fps: 25 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(400);
    expect((error as ApiError).detail).toBe('outputs rỗng');
  });
});
