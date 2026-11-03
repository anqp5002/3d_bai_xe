/** Lỗi của lõi mô phỏng — luôn ném ra, không nuốt (R2). */
export class SimError extends Error {
  override readonly name = 'SimError';
}
