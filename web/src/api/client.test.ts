import { describe, expect, it } from 'vitest';
import { ApiError, api } from './client';

describe('api/client — chặn đường dẫn trước khi gửi', () => {
  it('từ chối `..` trong path của PUT file (BE §3 chặn path traversal)', async () => {
    await expect(api.putRunFile('run-1', '../scenarios/x.json', new Blob([]))).rejects.toThrow(
      /đường dẫn không hợp lệ/,
    );
  });

  it('từ chối đường dẫn tuyệt đối', async () => {
    await expect(api.putRunFile('run-1', '/etc/passwd', new Blob([]))).rejects.toThrow(
      /đường dẫn không hợp lệ/,
    );
    await expect(api.putRunFile('run-1', '\\windows\\system32', new Blob([]))).rejects.toThrow(
      /đường dẫn không hợp lệ/,
    );
  });

  it('ApiError giữ mã HTTP, detail và path để UI hiện đúng (R2)', () => {
    const error = new ApiError(404, 'không có template "K9"', '/api/templates/K9');
    expect(error.status).toBe(404);
    expect(error.detail).toBe('không có template "K9"');
    expect(error.message).toContain('HTTP 404');
    expect(error.message).toContain('không có template "K9"');
  });
});
