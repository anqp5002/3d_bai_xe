/**
 * Vòng lặp phát cố định 25 fps (FE §4.1, C2).
 *
 * Sim chỉ tiến theo `step` cố định; hook này chỉ quyết định **khi nào** gọi
 * `stepFrames` dựa trên `requestAnimationFrame` + bộ tích luỹ. Tốc độ 0,5×/1×/2×/4×
 * chỉ đổi số frame mỗi tick, không đổi `dt` của sim. Không dùng `Date.now`/`Math.random`
 * trong `sim/`.
 */

import { useEffect } from 'react';
import { useSimStore } from '../store/simStore';

const FRAME_MS = 1000 / 25;

export function usePlayback(): void {
  const playing = useSimStore((store) => store.playing);

  useEffect(() => {
    if (!playing) {
      return;
    }
    let raf = 0;
    let last = performance.now();
    let accumulator = 0;

    const tick = (now: number): void => {
      const store = useSimStore.getState();
      if (!store.playing) {
        return;
      }
      accumulator += (now - last) * store.playbackSpeed;
      last = now;
      const frames = Math.floor(accumulator / FRAME_MS);
      if (frames > 0) {
        accumulator -= frames * FRAME_MS;
        store.stepFrames(frames);
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [playing]);
}
