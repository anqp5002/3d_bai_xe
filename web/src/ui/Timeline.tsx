/** Dòng thời gian dưới cùng (FE §2): Play/Pause, tốc độ, Về 0, tua nhanh, mốc sự kiện. */

import { useState } from 'react';
import { useSimStore } from '../store/simStore';
import { frameLabel } from '../store/scenarioModel';

const SPEEDS = [0.5, 1, 2, 4] as const;

export function Timeline() {
  const state = useSimStore((store) => store.state);
  const scenario = useSimStore((store) => store.scenario);
  const playing = useSimStore((store) => store.playing);
  const playbackSpeed = useSimStore((store) => store.playbackSpeed);
  const setPlaying = useSimStore((store) => store.setPlaying);
  const setPlaybackSpeed = useSimStore((store) => store.setPlaybackSpeed);
  const resetToZero = useSimStore((store) => store.resetToZero);
  const seekTo = useSimStore((store) => store.seekTo);
  const setError = useSimStore((store) => store.setError);

  const [seek, setSeek] = useState('');

  const frame = state?.frame ?? 0;
  const duration = scenario?.duration_frames ?? 0;
  const atEnd = duration > 0 && frame >= duration;
  const percent = duration > 0 ? Math.min(100, (frame / duration) * 100) : 0;
  const events = scenario?.events ?? [];

  const doSeek = (): void => {
    const target = Number.parseInt(seek, 10);
    if (!Number.isInteger(target)) {
      setError('Frame cần là số nguyên ≥ 0.');
      return;
    }
    seekTo(target);
  };

  return (
    <section className="timeline">
      <div className="timeline-row">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setPlaying(!playing)}
          disabled={state === null || scenario === null || (atEnd && !playing)}
        >
          {playing ? '⏸ Tạm dừng' : '▶ Phát'}
        </button>

        <label className="inline-field">
          <span>Tốc độ</span>
          <select
            value={playbackSpeed}
            onChange={(event) =>
              setPlaybackSpeed(Number(event.target.value) as 0.5 | 1 | 2 | 4)
            }
          >
            {SPEEDS.map((speed) => (
              <option key={speed} value={speed}>
                {speed}×
              </option>
            ))}
          </select>
        </label>

        <button type="button" className="btn" onClick={resetToZero} disabled={state === null}>
          Về 0
        </button>

        <label className="inline-field">
          <span>Tua tới frame</span>
          <input
            type="number"
            min={0}
            max={Math.max(0, duration)}
            step={1}
            value={seek}
            placeholder={String(frame)}
            onChange={(event) => setSeek(event.target.value)}
          />
        </label>
        <button type="button" className="btn" onClick={doSeek} disabled={state === null}>
          Tua
        </button>

        <span className="timeline-clock" title="25 fps cố định — dùng cho quay màn hình">
          {frameLabel(frame)} / {duration}
        </span>
      </div>

      <div
        className="timeline-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={duration}
        aria-valuenow={frame}
      >
        <div className="timeline-progress" style={{ width: `${percent}%` }} />
        {events.map((event, index) => (
          <span
            key={`${String(event.frame)}-${String(index)}`}
            className={`timeline-event ${event.type}`}
            style={{ left: `${duration > 0 ? (event.frame / duration) * 100 : 0}%` }}
            title={`${event.type} @ frame ${String(event.frame)}`}
          />
        ))}
      </div>

      <div className="timeline-foot">
        <span>{events.length} sự kiện trong nhật ký</span>
        <span>Bước sim cố định 25 fps (dt = 0,04 s), tất định theo seed.</span>
      </div>
    </section>
  );
}
