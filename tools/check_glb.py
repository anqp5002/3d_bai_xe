#!/usr/bin/env python3
"""Kiem 3 file GLB xe cua P3 (contract C-C, kich thuoc C4).

Chay:
    python sim3d/tools/check_glb.py

Kiem:
    - bbox tung xe (doc truc tiep vertex trong GLB) sai <= 2 cm so voi C4
    - goc san: min y (truc cao trong glTF) = 0  -> banh xe tiep dat
    - mui xe -Z trong glTF (= +Y trong Blender)  -> den truoc nam ve phia -Z
    - du material: paint, glass, light_front, light_rear (2 den co emissive)
    - paint doi mau luc chay duoc: co baseColorFactor, khong dung texture
    - banh xe tach mesh ten wheel_* (>= 4 mesh)

Thoat ma 0 neu tat ca dung, 1 neu co loi.
"""

import json
import math
import struct
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
GLB_DIR = HERE.parents[0] / "web" / "public" / "assets" / "cars"

# C4: (dai, rong, cao) met
CARS = {
    "sedan": (4.6, 1.8, 1.45),
    "suv": (4.7, 1.9, 1.70),
    "hatch": (4.0, 1.75, 1.50),
}
TOL_M = 0.02          # sai so cho phep
GROUND_TOL = 0.005    # tiep dat
REQUIRED_MATERIALS = ("paint", "glass", "light_front", "light_rear")
EMISSIVE_MATERIALS = ("light_front", "light_rear")

GLB_MAGIC = 0x46546C67
CHUNK_JSON = 0x4E4F534A
CHUNK_BIN = 0x004E4942


# ---------------------------------------------------------------- doc GLB


def read_glb(path):
    data = path.read_bytes()
    magic, version, length = struct.unpack_from("<III", data, 0)
    if magic != GLB_MAGIC:
        raise ValueError(f"{path}: khong phai GLB (magic={magic:#x})")
    if version != 2:
        raise ValueError(f"{path}: glTF version {version} != 2")
    off, js, bin_ = 12, None, None
    while off < length:
        clen, ctype = struct.unpack_from("<II", data, off)
        off += 8
        chunk = data[off:off + clen]
        off += clen
        if ctype == CHUNK_JSON:
            js = json.loads(chunk.decode("utf-8"))
        elif ctype == CHUNK_BIN:
            bin_ = chunk
    if js is None or bin_ is None:
        raise ValueError(f"{path}: thieu chunk JSON hoac BIN")
    return js, bin_


def read_positions(gltf, bin_, acc_idx):
    acc = gltf["accessors"][acc_idx]
    if acc.get("componentType") != 5126 or acc.get("type") != "VEC3":
        raise ValueError("accessor POSITION khong phai float VEC3")
    bv = gltf["bufferViews"][acc["bufferView"]]
    base = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
    stride = bv.get("byteStride") or 12
    out = []
    for i in range(acc["count"]):
        out.append(struct.unpack_from("<fff", bin_, base + i * stride))
    return out


# ---------------------------------------------------------------- ma tran 4x4


def mat_identity():
    return [[1.0 if i == j else 0.0 for j in range(4)] for i in range(4)]


def mat_mul(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]


def mat_node(n):
    if "matrix" in n:
        m = n["matrix"]                       # column-major
        return [[m[0], m[4], m[8], m[12]],
                [m[1], m[5], m[9], m[13]],
                [m[2], m[6], m[10], m[14]],
                [m[3], m[7], m[11], m[15]]]
    tx, ty, tz = n.get("translation", (0.0, 0.0, 0.0))
    qx, qy, qz, qw = n.get("rotation", (0.0, 0.0, 0.0, 1.0))
    sx, sy, sz = n.get("scale", (1.0, 1.0, 1.0))
    xx, yy, zz = qx * qx, qy * qy, qz * qz
    xy, xz, yz = qx * qy, qx * qz, qy * qz
    wx, wy, wz = qw * qx, qw * qy, qw * qz
    r = [[1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy)],
         [2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx)],
         [2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy)]]
    return [[r[0][0] * sx, r[0][1] * sy, r[0][2] * sz, tx],
            [r[1][0] * sx, r[1][1] * sy, r[1][2] * sz, ty],
            [r[2][0] * sx, r[2][1] * sy, r[2][2] * sz, tz],
            [0.0, 0.0, 0.0, 1.0]]


def apply(m, p):
    x, y, z = p
    return (m[0][0] * x + m[0][1] * y + m[0][2] * z + m[0][3],
            m[1][0] * x + m[1][1] * y + m[1][2] * z + m[1][3],
            m[2][0] * x + m[2][1] * y + m[2][2] * z + m[2][3])


def collect(gltf, bin_):
    """Tra ve: diem (world), {mesh_name}, {material_name: centroid z}, so vertex."""
    pts = []
    mesh_names = set()
    mat_z = {}
    nodes = gltf.get("nodes", [])
    scene = gltf["scenes"][gltf.get("scene", 0)]

    def walk(ni, parent):
        n = nodes[ni]
        m = mat_mul(parent, mat_node(n))
        if "mesh" in n:
            mesh = gltf["meshes"][n["mesh"]]
            mesh_names.add(mesh.get("name", f"mesh_{n['mesh']}"))
            for prim in mesh["primitives"]:
                pos = read_positions(gltf, bin_, prim["attributes"]["POSITION"])
                wpos = [apply(m, p) for p in pos]
                pts.extend(wpos)
                mi = prim.get("material")
                if mi is not None:
                    name = gltf["materials"][mi].get("name", f"mat_{mi}")
                    acc = mat_z.setdefault(name, [0.0, 0])
                    for w in wpos:
                        acc[0] += w[2]
                        acc[1] += 1
        for c in n.get("children", []):
            walk(c, m)

    for ni in scene.get("nodes", []):
        walk(ni, mat_identity())
    return pts, mesh_names, mat_z


# ---------------------------------------------------------------- kiem


def check_one(model, path):
    errs = []
    notes = []
    dai_t, rong_t, cao_t = CARS[model]
    gltf, bin_ = read_glb(path)
    pts, mesh_names, mat_z = collect(gltf, bin_)

    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    zs = [p[2] for p in pts]
    bx = (min(xs), max(xs))
    by = (min(ys), max(ys))
    bz = (min(zs), max(zs))
    # glTF Y-up: x = rong, y = cao, z = dai (mui xe -Z)
    rong = bx[1] - bx[0]
    cao = by[1] - by[0]
    dai = bz[1] - bz[0]

    for label, got, want in (("dai", dai, dai_t), ("rong", rong, rong_t), ("cao", cao, cao_t)):
        d = abs(got - want)
        if d > TOL_M:
            errs.append(f"{label} {got:.4f} lech {d * 100:.2f} cm (> {TOL_M * 100:.0f} cm), C4 = {want}")
        notes.append(f"{label}={got:.4f} (C4 {want:.2f}, sai {d * 100:.2f} cm)")

    if abs(by[0]) > GROUND_TOL:
        errs.append(f"goc san: min y = {by[0]:.4f} m (phai = 0, banh xe tiep dat)")
    else:
        notes.append(f"tiep dat: min y = {by[0]:.4f} m")

    names = {m.get("name") for m in gltf.get("materials", [])}
    missing = [m for m in REQUIRED_MATERIALS if m not in names]
    if missing:
        errs.append(f"thieu material: {', '.join(missing)}")
    for m in EMISSIVE_MATERIALS:
        mat = next((x for x in gltf.get("materials", []) if x.get("name") == m), None)
        if not mat:
            continue
        ef = mat.get("emissiveFactor", [0, 0, 0])
        strength = mat.get("extensions", {}).get("KHR_materials_emissive_strength", {}) \
                      .get("emissiveStrength", 1.0)
        if max(ef) <= 0.0:
            errs.append(f"{m}: emissiveFactor = {ef} (phai > 0)")
        else:
            notes.append(f"{m}: emissive {[round(v, 2) for v in ef]} x{strength:g}")

    paint = next((x for x in gltf.get("materials", []) if x.get("name") == "paint"), None)
    if paint is not None:
        pbr = paint.get("pbrMetallicRoughness", {})
        if "baseColorTexture" in pbr:
            errs.append("paint dung baseColorTexture -> khong doi mau luc chay duoc")
        if "baseColorFactor" not in pbr:
            errs.append("paint thieu baseColorFactor")
        else:
            notes.append(f"paint baseColorFactor={[round(v, 3) for v in pbr['baseColorFactor']]}")

    wheels = sorted(n for n in mesh_names if n.startswith("wheel_"))
    if len(wheels) < 4:
        errs.append(f"banh xe: chi co {len(wheels)} mesh wheel_* (can 4): {wheels}")
    else:
        notes.append(f"mesh: {', '.join(sorted(mesh_names))}")

    zf = mat_z.get("light_front", [None, 0])
    zr = mat_z.get("light_rear", [None, 0])
    if zf[1] and zr[1]:
        cf, cr = zf[0] / zf[1], zr[0] / zr[1]
        if not cf < cr:
            errs.append(f"mui xe sai huong: den truoc z={cf:.2f} khong nho hon den sau z={cr:.2f}")
        else:
            notes.append(f"mui xe -Z (den truoc z={cf:.2f} < den sau z={cr:.2f})")
    else:
        errs.append("khong tim thay den truoc/sau theo material")

    print(f"\n== {model} == {path.name} ({path.stat().st_size / 1024:.0f} KB, {len(pts)} vertex)")
    print(f"   bbox glTF  x[{bx[0]:.3f},{bx[1]:.3f}] y[{by[0]:.3f},{by[1]:.3f}] z[{bz[0]:.3f},{bz[1]:.3f}]")
    for n in notes:
        print(f"   - {n}")
    for e in errs:
        print(f"   ! {e}")
    return errs


def main():
    print("Kiem GLB xe P3 - don vi met, goc o tam san, mui xe +Y (Blender) = -Z (glTF Y-up)")
    total = []
    for model, (dai, rong, cao) in CARS.items():
        path = GLB_DIR / f"{model}.glb"
        if not path.exists():
            print(f"\n== {model} == THIEU FILE {path}")
            total.append(f"{model}: thieu file")
            continue
        try:
            total += [f"{model}: {e}" for e in check_one(model, path)]
        except Exception as exc:                       # noqa: BLE001
            print(f"\n== {model} == loi doc file: {exc}")
            total.append(f"{model}: {exc}")

    print()
    if total:
        print(f"FAIL - {len(total)} loi:")
        for e in total:
            print(f"  - {e}")
        return 1
    print("PASS - 3 xe dung kich thuoc C4 (sai <= 2 cm), du material/mesh, banh tiep dat, mui -Z")
    return 0


if __name__ == "__main__":
    sys.exit(main())
