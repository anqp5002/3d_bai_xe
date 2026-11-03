/**
 * Hằng số thời gian của lõi mô phỏng (FE §4.1, C3).
 *
 * Để ở module lá (không import gì) nhằm tránh vòng import giữa `contracts/sim.ts`
 * và các module `sim/*`: mọi nơi đều lấy cùng một giá trị, contract chỉ re-export.
 */

/** Bước thời gian cố định, giây (C3, FE §4.1). */
export const DT_S = 0.04;
/** Số frame mỗi giây (U19). */
export const FPS = 25;
