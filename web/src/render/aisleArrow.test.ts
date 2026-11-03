/**
 * Test hướng mũi tên làn + hướng mũi xe GLB — hai chỗ dễ sai dấu nhất khi đổi hệ trục.
 *
 * Dùng ba đối tượng three thật (không WebGL) để kiểm phép xoay, không tự viết lại toán.
 */

import { describe, expect, it } from 'vitest';
import { Euler, Group, Mesh, Shape, ShapeGeometry, Vector3 } from 'three';
import { worldToThree } from './cameraGeometry';

/**
 * Cách `scene.ts` đặt mũi tên làn: `rotation.x = -π/2`, `rotation.z = -atan2(dx, dy)`.
 * Test dựng lại đúng chuỗi xoay đó rồi kiểm mũi Shape (+Y cục bộ) trỏ đúng hướng world.
 */
function aisleArrowDirection(dx: number, dy: number): Vector3 {
  const holder = new Group();
  const mesh = new Mesh(new ShapeGeometry(new Shape()));
  mesh.rotation.x = -Math.PI / 2;
  mesh.rotation.z = -Math.atan2(dx, dy);
  holder.add(mesh);
  holder.updateMatrixWorld(true);
  return new Vector3(0, 1, 0).applyMatrix4(mesh.matrixWorld).normalize();
}

describe('render/scene — mũi tên chỉ đúng chiều làn', () => {
  it.each([
    ['đông (+X)', 1, 0],
    ['tây (-X)', -1, 0],
    ['bắc (+Y world = -Z three)', 0, 1],
    ['nam (-Y world = +Z three)', 0, -1],
  ])('%s', (_label, dx, dy) => {
    const nose = aisleArrowDirection(dx, dy);
    const [ex, ey, ez] = worldToThree(dx, dy, 0);
    const expected = new Vector3(ex, ey, ez).normalize();
    expect(nose.x).toBeCloseTo(expected.x, 6);
    expect(nose.y).toBeCloseTo(expected.y, 6);
    expect(nose.z).toBeCloseTo(expected.z, 6);
  });

  it('làm ngược dấu (bug cũ) thì test bắt được', () => {
    const wrong = new Vector3(0, 1, 0).applyEuler(
      new Euler(-Math.PI / 2, 0, -Math.atan2(1, 0) - Math.PI / 2),
    );
    const [ex, , ez] = worldToThree(1, 0, 0);
    // Hướng tây thay vì đông ⇒ lệch rõ.
    expect(Math.hypot(wrong.x - ex, wrong.z - ez)).toBeGreaterThan(1);
  });
});
