import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Proxy `/api` → BE nội bộ (BE §1: chỉ nghe 127.0.0.1:8010).
 * Dùng 127.0.0.1 thay vì "localhost" để không phụ thuộc thứ tự phân giải IPv6/IPv4:
 * BE chỉ bind IPv4 nên "localhost" → ::1 sẽ bị từ chối kết nối.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8010',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: false,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
