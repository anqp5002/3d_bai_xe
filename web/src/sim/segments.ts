/**
 * P17 (ANS_36 + ANS_37) — điều phối **không lách**: chuỗi xe, bám xe kiểu IDM, lùi dây chuyền.
 *
 * Vì sao có module này: `ghost_pass` (xe xuyên thân xe khác) bị cấm. Khi tắt nó, mọi khoá còn
 * lại phải được gỡ bằng luật ứng xử thật ngoài đời:
 *
 * 1. **Mỗi xe biết xe trước/xe sau** trên làn (`leader_id`/`follower_id`).
 * 2. **IDM** (Intelligent Driver Model): khoảng cách mong muốn `s* = s0 + v·T + v·Δv/(2√(a·b))`,
 *    nên xe sau tự giảm tốc êm từ xa, không nhanh hơn xe trước khi đã gần, và tăng tốc lại khi thoáng.
 * 3. **Lùi dây chuyền**: xe trước bị chắn bởi chính thân xe đang nằm SAU nó (ca nhập làn: xe từ
 *    V_far_w cua vào A2 nhưng đầu hàng A2 đứng sát điểm nhập) thì xe sau lùi nhường; nếu xe sau lại bị
 *    xe sát phía sau cản thì nó truyền yêu cầu lùi xuống (`back_demand`) — xe CUỐI CHUỖI lùi trước.
 *    Không có vòng: yêu cầu chỉ đi từ xe trước xuống xe sau (một chiều theo chuỗi).
 *
 * Hàm ở đây thuần dữ liệu (không đọc đồng hồ/RNG) nên tất định.
 */

/** Tham số IDM. */
export interface IdmParams {
  /** Khoảng hở tối thiểu khi dừng, m. */
  readonly s0: number;
  /** Khoảng thời gian bám xe, s. */
  readonly timeHeadway: number;
  /** Gia tốc tối đa, m/s². */
  readonly aMax: number;
  /** Giảm tốc êm, m/s². */
  readonly bComf: number;
  /** Số mũ gia tốc tự do. */
  readonly delta: number;
}

export const IDM_DEFAULT: IdmParams = {
  s0: 1.0,
  timeHeadway: 0.8,
  aMax: 1.5,
  bComf: 1.5,
  delta: 4,
};

/** Ngưỡng "phanh gấp": giảm tốc vượt `2 × b_comf` (ANS_37 mục 6). */
export const HARSH_BRAKE_MPS2 = 2 * IDM_DEFAULT.bComf;

/**
 * Gia tốc IDM, m/s² (có thể âm).
 *
 * @param v      tốc độ xe sau, m/s (≥ 0)
 * @param v0     tốc độ mong muốn, m/s (> 0)
 * @param gap    khoảng hở cản-cản tới xe trước, m (`Infinity` = không có xe trước)
 * @param vLead  tốc độ xe trước, m/s
 */
export function idmAcceleration(
  v: number,
  v0: number,
  gap: number,
  vLead: number,
  params: IdmParams = IDM_DEFAULT,
): number {
  const speed = Math.max(0, v);
  const free = 1 - Math.pow(speed / Math.max(v0, 1e-6), params.delta);
  if (!Number.isFinite(gap)) {
    return params.aMax * free;
  }
  const dv = speed - Math.max(0, vLead);
  const sStar =
    params.s0 +
    Math.max(0, speed * params.timeHeadway + (speed * dv) / (2 * Math.sqrt(params.aMax * params.bComf)));
  const safeGap = Math.max(gap, 0.05);
  return params.aMax * (free - (sStar / safeGap) * (sStar / safeGap));
}

/**
 * Tốc độ mục tiêu cho bước kế tiếp theo IDM: `v + a·dt` kẹp trong `[0, v0]`.
 * Giảm tốc bị chặn ở `-4·b_comf` (phanh khẩn cấp, vẫn hữu hạn).
 */
export function idmTargetSpeed(
  v: number,
  v0: number,
  gap: number,
  vLead: number,
  dtS: number,
  params: IdmParams = IDM_DEFAULT,
): number {
  const accel = Math.max(-4 * params.bComf, idmAcceleration(v, v0, gap, vLead, params));
  return Math.min(Math.max(v0, 0), Math.max(0, Math.max(0, v) + accel * dtS));
}

/** Một xe trong chuỗi làn (toạ độ dọc làn đã đo sẵn). */
export interface ChainCar {
  readonly id: string;
  /** Vị trí dọc làn, m (lớn hơn = ở xa hơn theo hướng đi). */
  readonly s: number;
}

export interface ChainLinks {
  readonly leader: ReadonlyMap<string, string>;
  readonly follower: ReadonlyMap<string, string>;
}

/**
 * Dựng quan hệ trước/sau từ danh sách xe đã đo `s` dọc cùng một làn (hoặc một chuỗi làn nối
 * tiếp). Xe có `s` lớn hơn liền kề là `leader`. `s` trùng → id nhỏ hơn đi trước (tất định).
 */
export function buildChain(cars: readonly ChainCar[]): ChainLinks {
  const ordered = [...cars].sort((a, b) => (a.s !== b.s ? b.s - a.s : a.id < b.id ? -1 : 1));
  const leader = new Map<string, string>();
  const follower = new Map<string, string>();
  for (let index = 1; index < ordered.length; index += 1) {
    leader.set(ordered[index].id, ordered[index - 1].id);
    follower.set(ordered[index - 1].id, ordered[index].id);
  }
  return { leader, follower };
}

/** Trạng thái tối thiểu của một xe cho quyết định lùi. */
export interface BackCandidate {
  readonly id: string;
  /** Đang bị chặn bởi thân xe `blocked_by` nằm sau nó. */
  readonly blockedBy?: string;
  /** Được yêu cầu lùi nhưng chưa lùi được (kỳ trước). */
  readonly backDemand?: boolean;
}

/**
 * Xe `car` có phải lùi trong frame này không?
 *
 * Có khi: (a) xe đứng ngay trước nó (`leaderId`) đang bị CHÍNH nó chặn (`blockedBy === car.id`), hoặc
 * (b) xe đứng ngay trước đang `back_demand` (không lùi được) — truyền yêu cầu xuống chuỗi.
 */
export function shouldBackOff(
  car: BackCandidate,
  leader: BackCandidate | undefined,
  others: readonly BackCandidate[],
): boolean {
  if (others.some((other) => other.blockedBy === car.id)) {
    return true;
  }
  return leader?.backDemand === true;
}

/**
 * Xe bị chặn bởi xe `blocker` nằm sau nó, mà `blocker` KHÔNG lùi được (kẹt vì hàng chờ phía sau) ⇒ chính xe
 * bị chặn phải lùi để nhường đường (nhả khoá hai xe cua nhập làn vào nhau).
 */
export function shouldYieldByBacking(
  car: BackCandidate,
  blocker: BackCandidate | undefined,
): boolean {
  return car.blockedBy !== undefined && blocker?.id === car.blockedBy && blocker.backDemand === true;
}

/**
 * Thứ tự lùi của một chuỗi khi `head` cần chỗ: từ xe CUỐI chuỗi lên tới `head`'s follower.
 * (Dùng để test/hiển thị; engine thực thi từng xe một theo `shouldBackOff`.)
 */
export function backOffOrder(chain: readonly ChainCar[], head: string): readonly string[] {
  const ordered = [...chain].sort((a, b) => (a.s !== b.s ? b.s - a.s : a.id < b.id ? -1 : 1));
  const headIndex = ordered.findIndex((car) => car.id === head);
  if (headIndex < 0) {
    return [];
  }
  return ordered
    .slice(headIndex + 1)
    .map((car) => car.id)
    .reverse();
}

/** Số lần phanh gấp trong một chuỗi tốc độ (m/s) lấy mẫu mỗi `dtS`. */
export function countHarshBrakes(speeds: readonly number[], dtS: number): number {
  let count = 0;
  let braking = false;
  for (let index = 1; index < speeds.length; index += 1) {
    const decel = (speeds[index - 1] - speeds[index]) / dtS;
    const harsh = decel > HARSH_BRAKE_MPS2;
    if (harsh && !braking) {
      count += 1;
    }
    braking = harsh;
  }
  return count;
}

// ---------------------------------------------------------------------------------------------
// Nút hợp lưu (merge cell) — "hộp vàng" ở chỗ hai dòng xe nhập làn.
// ---------------------------------------------------------------------------------------------

import type { Vec2 } from '../contracts/lot';
import type { RoadNetwork } from './network';
import { pointAtDistance } from './geometry';

/** Bán kính vùng nhập làn, m (đủ phủ cung quét của xe cua vào làn + nửa thân xe). */
export const MERGE_CELL_RADIUS_M = 5.5;

export interface MergeCell {
  readonly id: string;
  readonly point: Vec2;
}

/** Các nút có ≥ 2 làn khác nhau cùng đổ vào (nhập làn/cắt ngang). Tất định theo id nút. */
export function findMergeCells(network: RoadNetwork): readonly MergeCell[] {
  const incoming = new Map<string, Set<string>>();
  for (const edge of network.edges) {
    const set = incoming.get(edge.to);
    if (set === undefined) {
      incoming.set(edge.to, new Set([edge.aisle_id]));
    } else {
      set.add(edge.aisle_id);
    }
  }
  const cells: MergeCell[] = [];
  for (const [nodeId, aisles] of [...incoming.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (aisles.size < 2) {
      continue;
    }
    const node = network.nodeById.get(nodeId);
    if (node !== undefined) {
      cells.push({ id: nodeId, point: node.point });
    }
  }
  return cells;
}

/** Lộ trình đi qua một nút hợp lưu: ở quãng `sNode`, hướng vào `inDir` (đơn vị). */
export interface RouteCellPass {
  readonly cell: MergeCell;
  readonly sNode: number;
  readonly inDir: Vec2;
}

/** Tìm các nút hợp lưu mà lộ trình đi qua (so khớp đỉnh ≤ 0,05 m). Kết quả nên được nhớ theo route. */
export function routeCellPasses(
  positions: readonly Vec2[],
  cells: readonly MergeCell[],
): readonly RouteCellPass[] {
  const passes: RouteCellPass[] = [];
  if (positions.length < 2 || cells.length === 0) {
    return passes;
  }
  const cumulative: number[] = [0];
  for (let index = 1; index < positions.length; index += 1) {
    cumulative.push(
      cumulative[index - 1] +
        Math.hypot(
          positions[index][0] - positions[index - 1][0],
          positions[index][1] - positions[index - 1][1],
        ),
    );
  }
  for (const cell of cells) {
    // Điểm gần nút nhất trên lộ trình (lộ trình có thể bỏ qua đỉnh trung gian của làn thẳng).
    let bestDist = Number.POSITIVE_INFINITY;
    let bestS = 0;
    for (let index = 1; index < positions.length; index += 1) {
      const a = positions[index - 1];
      const b = positions[index];
      const ex = b[0] - a[0];
      const ey = b[1] - a[1];
      const len2 = ex * ex + ey * ey;
      if (len2 < 1e-12) {
        continue;
      }
      const t = Math.max(0, Math.min(1, ((cell.point[0] - a[0]) * ex + (cell.point[1] - a[1]) * ey) / len2));
      const px = a[0] + ex * t;
      const py = a[1] + ey * t;
      const dist = Math.hypot(px - cell.point[0], py - cell.point[1]);
      if (dist < bestDist - 1e-9) {
        bestDist = dist;
        bestS = cumulative[index - 1] + Math.sqrt(len2) * t;
      }
    }
    if (bestDist > 0.3) {
      continue;
    }
    const back = pointAtDistance([...positions], Math.max(0, bestS - 4)).point;
    const near = pointAtDistance([...positions], Math.max(0, bestS - 0.5)).point;
    const dx = near[0] - back[0];
    const dy = near[1] - back[1];
    const norm = Math.hypot(dx, dy);
    if (norm < 1e-6) {
      continue;
    }
    passes.push({ cell, sNode: bestS, inDir: [dx / norm, dy / norm] });
  }
  return passes;
}
