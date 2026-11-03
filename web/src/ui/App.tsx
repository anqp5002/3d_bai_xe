/**
 * UI P9 (FE §2) — panel map/xe, khung xem 3D, camera, dòng thời gian, kịch bản, xuất.
 *
 * Phần môi trường/nhiễu là chỗ trống có nhãn “P8” (task P9b). Toàn bộ logic mô phỏng
 * nằm trong store; component chỉ đọc/ghi store và dựng DOM.
 */

import { useEffect } from 'react';
import { useSimStore } from '../store/simStore';
import { CameraPanel } from './CameraPanel';
import { CarsPanel } from './CarsPanel';
import { EnvPanel } from './env/EnvPanel';
import { ExportPanel } from './ExportPanel';
import { MapPanel } from './MapPanel';
import { ScenarioPanel } from './ScenarioPanel';
import { StatusBar } from './StatusBar';
import { Timeline } from './Timeline';
import { Viewport } from './Viewport';
import { usePlayback } from './usePlayback';
import './app.css';

export function App() {
  const loadInitial = useSimStore((store) => store.loadInitial);
  const viewMode = useSimStore((store) => store.viewMode);
  const setViewMode = useSimStore((store) => store.setViewMode);
  const setPlaying = useSimStore((store) => store.setPlaying);
  const clearLeader = useSimStore((store) => store.clearLeader);
  const loading = useSimStore((store) => store.loading);

  usePlayback();

  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  useEffect(() => {
    if (viewMode !== 'record') {
      return;
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        clearLeader();
        setViewMode('dataset');
        return;
      }
      if (event.key === ' ') {
        event.preventDefault();
        setPlaying(!useSimStore.getState().playing);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [viewMode, setViewMode, setPlaying, clearLeader]);

  const enterRecord = (): void => {
    // C2: chuỗi đánh dấu chỉ bắt đầu khi bấm Play ở frame 0 — vào chế độ Quay thì reset.
    clearLeader();
    setViewMode('record');
  };

  if (viewMode === 'record') {
    return (
      <div className="app record">
        <Viewport />
        <button
          type="button"
          className="record-exit"
          onClick={() => setViewMode('dataset')}
        >
          Thoát (Esc)
        </button>
      </div>
    );
  }
  return (
    <div className="app">
      <header className="topbar">
        <div>
          <h1>SIM3D — bãi PUCPR</h1>
          <p className="subtitle">Bãi đỗ mô phỏng 3D · GT · TechGAR replay</p>
        </div>
        <span className="spacer" />
        {loading && <span className="muted">Đang tải…</span>}
        <button
          type="button"
          className="btn"
          onClick={() => {
            void loadInitial();
          }}
        >
          Nạp lại BE
        </button>
        <button type="button" className="btn btn-primary" onClick={enterRecord}>
          Quay
        </button>
      </header>

      <main className="workspace">
        <aside className="panel">
          <MapPanel />
          <CarsPanel />
        </aside>
        <section className="viewport-wrap">
          <Viewport />
        </section>
        <aside className="panel">
          <CameraPanel />
          <EnvPanel />
        </aside>
      </main>

      <footer className="bottom">
        <Timeline />
        <div className="bottom-grid">
          <ScenarioPanel />
          <ExportPanel />
        </div>
      </footer>
      <StatusBar />
    </div>
  );
}
