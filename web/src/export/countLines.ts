/**
 * Vạch đếm (count line) — **khác** vạch cổng vẽ trên cảnh (ANS_14 = phương án A, P11).
 *
 * Vấn đề thật (đo ở `sim3d/tools/measure_count_lines.py`, 3 run K2/K4/K6):
 * cổng vẽ nằm sát mép khung (`u = 630` vào, `u = 4` ra). TechGAR chỉ cấp Global ID khi
 * tracker đã bám được vài frame, nên lúc có ID thì xe **đã đi qua vạch cổng**:
 *
 * - 9 mẫu cấp ID vào: `x = +25,82 .. +31,89` m, trong khi cổng vẽ ở `x = +36,21` m.
 * - 10 mẫu mất ID ra: `x = −34,93 .. −25,93` m, trong khi cổng vẽ ở `x = −36,92` m.
 *
 * Vì vậy `gate_session_controller` không thấy cú cắt cổng nào ⇒ đếm 0 (đo P10e). Hệ thống
 * thật cũng phải đặt vạch đếm ở chỗ tracker **đã có ID**, nên đây là lỗi cấu hình chứ không
 * phải giới hạn của TechGAR.
 *
 * Cách xử (ANS_14): **chỉ ở phía export**, dẫn xuất vạch đếm từ `lot.gates` — không sửa
 * `lot_pucpr.json`, không sửa làn, không sửa cổng vẽ.
 *
 * Công thức vạch (đo được, xem `tools/out/count_lines.json`):
 * - Vào: phải sâu hơn điểm cấp ID **muộn nhất** (`+25,82 m`) thêm **1 chiều dài xe** (5,17 m
 *   với SUV ×1,1) ⇒ `x ≤ +20,65 m`.
 * - Ra: phải nông hơn điểm mất ID **sớm nhất** (`−25,93 m`) bớt 1 chiều dài xe ⇒
 *   `x ≥ −20,76 m`.
 *
 * Chọn `|x| = 20,05 m` cho cả hai (biên còn 0,6 m mỗi bên, đối xứng, dễ đọc).
 *
 * Kiểm L-GATE cho vạch đếm: tại `x = ±20,05 m` trên lối giữa (y = 3,2 m), mọi làn khác cách
 * **≥ 10,0 m** tính cả nửa bề rộng (xa hơn ngưỡng 2,0 m rất nhiều) — chỉ làn A2 cắt vạch.
 */

import type { LotMap } from '../contracts/lot';
import { GATE_NOTES, type GateNote } from '../contracts/gt';
import type { Vec2 } from '../contracts/lot';

/**
 * Hoành độ vạch đếm, mét (world X của `lot`).
 *
 * Dấu: xe đi từ `+x` sang `−x` (C6, hướng tây). Vào ở `+`, ra ở `−`.
 *
 * **Một nguồn sự thật:** số này trùng `sim3d/data/lot/count_lines.json`
 * (`count_line_abs_x_m`), do `sim3d/tools/measure_count_lines.py` sinh/bảo trì từ 3 run
 * K2/K4/K6. `countLines.test.ts` canh hai bên khớp nhau, `test_count_lines.py` đọc file JSON
 * để kiểm L-GATE — nên đổi số thì phải đổi cả hai, test sẽ bắt nếu lệch.
 */
export const COUNT_LINE_ABS_X_M = 20.05;

/** Biên còn lại so với ràng buộc đo được, mét (để REPORT đối chiếu). */
export const COUNT_LINE_MARGIN_M = 0.6;

/**
 * Vạch đếm dựng thành **đoạn thẳng** theo đúng hình dạng cổng vẽ, nên `direction` tính bằng
 * cùng công thức ⇒ giữ nguyên chiều.
 *
 * Lấy `y` của hai đầu đoạn từ chính cổng (`p1.y`, `p2.y`) và chỉ thay `x`. Nhờ vậy đoạn vạch
 * vẫn nằm ngang qua lối giữa, song song với vạch cổng vẽ, chỉ dịch vào trong.
 */
export function countLineFor(gate: { readonly p1: Vec2; readonly p2: Vec2 }, xM: number): {
  readonly p1: Vec2;
  readonly p2: Vec2;
} {
  return {
    p1: [xM, gate.p1[1]],
    p2: [xM, gate.p2[1]],
  };
}

export interface CountLines {
  readonly entry: { readonly p1: Vec2; readonly p2: Vec2 };
  readonly exit: { readonly p1: Vec2; readonly p2: Vec2 };
  /** Vạch cổng vẽ (giữ để ghi vào README/MANIFEST và đối chiếu). */
  readonly drawn: {
    readonly entry: { readonly p1: Vec2; readonly p2: Vec2 };
    readonly exit: { readonly p1: Vec2; readonly p2: Vec2 };
  };
}

/**
 * Dẫn xuất hai vạch đếm từ `lot.gates` (không sửa lot).
 *
 * **Dấu của `x` lấy theo phía của cổng vật lý**, không hard-code: bãi PUCPR có cổng vào ở
 * phía đông (`+x`) và cổng ra ở phía tây (`-x`), nhưng lot test thì ngược lại. Vạch đếm
 * luôn nằm **cùng phía với cổng của nó**, chỉ dịch vào trong.
 */
export function buildCountLines(lot: LotMap): CountLines {
  const entryX = Math.sign(lot.gates.in.p1[0]) * COUNT_LINE_ABS_X_M || COUNT_LINE_ABS_X_M;
  const exitX = Math.sign(lot.gates.out.p1[0]) * COUNT_LINE_ABS_X_M || -COUNT_LINE_ABS_X_M;
  return {
    entry: countLineFor(lot.gates.in, entryX),
    exit: countLineFor(lot.gates.out, exitX),
    drawn: {
      entry: { p1: lot.gates.in.p1, p2: lot.gates.in.p2 },
      exit: { p1: lot.gates.out.p1, p2: lot.gates.out.p2 },
    },
  };
}

/** Hai điểm có nằm hai bên đường thẳng `a→b` (tức đoạn `from→to` cắt vạch) không. */
export function crossesLine(
  from: Vec2,
  to: Vec2,
  line: { readonly p1: Vec2; readonly p2: Vec2 },
): boolean {
  const side = (point: Vec2): number =>
    (line.p2[0] - line.p1[0]) * (point[1] - line.p1[1]) -
    (line.p2[1] - line.p1[1]) * (point[0] - line.p1[0]);
  const a = side(from);
  const b = side(to);
  return a * b < 0;
}

/** Chiều cắt vạch: dấu của tích chéo, để kiểm `direction` đúng chiều. */
export function crossingSign(
  from: Vec2,
  to: Vec2,
  line: { readonly p1: Vec2; readonly p2: Vec2 },
): number {
  const gx = line.p2[0] - line.p1[0];
  const gy = line.p2[1] - line.p1[1];
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  return dx * gy - dy * gx;
}

/**
 * `lot` với `gates` thay bằng **vạch đếm** (ANS_14/P11), để `sim/gtCompute.gtEvents` tính
 * `gate_in_frame`/`gate_out_frame` tại vạch đếm mà **không phải sửa `sim/`**.
 *
 * `gtEvents` đọc `lot.gates.*.p1/p2` nội bộ. Các trường khác của `Gate` (`spawn`, `despawn`,
 * `p1_px`…) chỉ `sim/` dùng cho đường đi, không liên quan GT cổng — giữ nguyên nên an toàn.
 */
export function lotWithCountLines(lot: LotMap, lines: CountLines): LotMap {
  return {
    ...lot,
    gates: {
      in: { ...lot.gates.in, p1: lines.entry.p1, p2: lines.entry.p2 },
      out: { ...lot.gates.out, p1: lines.exit.p1, p2: lines.exit.p2 },
    },
  };
}

/**
 * Đọc `data/lot/count_slots.json` (sinh bởi `countSlots.test.ts` từ lộ trình thật) thành
 * `Map<slotId, GateNote>` để `gtEvents` để rỗng cột cổng + ghi lý do (P11c mục 2).
 *
 * Trả `null` nếu chưa có file — khi đó **không** ô nào bị cờ và GT giữ nguyên hành vi cũ.
 * Caller (export) phải tự quyết có coi đó là lỗi hay không; ở `runExport` ta **bắt buộc**
 * có file vì GT sai âm thầm còn tệ hơn lỗi rõ ràng (R2).
 */
export function gateNotesFrom(
  payload: {
    readonly flagged?: readonly { readonly slot: string; readonly flag?: string | null }[];
  } | null,
): Map<string, GateNote> {
  const notes = new Map<string, GateNote>();
  if (payload === null || payload.flagged === undefined) {
    return notes;
  }
  for (const item of payload.flagged) {
    const flag = item.flag ?? null;
    if (flag === null) {
      continue;
    }
    if (!GATE_NOTES.includes(flag as GateNote)) {
      throw new Error(`count_slots.json: cờ lạ "${flag}" (không có trong GATE_NOTES)`);
    }
    notes.set(item.slot, flag as GateNote);
  }
  return notes;
}

/**
 * Chiều của từng vạch đếm, tính **đúng công thức** `gateDirection` của
 * `techgarBundle` (tích chéo giữa hướng xe và pháp tuyến đoạn vạch).
 *
 * Vì sao phải tính: dấu phụ thuộc **thứ tự y của p1/p2**. Lot thật có `p1.y > p2.y`
 * (p1 ở bắc), còn lot test thì ngược lại — hard-code `positive` là sai một trong hai.
 * `gate_zones.json` và GT lời giải phải dùng **cùng** hàm này thì mới không lệch.
 */
export function countLineDirection(
  lot: LotMap,
): { readonly entry: 'positive' | 'negative'; readonly exit: 'positive' | 'negative' } {
  const lines = buildCountLines(lot);
  return {
    entry: directionFor(lines.entry, gateTravel(lot.gates.in)),
    exit: directionFor(lines.exit, gateTravel(lot.gates.out)),
  };
}

/** Hướng xe đi qua cổng: `despawn - spawn` (C6: về tây). */
function gateTravel(gate: {
  readonly spawn: readonly [number, number, number];
  readonly despawn: Vec2;
}): Vec2 {
  return [gate.despawn[0] - gate.spawn[0], gate.despawn[1] - gate.spawn[1]];
}

/** Dấu tích chéo giữa hướng xe và đoạn vạch (`positive` = xe đi sang phải p1→p2). */
function directionFor(
  line: { readonly p1: Vec2; readonly p2: Vec2 },
  travel: Vec2,
): 'positive' | 'negative' {
  const gx = line.p2[0] - line.p1[0];
  const gy = line.p2[1] - line.p1[1];
  const cross = travel[0] * gy - travel[1] * gx;
  if (Math.abs(cross) < 1e-12) {
    throw new Error('countLineDirection: hướng xe song song với vạch đếm');
  }
  return cross > 0 ? 'positive' : 'negative';
}
