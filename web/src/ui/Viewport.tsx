/**
 * Khung xem 3D (FE §2): camera dataset / Tự do / Quay, 1 cam / 2 cam, click chọn xe-hoặc-ô.
 *
 * Component này là nơi duy nhất trong UI tạo `SceneController` (Three/WebGL); store và
 * `exportAdapter` dùng lại controller đó cho live/export.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Vector2 } from 'three';
import type { CameraViewMode } from '../render/cameraGeometry';
import {
  ONE_CAM_NOTE,
  VIEW_MODE_LABEL,
} from '../store/scenarioModel';
import { useSimStore } from '../store/simStore';
import { leaderLabel } from '../store/recordLeader';
import { loadCarTemplates } from './carAssets';
import { SceneController } from './SceneController';
import { applyLiveNoise } from './liveNoise';

const VIEW_MODES: readonly CameraViewMode[] = ['dataset', 'free', 'record'];

export function Viewport() {
  const lot = useSimStore((store) => store.lot);
  const state = useSimStore((store) => store.state);
  const scenario = useSimStore((store) => store.scenario);
  const selectedCarId = useSimStore((store) => store.selectedCarId);
  const viewMode = useSimStore((store) => store.viewMode);
  const cameraCount = useSimStore((store) => store.cameraCount);
  const setViewMode = useSimStore((store) => store.setViewMode);
  const setCameraCount = useSimStore((store) => store.setCameraCount);
  const recordSyncLeader = useSimStore((store) => store.recordSyncLeader);
  const setRecordSyncLeader = useSimStore((store) => store.setRecordSyncLeader);
  const leaderFramesLeft = useSimStore((store) => store.leaderFramesLeft);
  const consumeLeaderFrame = useSimStore((store) => store.consumeLeaderFrame);
  const resumePlayback = useSimStore((store) => store.resumePlayback);
  const selectCar = useSimStore((store) => store.selectCar);
  const selectSlot = useSimStore((store) => store.selectSlot);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const noiseCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const controllerRef = useRef<SceneController | null>(null);
  const pointerStart = useRef<{ x: number; y: number } | null>(null);
  const [ready, setReady] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [idle, setIdle] = useState(false);

  /**
   * Render một frame và áp môi trường + nhiễu (P14b).
   *
   * Phải làm đúng thứ tự như `exportAdapter`: áp môi trường **trước** khi render cảnh, rồi mới
   * áp nhiễu lên ảnh đã render. Env/nhiễu không đụng tới `state`, nên GT không đổi.
   */
  const renderFrame = useCallback(() => {
    const controller = controllerRef.current;
    if (controller === null) {
      return;
    }
    const store = useSimStore.getState();
    const scenarioNow = store.scenario;
    const frame = store.state?.frame ?? 0;
    const env =
      scenarioNow === null
        ? null
        : controller.applyEnvironment(scenarioNow.env.keyframes, frame / 25);
    controller.render();
    // Nhiễu camera: dùng đúng pipeline của export để khung xem giống video xuất.
    const canvas = canvasRef.current;
    const noiseCanvas = noiseCanvasRef.current;
    if (canvas === null || noiseCanvas === null) {
      return;
    }
    if (scenarioNow === null) {
      noiseCanvas.style.display = 'none';
      return;
    }
    if (noiseCanvas.width !== canvas.width || noiseCanvas.height !== canvas.height) {
      noiseCanvas.width = canvas.width;
      noiseCanvas.height = canvas.height;
      // CSS hiển thị theo đúng kích thước pixel của canvas WebGL để ảnh 1:1, không lệch lớp.
      noiseCanvas.style.width = `${canvas.clientWidth}px`;
      noiseCanvas.style.height = `${canvas.clientHeight}px`;
    }
    const context = noiseCanvas.getContext('2d');
    if (context === null) {
      noiseCanvas.style.display = 'none';
      return;
    }
    context.clearRect(0, 0, noiseCanvas.width, noiseCanvas.height);
    context.drawImage(canvas, 0, 0);
    const source = context.getImageData(0, 0, noiseCanvas.width, noiseCanvas.height);
    const result = applyLiveNoise(
      {
        width: source.width,
        height: source.height,
        data: new Uint8ClampedArray(source.data),
      },
      scenarioNow.noise,
      frame,
      env,
    );
    if (result === null) {
      noiseCanvas.style.display = 'none';
      return;
    }
    const output = context.createImageData(result.frame.width, result.frame.height);
    output.data.set(result.frame.data);
    context.putImageData(output, 0, 0);
    noiseCanvas.style.display = result.applied ? 'block' : 'none';
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (lot === null || canvas === null) {
      return;
    }
    let alive = true;
    setReady(false);
    setRenderError(null);
    const controller = new SceneController({
      canvas,
      lot,
      mode: viewMode,
      count: cameraCount,
      // P14b: khung xem phải giống video xuất — bật lớp môi trường (mây/mưa/đèn/trời) ở đây,
      // không chỉ ở `exportAdapter`. Anh An quay màn hình (U1a) nên hai bên phải cùng một cảnh.
      environment: true,
      envSeed: useSimStore.getState().scenario?.seed ?? 1,
    });
    controllerRef.current = controller;

    loadCarTemplates()
      .then((templates) => {
        if (!alive) {
          return;
        }
        controller.setTemplates(templates);
        const latest = useSimStore.getState();
        if (latest.state !== null) {
          controller.applyState(latest.state, latest.selectedCarId);
        }
        renderFrame();
        setReady(true);
      })
      .catch((error: unknown) => {
        if (alive) {
          setRenderError(error instanceof Error ? error.message : String(error));
        }
      });

    return () => {
      alive = false;
      controller.dispose();
      controllerRef.current = null;
    };
  }, [lot, viewMode, cameraCount, renderFrame]);

  useEffect(() => {
    if (!ready) {
      return;
    }
    const controller = controllerRef.current;
    if (controller === null) {
      return;
    }
    if (state !== null) {
      controller.applyState(state, selectedCarId);
    }
    renderFrame();
    // P14b: đổi preset/mốc môi trường hoặc nhiễu thì phải thấy ngay, **kể cả khi đang dừng**
    // (lúc đó `state` không đổi nên effect trên không chạy).
  }, [ready, state, selectedCarId, scenario, renderFrame]);

  /**
   * C2: hiện 3 frame trắng đánh dấu rồi mới chạy frame 0.
   *
   * Mỗi frame đánh dấu giữ đúng 1/25 s (khớp `FRAME_MS` của `usePlayback`) để video quay
   * tay có 3 frame cách đều, rồi mới bật `playing`. Dùng `requestAnimationFrame` để chờ
   * trình duyệt thực sự vẽ xong frame trắng trước khi tăng số.
   */
  useEffect(() => {
    if (leaderFramesLeft <= 0) {
      return;
    }
    let raf = 0;
    let startedAt = 0;
    const tick = (now: number): void => {
      if (startedAt === 0) {
        startedAt = now;
      }
      if (now - startedAt >= 1000 / 25) {
        consumeLeaderFrame();
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [leaderFramesLeft, consumeLeaderFrame]);

  /**
   * Hết chuỗi đánh dấu ⇒ bắt đầu phát thật từ frame 0 (C2: "rồi mới chạy từ frame 0").
   *
   * Chỉ tự phát khi **vừa** hết chuỗi (`previous > 0`), không phải lúc mới vào chế độ
   * Quay (khi đó `leaderFramesLeft` cũng là 0).
   */
  const previousLeader = useRef(0);
  useEffect(() => {
    const wasShowing = previousLeader.current > 0;
    previousLeader.current = leaderFramesLeft;
    if (!wasShowing || leaderFramesLeft > 0) {
      return;
    }
    resumePlayback();
  }, [leaderFramesLeft, resumePlayback]);

  useEffect(() => {
    if (viewMode !== 'record') {
      return;
    }
    let timer: number | undefined;
    const reset = (): void => {
      setIdle(false);
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
      timer = window.setTimeout(() => setIdle(true), 1000);
    };
    reset();
    window.addEventListener('pointermove', reset);
    return () => {
      window.removeEventListener('pointermove', reset);
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [viewMode]);

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    pointerStart.current = { x: event.clientX, y: event.clientY };
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const start = pointerStart.current;
    pointerStart.current = null;
    if (start === null || viewMode === 'record') {
      return;
    }
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) {
      // Kéo OrbitControls, không phải click chọn.
      return;
    }
    const controller = controllerRef.current;
    if (controller === null) {
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }
    const ndc = new Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -(((event.clientY - rect.top) / rect.height) * 2 - 1),
    );
    const picked = controller.pickNdc(ndc);
    if (picked === null) {
      selectCar(null);
      selectSlot(null);
      return;
    }
    if (picked.kind === 'car') {
      selectCar(picked.carId);
      return;
    }
    selectSlot(picked.slotId);
  };

  return (
    <div className={`viewport ${viewMode === 'record' && idle ? 'idle' : ''}`}>
      {viewMode !== 'record' && (
        <div className="view-toolbar">
          <div className="segmented" role="group" aria-label="Chế độ xem">
            {VIEW_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                className={mode === viewMode ? 'active' : ''}
                onClick={() => setViewMode(mode)}
              >
                {VIEW_MODE_LABEL[mode]}
              </button>
            ))}
          </div>
          <div className="segmented" role="group" aria-label="Số camera">
            {(['1cam', '2cam'] as const).map((count) => (
              <button
                key={count}
                type="button"
                className={count === cameraCount ? 'active' : ''}
                onClick={() => setCameraCount(count)}
              >
                {count === '1cam' ? '1 cam' : '2 cam'}
              </button>
            ))}
          </div>
          {cameraCount === '1cam' && <p className="warn-note">{ONE_CAM_NOTE}</p>}
        </div>
      )}

      <div className={`canvas-holder ${viewMode === 'record' ? 'is-record' : ''}`}>
        <canvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          aria-label="Khung xem mô phỏng bãi xe"
        />
        {/*
          Lớp nhiễu camera (P14b): vẽ ảnh đã áp nhiễu lên trên canvas WebGL. WebGL context không
          đọc lại được pixel sau khi vẽ nếu thiếu `preserveDrawingBuffer`, nên phải vẽ sang canvas 2D
          rồi mới sửa pixel — đúng cách `exportAdapter` làm. `pointer-events: none` để click chọn
          xe/ô vẫn rơi vào canvas bên dưới.
        */}
        <canvas
          ref={noiseCanvasRef}
          className="viewport-noise"
          aria-hidden="true"
          style={{ display: 'none' }}
        />
        {/*
          Chỉ để e2e/QA đọc trạng thái frame ở chế độ Quay (không vẽ ra màn hình, không
          phải UI nhìn thấy). `data-frame` là frame GT đang hiện; `data-leader` là số frame
          đánh dấu còn lại.
        */}
        {viewMode === 'record' && (
          <span
            className="record-state"
            data-testid="record-state"
            data-frame={state?.frame ?? -1}
            data-leader={leaderFramesLeft}
            aria-hidden="true"
          />
        )}
        {lot === null && <div className="viewport-hint">Đang tải bản đồ…</div>}
        {lot !== null && !ready && renderError === null && (
          <div className="viewport-hint">Đang nạp model xe…</div>
        )}
        {renderError !== null && (
          <div className="viewport-error">Lỗi render: {renderError}</div>
        )}
        {viewMode === 'record' && leaderFramesLeft > 0 && (
          // C2: frame trắng in số frame đồng bộ. Chỉ ở đường phát hình — không vào video
          // xuất và không đổi GT (xem `store/recordLeader.ts`).
          <div className="record-leader" data-testid="record-leader">
            <span>{leaderLabel(leaderFramesLeft)}</span>
          </div>
        )}
      </div>

      {viewMode === 'record' && (
        <div className="record-hint">Quay màn hình · Space phát/dừng · Esc thoát</div>
      )}
      {viewMode === 'record' && (
        <label className="record-toggle">
          <input
            type="checkbox"
            checked={recordSyncLeader}
            onChange={(event) => {
              setRecordSyncLeader(event.target.checked);
            }}
          />
          3 frame đồng bộ
        </label>
      )}
    </div>
  );
}
