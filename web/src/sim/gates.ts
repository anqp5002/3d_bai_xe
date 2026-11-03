/**
 * Cổng một làn (U8, C8, FE §4.4.2).
 *
 * Quy ước: mỗi xe có **khoảng cách có dấu từ mũi xe tới vạch cổng**, đo dọc chiều đi:
 * `> 0` = chưa tới vạch, `0` = mũi đúng vạch, `< 0` = mũi đã qua vạch. Xe **chiếm đoạn
 * cổng** khi mũi đã qua nhưng đuôi chưa qua hết (`-length < d ≤ 0`), nên chỉ cần kiểm
 * "không có xe nào đang chiếm" là tự thoả "xe kế vào khi xe trước cách cổng ≥ 1 chiều dài".
 *
 * Hàm thuần dữ liệu, không biết hình lối — P5b chỉ cần truyền khoảng cách đã chiếu lên
 * pháp tuyến cổng.
 */

/** Hệ số khoảng cách tối thiểu trước khi xe kế được vào cổng (U8: ≥ 1 chiều dài xe). */
export const GATE_CLEARANCE_FACTOR = 1;

export interface GateCar {
  readonly id: string;
  /** Khoảng cách có dấu từ mũi xe tới vạch cổng theo chiều đi, m. */
  readonly distance_m: number;
  /** Chiều dài xe, m (đã nhân hệ số tỉ lệ). */
  readonly length_m: number;
}

export interface GateDecision {
  readonly ok: boolean;
  /** Xe đang chiếm đoạn cổng (nếu có). */
  readonly occupantId: string | null;
  /** Lý do khi `ok = false`; rỗng khi được vào. */
  readonly reason: string;
}

function validate(car: GateCar): void {
  if (!Number.isFinite(car.distance_m)) {
    throw new Error(`gate: ${car.id} có distance_m không hữu hạn`);
  }
  if (!(car.length_m > 0)) {
    throw new Error(`gate: ${car.id} có length_m phải > 0, nhận ${String(car.length_m)}`);
  }
}

/** Xe đang chiếm đoạn cổng? (mũi đã qua vạch, đuôi chưa qua hết). */
export function isInsideGate(car: GateCar): boolean {
  validate(car);
  return car.distance_m <= 0 && car.distance_m > -car.length_m * GATE_CLEARANCE_FACTOR;
}

/** Xe đã qua cổng đủ xa để xe sau vào (cách cổng ≥ 1 chiều dài xe). */
export function isGateClear(car: GateCar): boolean {
  validate(car);
  return car.distance_m <= -car.length_m * GATE_CLEARANCE_FACTOR;
}

/**
 * Xe đang giữ đoạn cổng, `null` nếu trống.
 * Nếu dữ liệu lỗi có hai xe cùng chiếm (lỗi lập trình), trả xe gần vạch hơn để còn chặn.
 */
export function gateOccupant(cars: readonly GateCar[]): GateCar | null {
  let occupant: GateCar | null = null;
  for (const car of cars) {
    if (!isInsideGate(car)) {
      continue;
    }
    if (occupant === null || car.distance_m > occupant.distance_m) {
      occupant = car;
    }
  }
  return occupant;
}

/** Hàng chờ phía trước cổng: xe chưa tới vạch, gần cổng nhất đứng đầu. */
export function gateQueue(cars: readonly GateCar[]): readonly GateCar[] {
  return cars
    .filter((car) => {
      validate(car);
      return car.distance_m > 0;
    })
    .sort((a, b) => (a.distance_m === b.distance_m ? a.id.localeCompare(b.id) : a.distance_m - b.distance_m));
}

/**
 * Xe `candidateId` có được vào đoạn cổng lúc này không.
 *
 * Điều kiện: không xe nào đang chiếm đoạn cổng, và `candidateId` là xe gần cổng nhất
 * trong hàng chờ (một làn, không vượt). Xe đã qua cổng thì không "vào" nữa.
 */
export function canEnterGate(
  cars: readonly GateCar[],
  candidateId: string,
): GateDecision {
  const candidate = cars.find((car) => car.id === candidateId);
  if (candidate === undefined) {
    throw new Error(`canEnterGate: không có xe "${candidateId}" trong danh sách`);
  }
  validate(candidate);
  if (isInsideGate(candidate)) {
    return {
      ok: false,
      occupantId: candidate.id,
      reason: `${candidate.id} đang trong đoạn cổng`,
    };
  }
  const occupant = gateOccupant(cars);
  if (occupant !== null) {
    return {
      ok: false,
      occupantId: occupant.id,
      reason: `${occupant.id} chưa qua hết cổng (còn cách ${Math.abs(occupant.distance_m).toFixed(2)} m)`,
    };
  }
  if (candidate.distance_m <= 0) {
    return {
      ok: false,
      occupantId: null,
      reason: `${candidate.id} đã qua vạch, không phải lượt vào`,
    };
  }
  const queue = gateQueue(cars);
  const head = queue[0];
  if (head !== undefined && head.id !== candidate.id) {
    return {
      ok: false,
      occupantId: null,
      reason: `${head.id} gần cổng hơn — cổng một làn, không vượt`,
    };
  }
  return { ok: true, occupantId: null, reason: '' };
}
