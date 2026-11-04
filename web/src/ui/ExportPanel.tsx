/** Nút Xuất + tiến độ + verify (FE §7; P9b mục 6). Dùng đường PNG của `runExport`. */

import { useEffect, useRef, useState } from 'react';
import type { Object3D } from 'three';
import type { CarModel } from '../contracts/sim';
import type { VerifyReport } from '../api/client';
import {
  describeGhostPasses,
  GHOST_OVERLOAD_MESSAGE,
  type ExportLog,
  type ExportOutput,
  type ExportProgress,
} from '../export/runExport';
import { useSimStore } from '../store/simStore';
import { loadCarTemplates } from './carAssets';
import { startScenarioExport, type ScenarioExportHandle } from './exportAdapter';
import { techgarImageSize } from '../export/techgarConfig';

const CAM_SIZE = techgarImageSize();
const CAM_LABEL = `${String(CAM_SIZE.width)}×${String(CAM_SIZE.height)}`;
const OUTPUTS: readonly ExportOutput[] = ['full', 'cam1', 'cam2'];
const OUTPUT_LABEL: Readonly<Record<ExportOutput, string>> = {
  full: 'full 640×640',
  cam1: `cam1 ${CAM_LABEL}`,
  cam2: `cam2 ${CAM_LABEL}`,
};
const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;

export function ExportPanel() {
  const lot = useSimStore((store) => store.lot);
  const scenario = useSimStore((store) => store.scenario);
  const cameraCount = useSimStore((store) => store.cameraCount);
  const setNotice = useSimStore((store) => store.setNotice);

  const [templates, setTemplates] = useState<ReadonlyMap<CarModel, Object3D> | null>(null);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [outputs, setOutputs] = useState<readonly ExportOutput[]>(OUTPUTS);
  const [name, setName] = useState('export-1');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [verify, setVerify] = useState<VerifyReport | null>(null);
  const [exportLog, setExportLog] = useState<ExportLog | null>(null);
  const [fallbackReasons, setFallbackReasons] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const handleRef = useRef<ScenarioExportHandle | null>(null);

  useEffect(() => {
    let alive = true;
    loadCarTemplates()
      .then((loaded) => {
        if (alive) {
          setTemplates(loaded);
        }
      })
      .catch((loadError: unknown) => {
        if (alive) {
          setTemplatesError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  const toggleOutput = (output: ExportOutput): void => {
    setOutputs((previous) =>
      previous.includes(output)
        ? previous.filter((item) => item !== output)
        : [...previous, output],
    );
  };

  const startExport = async (): Promise<void> => {
    if (lot === null || scenario === null || templates === null) {
      setError('Chưa tải xong bản đồ / model xe.');
      return;
    }
    if (scenario.duration_frames <= 0) {
      setError('Kịch bản không có frame nào để xuất.');
      return;
    }
    const chosen: readonly ExportOutput[] =
      cameraCount === '1cam' ? ['full'] : outputs;
    if (chosen.length === 0) {
      setError('Chọn ít nhất một đầu ra.');
      return;
    }
    if (!NAME_RE.test(name)) {
      setError('Tên lần xuất chỉ gồm A-Z a-z 0-9 _ - (1–40 ký tự).');
      return;
    }

    setRunning(true);
    setProgress(null);
    setVerify(null);
    setExportLog(null);
    setFallbackReasons([]);
    setError(null);

    let handle: ScenarioExportHandle;
    try {
      handle = startScenarioExport({
        lot,
        scenario,
        templates,
        outputs: chosen,
        name,
        onProgress: (value) => setProgress(value),
      });
    } catch (startError) {
      setRunning(false);
      setError(
        `Không bắt đầu được xuất: ${
          startError instanceof Error ? startError.message : String(startError)
        }`,
      );
      return;
    }

    handleRef.current = handle;
    try {
      const result = await handle.result;
      setVerify(result.verify);
      setExportLog(result.exportLog);
      setFallbackReasons([...handle.fallbackReasons]);
      setNotice(`Xuất xong ${result.runId} — verify ${result.verify.ok ? 'OK' : 'FAIL'}.`);
    } catch (exportError) {
      setFallbackReasons([...handle.fallbackReasons]);
      setError(
        `Xuất thất bại: ${
          exportError instanceof Error ? exportError.message : String(exportError)
        }`,
      );
    } finally {
      handleRef.current = null;
      setRunning(false);
    }
  };

  const cancel = (): void => {
    handleRef.current?.cancel();
    setNotice('Đang huỷ lần xuất…');
  };

  const percent =
    progress === null || progress.total <= 0
      ? 0
      : Math.min(100, (progress.frame / progress.total) * 100);

  return (
    <section className="panel-section">
      <h2>Xuất video</h2>

      <div className="field-row compact">
        <label className="field">
          <span>Tên lần xuất</span>
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={running}
          />
        </label>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            void startExport();
          }}
          disabled={running || lot === null || scenario === null || templates === null}
        >
          {running ? 'Đang xuất…' : 'Xuất'}
        </button>
        {running && (
          <button type="button" className="btn btn-danger" onClick={cancel}>
            Huỷ
          </button>
        )}
      </div>

      <div className="outputs">
        {OUTPUTS.map((output) => {
          const disabled = cameraCount === '1cam' && output !== 'full';
          return (
            <label key={output} className={`check ${disabled ? 'disabled' : ''}`}>
              <input
                type="checkbox"
                checked={cameraCount === '1cam' ? output === 'full' : outputs.includes(output)}
                disabled={disabled || running}
                onChange={() => toggleOutput(output)}
              />
              {OUTPUT_LABEL[output]}
            </label>
          );
        })}
      </div>
      {cameraCount === '1cam' && (
        <p className="hint">Chế độ 1 cam chỉ xuất full + GT (ANS_1 A.1).</p>
      )}
      <p className="hint">
        Xuất dùng <b>WebCodecs H.264 + mediabunny</b> (full 640×640 toàn cảnh + cam1/cam2 {CAM_LABEL}
        cho TechGAR). Nếu trình duyệt không encode được H.264 ở đầu ra nào, nút này tự
        chuyển PNG fallback và ghi rõ lý do bên dưới — không im lặng.
        {scenario !== null
          ? ` Kịch bản hiện tại: ${String(scenario.duration_frames)} frame (~${(
              scenario.duration_frames / 25
            ).toFixed(1)} s).`
          : ''}
      </p>
      {exportLog !== null && (
        <>
          <p className="hint">
            Đường xuất: <b>{exportLog.mode === 'webcodecs' ? 'WebCodecs + mediabunny' : 'PNG fallback'}</b>
            {exportLog.warnings.length > 0 ? ` · ${exportLog.warnings.join('; ')}` : ''}
          </p>
          {/* P7d mục 3: đợt `park_clip` của lần xuất (ANS_4 mục 4). */}
          <p className="hint">
            park_clip lần xuất:{' '}
            <b>
              {exportLog.park_clip.summary.episodes} đợt · max{' '}
              {exportLog.park_clip.summary.max_depth_m.toFixed(3)} m
            </b>
            {exportLog.park_clip.summary.total_frames > 0
              ? ` · ${exportLog.park_clip.summary.total_frames} frame`
              : ''}
          </p>
          {/*
            P10e / ANS_13 mục 3: leo thang `park_clip_escalated`. Kỳ vọng 0 ở K2–K8; nếu > 0
            phải hiện rõ (không im lặng) vì đó là dấu hiệu hình học bị kẹt thật.
          */}
          <p className={exportLog.park_clip_escalated.summary.episodes > 0 ? 'warn-note' : 'hint'}>
            park_clip_escalated (ANS_13):{' '}
            <b>
              {exportLog.park_clip_escalated.summary.episodes} đợt · max{' '}
              {exportLog.park_clip_escalated.summary.max_depth_m.toFixed(3)} m
            </b>
            {exportLog.park_clip_escalated.summary.total_frames > 0
              ? ` · ${exportLog.park_clip_escalated.summary.total_frames} frame`
              : ' · đúng kỳ vọng 0'}
          </p>
        </>
      )}
      {exportLog !== null && exportLog.ghost_passes.length > 0 && (
        <p className="ghost-alert" role="alert">
          <b>⚠ VIDEO CÓ XE ĐI XUYÊN NHAU — {GHOST_OVERLOAD_MESSAGE}.</b>{' '}
          {describeGhostPasses(exportLog.ghost_passes)}
        </p>
      )}
      {fallbackReasons.length > 0 && (
        <p className="warn-note">
          WebCodecs không dùng được: {fallbackReasons.join('; ')}
        </p>
      )}
      {templatesError !== null && (
        <p className="error">Không nạp được model xe: {templatesError}</p>
      )}
      {error !== null && <p className="error">{error}</p>}

      {(progress !== null || running) && (
        <div className="export-progress">
          <div className="progress">
            <div style={{ width: `${percent}%` }} />
          </div>
          <p className="hint">
            {progress === null
              ? 'Đang chuẩn bị…'
              : `${String(progress.frame)}/${String(progress.total)} frame · ${progress.realtimeRatio.toFixed(2)}× thời gian thực${
                  progress.paused ? ' · tạm dừng (tab ẩn)' : ''
                }`}
          </p>
        </div>
      )}

      {verify !== null && (
        <div className={`verify ${verify.ok ? 'ok' : 'bad'}`}>
          <p>
            <b>verify {verify.ok ? 'OK' : 'FAIL'}</b> · {verify.run_id} ·{' '}
            {verify.realtime_ratio.toFixed(2)}×
          </p>
          <ul>
            {verify.items.map((item) => (
              <li key={item.id} className={item.ok ? 'ok' : 'bad'}>
                {item.id}. {item.detail}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
