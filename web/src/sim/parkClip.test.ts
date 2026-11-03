/**
 * P5d — hợp đồng của `parkClip` (ANS_5): bảng ngưỡng theo hàng và cách gộp đợt.
 *
 * Đây là test **thuần dữ liệu** (không chạy sim) nên chạy nhanh: nó khoá đúng ba con số mà
 * director chốt (hàng 1–2 = 0,5 m; hàng 3–5 = 0,15 m) và ngữ nghĩa "đợt = các frame liền nhau
 * của cùng một cặp xe↔ô kề", để sau này không ai nới ngưỡng hay gộp sai mà không thấy.
 */

import { describe, expect, it } from 'vitest';
import type { LotMap } from '../contracts/lot';
import type { SlotId } from '../contracts/lot';
import type { Warning } from '../contracts/sim';
import currentLotJson from '../../../data/lot/lot_pucpr.json';
import {
  PARK_CLIP_LONG_EPISODE_FRAMES,
  PARK_CLIP_MAX_DEPTH_BY_ROW,
  PARK_CLIP_ROWS,
  maxDepthForRow,
  parkClipEpisodes,
  summarizeEpisodes,
} from './parkClip';

const lot = currentLotJson as unknown as LotMap;

function clip(
  frame: number,
  carId: string,
  slot: string,
  neighbour: string,
  depth: number,
): Warning {
  return {
    frame,
    kind: 'park_clip',
    message: 'test',
    car_id: carId,
    slot: slot as SlotId,
    neighbour_slot: neighbour as SlotId,
    neighbour_car_id: 'V999',
    depth_m: depth,
  };
}

describe('parkClip — bảng ngưỡng theo hàng (ANS_5)', () => {
  it('mọi hàng 0,15 m (ANS_6 mục 4: lot đã dời hàng 1 lên, dải A1 5,84 m)', () => {
    expect(PARK_CLIP_MAX_DEPTH_BY_ROW['1']).toBe(0.15);
    expect(PARK_CLIP_MAX_DEPTH_BY_ROW['2']).toBe(0.15);
    expect(PARK_CLIP_MAX_DEPTH_BY_ROW['3']).toBe(0.15);
    expect(PARK_CLIP_MAX_DEPTH_BY_ROW['4']).toBe(0.15);
    expect(PARK_CLIP_MAX_DEPTH_BY_ROW['5']).toBe(0.15);
    expect(maxDepthForRow('1')).toBe(0.15);
    expect(maxDepthForRow('3')).toBe(0.15);
    // Hàng lạ rơi về mức chặt nhất, không nới.
    expect(maxDepthForRow('9')).toBeLessThanOrEqual(0.15);
  });

  it('dung sai áp cho mọi hàng có trong bảng', () => {
    expect([...PARK_CLIP_ROWS].sort()).toEqual(['1', '2', '3', '4', '5']);
  });
});

describe('parkClip — gộp theo đợt lấn liên tiếp', () => {
  it('frame liền nhau cùng xe+ô kề gộp thành MỘT đợt, giữ tổng số frame', () => {
    // S052 là hàng 3 (ngưỡng 0,15) — dùng để kiểm cả nhánh ngưỡng chặt.
    const warnings = [
      clip(100, 'V001', 'S052', 'S051', 0.05),
      clip(101, 'V001', 'S052', 'S051', 0.12),
      clip(102, 'V001', 'S052', 'S051', 0.08),
    ];
    const episodes = parkClipEpisodes(warnings, lot);
    expect(episodes).toHaveLength(1);
    expect(episodes[0].frame_first).toBe(100);
    expect(episodes[0].frame_last).toBe(102);
    expect(episodes[0].frame_count).toBe(3);
    expect(episodes[0].max_depth_m).toBeCloseTo(0.12, 6);
    expect(episodes[0].row).toBe('3');
    const summary = summarizeEpisodes(episodes);
    expect(summary.episodes).toBe(1);
    expect(summary.total_frames).toBe(3);
    expect(summary.longest_frames).toBe(3);
  });

  it('cách quãng (không liền frame) là đợt mới', () => {
    const warnings = [
      clip(100, 'V001', 'S052', 'S051', 0.05),
      clip(150, 'V001', 'S052', 'S051', 0.06),
    ];
    const episodes = parkClipEpisodes(warnings, lot);
    expect(episodes).toHaveLength(2);
    expect(summarizeEpisodes(episodes).total_frames).toBe(2);
  });

  it('khác xe hoặc khác ô kề là đợt khác dù cùng frame', () => {
    const warnings = [
      clip(100, 'V001', 'S052', 'S051', 0.05),
      clip(100, 'V002', 'S052', 'S051', 0.05),
      clip(100, 'V001', 'S053', 'S052', 0.05),
    ];
    expect(parkClipEpisodes(warnings, lot)).toHaveLength(3);
  });

  it('phân bố theo hàng và đếm đợt dài > 5 s (125 frame @ 25 fps)', () => {
    const longRun: Warning[] = [];
    for (let frame = 0; frame <= PARK_CLIP_LONG_EPISODE_FRAMES; frame += 1) {
      longRun.push(clip(frame, 'V001', 'S052', 'S051', 0.05));
    }
    const shortRun = [clip(900, 'V002', 'S005', 'S006', 0.02)];
    const summary = summarizeEpisodes(
      parkClipEpisodes([...longRun, ...shortRun], lot),
    );
    expect(summary.episodes).toBe(2);
    expect(summary.longest_frames).toBe(PARK_CLIP_LONG_EPISODE_FRAMES + 1);
    expect(summary.long_episodes).toBe(1);
    // S052 = hàng 3, S005 = hàng 1.
    expect(summary.by_row).toEqual({ '3': 1, '1': 1 });
  });
});
