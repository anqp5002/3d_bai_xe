/**
 * Cảnh báo ĐỎ khi engine phải dùng `ghost_pass` (xe đi xuyên nhau) — ANS_29.
 *
 * Xe xuyên nhau là lỗi rất nặng cho video/ground truth, nên không bao giờ được im lặng: hiện ngay
 * trên thanh trạng thái, ghi rõ xe nào, frame nào. `verify` lúc xuất cũng FAIL (xem `runExport`).
 */

import { useMemo } from 'react';
import { useThrottledVersion } from './useThrottledVersion';
import { useSimStore } from '../store/simStore';
import { GHOST_OVERLOAD_MESSAGE } from '../export/runExport';

/** Cảnh báo cập nhật tối đa mỗi ngần này ms (không tính lại mỗi frame). */
const REFRESH_MS = 500;

export function GhostPassAlert() {
  const version = useSimStore((store) => store.runLogVersion);
  const version500 = useThrottledVersion(version, REFRESH_MS);

  // P17n: đọc tóm tắt tăng dần (`runLog`), KHÔNG duyệt lại cả lịch sử mỗi frame.
  const rows = useMemo(
    () => useSimStore.getState().runLog.ghost.snapshot().sort((a, b) => a.start_frame - b.start_frame),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version500],
  );

  if (rows.length === 0) {
    return null;
  }
  const shown = rows
    .slice(0, 4)
    .map(
      (row) =>
        `${row.car_id} f${String(row.start_frame)}–${String(row.end_frame)} (chồng ${row.depth_max_m.toFixed(2)} m)`,
    )
    .join(' · ');
  return (
    <p className="ghost-alert" role="alert">
      <b>⚠ XE ĐI XUYÊN NHAU — {GHOST_OVERLOAD_MESSAGE}.</b> {String(rows.length)} xe lách: {shown}
      {rows.length > 4 ? ` · … (+${String(rows.length - 4)})` : ''}
    </p>
  );
}
