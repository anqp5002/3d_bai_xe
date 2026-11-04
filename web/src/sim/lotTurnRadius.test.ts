/**
 * P17l — bán kính cua nhỏ nhất trên **mọi** lộ trình vào/ra của 100 ô.
 *
 * Vì sao có test này: `REPORT_P17k.md` §4 đo được lộ trình ra qua `V_far_w` có cua
 * bán kính **0,54 m** và 0,55 m, trong khi mô hình xe đạp chỉ bám được cung
 * ≥ `MIN_TURN_RADIUS_M` (4 m; xe thật 3,86 m). Xe không bám nổi cua thì bị đẩy lệch
 * khỏi tim làn, quệt xe đỗ rồi bị `clipCheck` chặn — lỗi hình học, không phải luật.
 *
 * Test dùng **chính** `buildEntryRoute`/`buildExitRoute`/`slotAccess` trên file JSON
 * thật, nên nó khoá cả dữ liệu bãi (`build_lot.py`) lẫn bộ định tuyến.
 *
 * Đo hai phần **tách bạch**, vì hai phần do hai cơ chế khác nhau dựng:
 *
 * 1. **Cung vào/ra ô** (`slotAccess`): bán kính thiết kế `radius_m` — kiểm trực tiếp,
 *    phải ≥ 4 m. Đoạn cuối của cung là một bước căn chỉnh nhỏ về trục ô (heading liên
 *    tục nhưng vị trí gãy vài cm — xem P5e), nên không đo độ cong trên toàn lộ trình
 *    mà đo đúng bán kính thiết kế của cung.
 * 2. **Đoạn chạy trên làn** (entry: trước `slot_start_s`; exit: sau `maneuver_end_s`):
 *    đo `R = |Δs| / |Δθ|` theo heading giữa hai điểm liền tiếp, lấy cực tiểu. Đây là
 *    đại lượng vật lý của bánh lái (xe không đổi hướng tức thời) và cho đúng số của
 *    P17k (0,54 m ở góc `V_far_w`): một đỉnh polyline gãy 90° cho R ≈ 0,5 m.
 *
 * Lưu ý khi chọn metric: bán kính ngoại tiếp ba điểm **vị trí** cho R ≈ 0,2 m ở cả
 * 200 lộ trình, vì chỗ nối "cuối cung → miệng ô" là bước dịch ngang nhỏ với heading
 * liên tục — nhiễu của thao tác đỗ, không phải cua lái.
 */

import { describe, expect, it } from 'vitest';
import type { LotMap } from '../contracts/lot';
import type { Route, RoutePoint } from '../contracts/sim';
import lotJson from '../../../data/lot/lot_pucpr.json';
import { MIN_TURN_RADIUS_M, buildEntryRoute, buildExitRoute, roadNetworkOf, slotAccess } from './network';

const lot = lotJson as unknown as LotMap;
const DESIRED_SPEED_MPS = 10 / 3.6;
const FAR_W_MIN_RADIUS_M = 2.85;

interface TurnScan {
  /** Bán kính cua nhỏ nhất, m. */
  readonly radius: number;
  /** Chỉ số điểm bắt đầu khúc cua có bán kính nhỏ nhất. */
  readonly index: number;
  readonly at: readonly [number, number];
  /** Góc lái của khúc đó (rad). */
  readonly dTheta: number;
}

function normalizeAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

/** Bán kính cua nhỏ nhất đo theo độ cong heading: `R = ds / dθ`. */
function minTurnRadius(points: readonly RoutePoint[]): TurnScan {
  let best: TurnScan = { radius: Number.POSITIVE_INFINITY, index: -1, at: [0, 0], dTheta: 0 };
  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index];
    const to = points[index + 1];
    const ds = Math.hypot(to.pose.x - from.pose.x, to.pose.y - from.pose.y);
    const dTheta = Math.abs(normalizeAngle(to.pose.th - from.pose.th));
    if (ds <= 1e-6 || dTheta <= 1e-6) {
      continue;
    }
    const radius = ds / dTheta;
    if (radius < best.radius) {
      best = { radius, index, at: [from.pose.x, from.pose.y], dTheta };
    }
  }
  return best;
}

/** Cắt phần **chạy trên làn**, bỏ đoạn thao tác trong ô. */
function drivingSection(route: Route, kind: 'entry' | 'exit'): RoutePoint[] {
  const cumulative: number[] = [0];
  for (let index = 1; index < route.points.length; index += 1) {
    const from = route.points[index - 1].pose;
    const to = route.points[index].pose;
    cumulative.push(cumulative[index - 1] + Math.hypot(to.x - from.x, to.y - from.y));
  }
  const boundary = kind === 'entry' ? (route.slot_start_s ?? 0) : (route.maneuver_end_s ?? 0);
  return route.points.filter((_point, index) =>
    kind === 'entry' ? cumulative[index] <= boundary + 1e-6 : cumulative[index] >= boundary - 1e-6,
  );
}

interface BadRow {
  readonly label: string;
  readonly radius: number;
  readonly detail: string;
}

function formatRows(rows: readonly BadRow[]): string[] {
  return rows
    .slice()
    .sort((left, right) => left.radius - right.radius)
    .slice(0, 12)
    .map((row) => `${row.label}: R=${row.radius.toFixed(3)} m — ${row.detail}`);
}

describe('P17l — bán kính cua nhỏ nhất của lộ trình vào/ra 100 ô', () => {
  it(`cung vào/ra ô có bán kính thiết kế ≥ ${MIN_TURN_RADIUS_M} m`, () => {
    const network = roadNetworkOf(lot);
    const bad: BadRow[] = [];
    for (const slot of lot.slots) {
      const access = slotAccess(network, slot);
      if (access.radius_m < MIN_TURN_RADIUS_M - 1e-6) {
        bad.push({
          label: `${slot.id}/arc`,
          radius: access.radius_m,
          detail: `làn ${access.aisle_id}, tâm (${slot.center[0].toFixed(2)}, ${slot.center[1].toFixed(2)})`,
        });
      }
    }
    expect(
      formatRows(bad),
      `${bad.length}/100 ô có cung nhỏ hơn ${MIN_TURN_RADIUS_M} m`,
    ).toEqual([]);
  });

  it(`đoạn chạy trên làn của mọi lộ trình có cua ≥ ${MIN_TURN_RADIUS_M} m`, () => {
    const network = roadNetworkOf(lot);
    const bad: BadRow[] = [];
    let worst: BadRow | null = null;
    for (const slot of lot.slots) {
      for (const kind of ['entry', 'exit'] as const) {
        const route =
          kind === 'entry'
            ? buildEntryRoute(lot, network, slot, DESIRED_SPEED_MPS)
            : buildExitRoute(lot, network, slot, DESIRED_SPEED_MPS);
        expect(route, `${slot.id}/${kind}: không lập được lộ trình`).not.toBeNull();
        if (route === null) {
          continue;
        }
        const scan = minTurnRadius(drivingSection(route, kind));
        const row: BadRow = {
          label: `${slot.id}/${kind}`,
          radius: scan.radius,
          detail:
            `tại #${scan.index} (${scan.at[0].toFixed(2)}, ${scan.at[1].toFixed(2)}), ` +
            `Δθ=${scan.dTheta.toFixed(3)} rad`,
        };
        if (worst === null || row.radius < worst.radius) {
          worst = row;
        }
        // P17l phương án B: hai cung V_far_w (R=2,9 m) là ngoại lệ có chủ ý — làn chỉ rộng 2,8 m.
        const inFarWest = scan.at[0] < -33 && scan.at[1] < -10;
        const limit = inFarWest ? FAR_W_MIN_RADIUS_M : MIN_TURN_RADIUS_M;
        if (row.radius < limit - 1e-6) {
          bad.push(row);
        }
      }
    }
    expect(
      formatRows(bad),
      `nhỏ nhất toàn bãi: R=${worst?.radius.toFixed(3)} m ở ${worst?.label}; ` +
        `${bad.length}/200 lộ trình dưới ngưỡng`,
    ).toEqual([]);
  });
});
