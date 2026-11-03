/**
 * Điểm vào của web SIM3D.
 *
 * UI đầy đủ ở `ui/App.tsx` (P9, FE §2): store ở `store/`, Three adapter ở
 * `ui/SceneController.ts`, xuất nối `export/runExport`.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Không tìm thấy #root trong index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
