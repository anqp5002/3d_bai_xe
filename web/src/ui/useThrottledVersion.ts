/**
 * Làm chậm một số phiên bản tăng dần (P17n): trả về giá trị mới nhất nhưng chỉ đổi tối đa mỗi
 * `intervalMs`. Dùng để UI không tính lại tóm tắt cảnh báo ở mỗi frame mô phỏng (25–100/giây).
 */

import { useEffect, useRef, useState } from 'react';

export function useThrottledVersion(value: number, intervalMs: number): number {
  const [shown, setShown] = useState(value);
  const lastChange = useRef(0);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (value === shown) {
      return undefined;
    }
    const wait = Math.max(0, lastChange.current + intervalMs - Date.now());
    if (wait === 0) {
      lastChange.current = Date.now();
      setShown(value);
      return undefined;
    }
    if (pending.current === null) {
      pending.current = setTimeout(() => {
        pending.current = null;
        lastChange.current = Date.now();
        setShown(value);
      }, wait);
    }
    return undefined;
  }, [value, shown, intervalMs]);

  useEffect(
    () => () => {
      if (pending.current !== null) {
        clearTimeout(pending.current);
      }
    },
    [],
  );

  return shown;
}
