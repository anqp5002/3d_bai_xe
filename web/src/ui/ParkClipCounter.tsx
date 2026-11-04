/**
 * Bộ đếm `park_clip` của kịch bản (ANS_4 mục 4, P7d mục 3).
 *
 * `park_clip` = dung sai đã duyệt: khi xe vào/ra ô, đuôi xe được phép xuyên rất nhẹ vào xe
 * đỗ kề (ANS_4/5/6). Đây **không** phải lỗi, nhưng phải đếm được để QA biết cảnh có "dính"
 * hình hay không (detector/tracker có thể gộp khung nếu lấn nhiều).
 *
 * Component chỉ **đọc** `store.runLog` (tóm tắt tăng dần, P17n) và gọi `sim/parkClip` (không sửa `sim/`).
 */

import { useMemo } from 'react';
import { useThrottledVersion } from './useThrottledVersion';
import type { Warning } from '../contracts/sim';
import { useSimStore } from '../store/simStore';
import {
  PARK_CLIP_LONG_EPISODE_FRAMES,
  parkClipEpisodes,
  summarizeEpisodes,
} from '../sim/parkClip';

/** Ngưỡng cảnh báo hiển thị: đợt dài hơn 5 s (125 frame @ 25 fps). */
const LONG_EPISODE_FRAMES = PARK_CLIP_LONG_EPISODE_FRAMES;

export function ParkClipCounter() {
  const lot = useSimStore((store) => store.lot);
  const version = useSimStore((store) => store.runLogVersion);
  const hasState = useSimStore((store) => store.state !== null);
  // P17n: tính lại tối đa 2 lần/giây từ `runLog` (tóm tắt tăng dần), không duyệt cả lịch sử mỗi frame.
  const refreshed = useThrottledVersion(version, 500);

  const stats = useMemo(() => {
    if (lot === null || !hasState) {
      return null;
    }
    const log = useSimStore.getState().runLog.parkClip;
    const episodes = parkClipEpisodes(log.parkClip, lot);
    // ANS_13: leo thang tách riêng, kỳ vọng 0 — nếu > 0 là xe kẹt thật do xe đỗ ô kề.
    // Đổi nhãn ở biên vì `sim/parkClip` (không được sửa) chỉ gộp `kind === 'park_clip'`.
    const escalatedWarnings = log.escalated.map((warning): Warning => ({ ...warning, kind: 'park_clip' }));
    const escalated = parkClipEpisodes(escalatedWarnings, lot);
    return {
      summary: summarizeEpisodes(episodes),
      episodes,
      escalatedSummary: summarizeEpisodes(escalated),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lot, hasState, refreshed]);

  if (stats === null) {
    return (
      <p className="kv park-clip">
        <span>park_clip</span>
        <b>—</b>
      </p>
    );
  }

  const { summary, episodes, escalatedSummary } = stats;
  const byRow = Object.entries(summary.by_row)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([row, count]) => `hàng ${row}: ${String(count)}`)
    .join(' · ');

  return (
    <div className="park-clip">
      <p className="kv">
        <span>park_clip</span>
        <b>
          {summary.episodes} đợt · max {summary.max_depth_m.toFixed(3)} m
        </b>
      </p>
      {summary.episodes > 0 && (
        <>
          <p className="kv">
            <span>Frame lấn</span>
            <b>
              {summary.total_frames} frame (đợt dài nhất {summary.longest_frames})
            </b>
          </p>
          {byRow.length > 0 && (
            <p className="kv">
              <span>Theo hàng</span>
              <b>{byRow}</b>
            </p>
          )}
          {summary.long_episodes > 0 && (
            <p className="warn-note">
              {summary.long_episodes} đợt dài hơn {LONG_EPISODE_FRAMES} frame (
              {(LONG_EPISODE_FRAMES / 25).toFixed(0)} s) — xem `export_log.json` để biết chi tiết.
            </p>
          )}
          <details className="park-clip-detail">
            <summary>Chi tiết {episodes.length} đợt</summary>
            <ul>
              {episodes.slice(0, 20).map((episode) => (
                <li key={`${episode.car_id}-${String(episode.frame_first)}-${episode.neighbour_slot}`}>
                  {episode.car_id} → ô {episode.slot} (kề {episode.neighbour_slot} của{' '}
                  {episode.neighbour_car_id}) · frame {episode.frame_first}–
                  {episode.frame_last} ({episode.frame_count}) · sâu{' '}
                  {episode.max_depth_m.toFixed(3)} m · hàng {episode.row}
                </li>
              ))}
              {episodes.length > 20 && (
                <li>… và {episodes.length - 20} đợt nữa (đầy đủ trong `export_log.json`).</li>
              )}
            </ul>
          </details>
        </>
      )}
      {summary.episodes === 0 && (
        <p className="hint">Không có lần lấn nào — cảnh sạch (không xe nào chạm xe kề).</p>
      )}
      {/* ANS_13: leo thang là dấu hiệu kẹt thật (trần tạm 0,35 m), kỳ vọng 0. */}
      <p className={escalatedSummary.episodes > 0 ? 'warn-note' : 'kv'}>
        <span>park_clip_escalated</span>
        <b>
          {escalatedSummary.episodes} đợt · max {escalatedSummary.max_depth_m.toFixed(3)} m
          {escalatedSummary.total_frames > 0 ? ` · ${escalatedSummary.total_frames} frame` : ''}
        </b>
      </p>
      {escalatedSummary.episodes > 0 && (
        <p className="warn-note">
          Có leo thang ANS_13 — xe bị chặn chỉ bởi xe đỗ ô kề cùng hàng ≥ 4 s. Kỳ vọng 0 ở
          K2–K8; xem `export_log.json` mục `park_clip_escalated`.
        </p>
      )}
    </div>
  );
}
