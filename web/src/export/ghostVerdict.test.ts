import { describe, expect, it } from 'vitest';
import type { VerifyReport } from '../api/client';
import {
  GHOST_OVERLOAD_MESSAGE,
  GHOST_VERIFY_ITEM_ID,
  describeGhostPasses,
  withGhostPassVerdict,
} from './runExport';

const verify: VerifyReport = {
  ok: true,
  run_id: 'r1',
  generated_at: '2026-11-04T00:00:00Z',
  items: [{ id: 1, ok: true, detail: 'ok' }],
  export_seconds: 1,
  realtime_ratio: 1,
};

describe('ANS_29: ghost_pass làm verify FAIL', () => {
  it('không có lách thì giữ nguyên verify', () => {
    expect(withGhostPassVerdict(verify, [])).toBe(verify);
  });

  it('có lách thì ok=false, thêm mục nêu xe, frame và câu giãn nhịp', () => {
    const passes = [
      { car_id: 'V044', start_frame: 100, end_frame: 160, through: ['V022'], depth_max_m: 1.8 },
    ];
    const result = withGhostPassVerdict(verify, passes);
    expect(result.ok).toBe(false);
    const added = result.items[result.items.length - 1];
    expect(added.id).toBe(GHOST_VERIFY_ITEM_ID);
    expect(added.ok).toBe(false);
    expect(added.detail).toContain('V044');
    expect(added.detail).toContain('frame 100–160');
    expect(added.detail).toContain(GHOST_OVERLOAD_MESSAGE);
    expect(describeGhostPasses(passes)).toContain('xuyên V022');
  });

  it('rút gọn khi quá 6 lần', () => {
    const passes = Array.from({ length: 9 }, (_, index) => ({
      car_id: `V${String(index + 1).padStart(3, '0')}`,
      start_frame: index,
      end_frame: index + 1,
      through: ['V100'],
      depth_max_m: 1,
    }));
    expect(describeGhostPasses(passes)).toContain('+3 lần nữa');
  });
});
