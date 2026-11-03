"""Sinh 3 model xe low-poly kieu do choi -> GLB (phase P3, contract C-C / C4).

Chay:
    blender -b -P sim3d/tools/blender/make_cars.py

Xuat:
    sim3d/web/public/assets/cars/{sedan,suv,hatch}.glb
    sim3d/tools/out/cars_preview.png   (3 xe x 3 mau, nhin cheo + nhin tu camera dataset)

Quy uoc (C-C):
    - don vi met; goc (0,0,0) o tam hinh chieu san; z=0 la mat dat (banh xe cham dat).
    - mui xe +Y trong Blender (Z-up). GLB xuat Y-up nen trong file: mui xe = -Z, cao = +Y.
    - material: paint (doi mau luc chay), glass, light_front, light_rear (emissive).
    - banh xe la mesh rieng ten wheel_*, goc object dat o tam banh -> xoay duoc.
"""

import math
import tempfile
from pathlib import Path

import bmesh
import bpy
from mathutils import Vector

HERE = Path(__file__).resolve().parent
SIM3D = HERE.parents[1]
GLB_DIR = SIM3D / "web" / "public" / "assets" / "cars"
OUT_DIR = SIM3D / "tools" / "out"
PREVIEW_PNG = OUT_DIR / "cars_preview.png"

# Camera dataset (y tuong §8, giong build_blender_video.py): chui 80 do, cao 33,6 m, f=288 px / 640 px.
CAM = {"pitch_deg": 80.0, "f_px": 288.0, "height_m": 33.6, "res": 640}
PH = math.radians(CAM["pitch_deg"])

# C4: sedan 4,6x1,8x1,45 | SUV 4,7x1,9x1,7 | hatchback 4,0x1,75x1,5
SPECS = {
    "sedan": dict(
        L=4.6, W=1.8, H=1.45,
        hull_z=(0.44, 0.90),          # san duoi body, duong belt (chan kinh)
        cabin=dict(zb=0.90, zt=1.45, hw_b=0.80, hw_t=0.70,
                   y_b=(-1.50, 0.98), y_t=(-1.12, 0.40)),
        wheel=dict(r=0.33, w=0.22, axle=1.42),
        light_z=0.17,
    ),
    "suv": dict(
        L=4.7, W=1.9, H=1.70,
        hull_z=(0.52, 1.06),
        cabin=dict(zb=1.06, zt=1.645, hw_b=0.88, hw_t=0.80,
                   y_b=(-2.02, 1.16), y_t=(-1.92, 0.78)),
        wheel=dict(r=0.39, w=0.26, axle=1.48),
        light_z=0.20,
        rail=True,
    ),
    "hatch": dict(
        L=4.0, W=1.75, H=1.50,
        hull_z=(0.42, 0.88),
        cabin=dict(zb=0.88, zt=1.50, hw_b=0.80, hw_t=0.70,
                   y_b=(-1.68, 1.04), y_t=(-1.60, 0.42)),
        wheel=dict(r=0.31, w=0.20, axle=1.24),
        light_z=0.16,
    ),
}
MODELS = ("sedan", "suv", "hatch")

# 3 mau lay tu bang 8 mau C4
COLORS = [
    ("trang", (0.86, 0.86, 0.83)),
    ("do", (0.52, 0.045, 0.03)),
    ("xanh", (0.03, 0.14, 0.50)),
]

# ---------------------------------------------------------------- helpers


def clean_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.unit_settings.system = "METRIC"
    sc.unit_settings.scale_length = 1.0


def mat(name, base, metallic=0.0, roughness=0.45, emission=None, e_str=0.0):
    m = bpy.data.materials.get(name)
    if m:
        return m
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*base, 1.0)
    b.inputs["Metallic"].default_value = metallic
    b.inputs["Roughness"].default_value = roughness
    if emission is not None:
        b.inputs["Emission Color"].default_value = (*emission, 1.0)
        b.inputs["Emission Strength"].default_value = e_str
    m.diffuse_color = (*base, 1.0)
    return m


def base_materials():
    """Material dung chung, ten dung contract C-C."""
    return dict(
        paint=mat("paint", (0.86, 0.86, 0.83), 0.05, 0.35),
        glass=mat("glass", (0.045, 0.065, 0.09), 0.30, 0.10),
        light_front=mat("light_front", (0.95, 0.94, 0.86), 0.0, 0.15,
                        emission=(1.0, 0.96, 0.82), e_str=3.0),
        light_rear=mat("light_rear", (0.55, 0.02, 0.02), 0.0, 0.20,
                       emission=(1.0, 0.05, 0.02), e_str=3.0),
        trim=mat("trim", (0.045, 0.045, 0.05), 0.2, 0.55),
        tire=mat("tire", (0.028, 0.028, 0.030), 0.0, 0.85),
        rim=mat("rim", (0.72, 0.72, 0.74), 0.9, 0.25),
    )


def add_box(bm, x, y, z, mi):
    """Hop 6 mat. x/y/z = (min, max); mi = 6 chi so material (hoac 1 so)."""
    if isinstance(mi, int):
        mi = (mi,) * 6
    x0, x1 = x
    y0, y1 = y
    z0, z1 = z
    vs = [bm.verts.new(v) for v in (
        (x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
        (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1))]
    for f, m in zip(((0, 1, 2, 3), (7, 6, 5, 4), (0, 4, 5, 1),
                     (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)), mi):
        bm.faces.new([vs[i] for i in f]).material_index = m


def add_frustum(bm, zb, zt, hw_b, hw_t, y_b, y_t, mi_side, mi_top, mi_bottom):
    """Khoi cut 8 dinh: day (hw_b, y_b) o zb, dinh (hw_t, y_t) o zt."""
    b = [bm.verts.new(v) for v in (
        (-hw_b, y_b[0], zb), (hw_b, y_b[0], zb), (hw_b, y_b[1], zb), (-hw_b, y_b[1], zb))]
    t = [bm.verts.new(v) for v in (
        (-hw_t, y_t[0], zt), (hw_t, y_t[0], zt), (hw_t, y_t[1], zt), (-hw_t, y_t[1], zt))]
    bm.faces.new(b[::-1]).material_index = mi_bottom
    bm.faces.new(t).material_index = mi_top
    # 4 mat ben = kinh: kinh truoc (+Y), kinh sau (-Y), 2 ben
    bm.faces.new((b[3], b[2], t[2], t[3])).material_index = mi_side
    bm.faces.new((b[1], b[0], t[0], t[1])).material_index = mi_side
    bm.faces.new((b[2], b[1], t[1], t[2])).material_index = mi_side
    bm.faces.new((b[0], b[3], t[3], t[0])).material_index = mi_side


def add_cylinder_x(bm, r, half_w, segments, mi_side, mi_cap):
    """Tru tron truc X, tam o goc toa do object."""
    lo, hi = [], []
    for i in range(segments):
        a = 2.0 * math.pi * i / segments
        y, z = r * math.cos(a), r * math.sin(a)
        lo.append(bm.verts.new((-half_w, y, z)))
        hi.append(bm.verts.new((half_w, y, z)))
    for i in range(segments):
        j = (i + 1) % segments
        bm.faces.new((lo[i], lo[j], hi[j], hi[i])).material_index = mi_side
    bm.faces.new(lo[::-1]).material_index = mi_cap
    bm.faces.new(hi).material_index = mi_cap


def finish_mesh(name, bm, materials):
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for m in materials:
        me.materials.append(m)
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    return ob


def select_only(ob):
    for o in bpy.context.selected_objects:
        o.select_set(False)
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob


def shade(ob, angle_deg=38.0):
    select_only(ob)
    try:
        bpy.ops.object.shade_auto_smooth(angle=math.radians(angle_deg))
    except Exception:
        bpy.ops.object.shade_flat()


def bevel(ob, width=0.045, segments=2):
    select_only(ob)
    md = ob.modifiers.new("bevel", "BEVEL")
    md.width = width
    md.segments = segments
    md.limit_method = "ANGLE"
    md.angle_limit = math.radians(30)
    bpy.ops.object.modifier_apply(modifier=md.name)


# ---------------------------------------------------------------- car


def build_car(model):
    """Tra ve dict body/lights/wheels; goc object o (0,0,0) tru banh (goc o tam banh)."""
    s = SPECS[model]
    L, W, H = s["L"], s["W"], s["H"]
    mats = base_materials()
    hw = W / 2.0
    hz = s["hull_z"]
    cab = s["cabin"]
    wh = s["wheel"]

    # --- than: hull + cabin (kinh = mat ben cabin) + luoi tan nhiet
    bm = bmesh.new()
    hull_y = L / 2.0 - 0.01          # den truoc/nhien ra 1 cm -> dai tong dung L
    add_box(bm, (-hw, hw), (-hull_y, hull_y), hz, 0)
    # canh luon (rocker) cho body day hon
    add_box(bm, (-hw + 0.06, hw - 0.06), (-hull_y + 0.40, hull_y - 0.40),
            (hz[0] - 0.10, hz[0] + 0.02), 0)
    add_frustum(bm, cab["zb"] - 0.06, cab["zt"], cab["hw_b"], cab["hw_t"],
                cab["y_b"], cab["y_t"], mi_side=1, mi_top=0, mi_bottom=0)
    # gia noc (SUV) cho khac hatch/sedan
    if s.get("rail"):
        for x in ((-0.62, -0.50), (0.50, 0.62)):
            add_box(bm, x, (cab["y_t"][0] + 0.12, cab["y_t"][1] - 0.12),
                    (cab["zt"] - 0.005, H), 2)
    # luoi tan nhiet truoc
    add_box(bm, (-0.40, 0.40), (hull_y - 0.03, L / 2.0 - 0.006),
            (hz[0] + 0.06, hz[0] + 0.26), 2)
    body = finish_mesh("body", bm, [mats["paint"], mats["glass"], mats["trim"]])
    bevel(body, width=0.045, segments=2)
    shade(body)

    # --- den truoc / den sau
    bm = bmesh.new()
    lz = hz[1] - s["light_z"]
    for x in ((-0.76, -0.36), (0.36, 0.76)):
        add_box(bm, x, (L / 2.0 - 0.05, L / 2.0), (lz - 0.075, lz + 0.075), 0)
    for x in ((-0.80, -0.34), (0.34, 0.80)):
        add_box(bm, x, (-L / 2.0, -L / 2.0 + 0.05), (lz - 0.08, lz + 0.09), 1)
    lights = finish_mesh("lights", bm, [mats["light_front"], mats["light_rear"]])
    shade(lights)

    # --- banh: mesh rieng, goc object o tam banh
    wheels = []
    wx = hw - 0.02 - wh["w"] / 2.0
    for name, sx, sy in (("wheel_fl", -1, 1), ("wheel_fr", 1, 1),
                         ("wheel_rl", -1, -1), ("wheel_rr", 1, -1)):
        bm = bmesh.new()
        add_cylinder_x(bm, wh["r"], wh["w"] / 2.0, 24, 0, 0)
        add_cylinder_x(bm, wh["r"] * 0.58, wh["w"] / 2.0 - 0.012, 20, 1, 1)
        ob = finish_mesh(name, bm, [mats["tire"], mats["rim"]])
        ob.location = (sx * wx, sy * wh["axle"], wh["r"])
        shade(ob)
        wheels.append(ob)

    return dict(model=model, body=body, lights=lights, wheels=wheels)


def car_objects(car):
    return [car["body"], car["lights"], *car["wheels"]]


def destroy_car(car):
    for o in car_objects(car):
        me = o.data
        bpy.data.objects.remove(o, do_unlink=True)
        if me is not None and me.users == 0:
            bpy.data.meshes.remove(me)


# ---------------------------------------------------------------- export


def export_glb(model, car):
    GLB_DIR.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    for o in car_objects(car):
        o.select_set(True)
    bpy.context.view_layer.objects.active = car["body"]
    path = GLB_DIR / f"{model}.glb"
    bpy.ops.export_scene.gltf(
        filepath=str(path),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_cameras=False,
        export_lights=False,
        export_extras=False,
        export_animations=False,
    )
    print(f"[make_cars] {path.name}: {path.stat().st_size} bytes")


# ---------------------------------------------------------------- preview


def project(X, Y):
    """Chieu diem mat dat (X,Y) met -> pixel 640 cua camera dataset."""
    H = CAM["height_m"]
    f = CAM["f_px"]
    z = Y * math.cos(PH) + H * math.sin(PH)
    return (CAM["res"] / 2.0 + f * X / z,
            CAM["res"] / 2.0 + f * (-Y * math.sin(PH) + H * math.cos(PH)) / z)


def setup_world():
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = 40
    sc.cycles.use_denoising = True
    sc.render.film_transparent = False
    sc.view_settings.view_transform = "AgX"
    try:
        sc.view_settings.look = "AgX - Punchy"
    except TypeError:
        pass

    world = bpy.data.worlds.new("w")
    sc.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0.55, 0.66, 0.82, 1.0)
    bg.inputs["Strength"].default_value = 0.9

    bm = bmesh.new()
    add_box(bm, (-90, 90), (-90, 90), (-0.05, 0.0), 0)
    ground = finish_mesh("ground", bm, [mat("ground", (0.30, 0.31, 0.33), 0.0, 0.75)])

    sd = bpy.data.lights.new("sun", "SUN")
    sd.energy = 3.8
    sd.angle = math.radians(3.0)
    sun = bpy.data.objects.new("sun", sd)
    sun.rotation_euler = (math.radians(50), 0.0, math.radians(38))
    bpy.context.collection.objects.link(sun)

    ad = bpy.data.lights.new("fill", "AREA")
    ad.energy = 1200.0
    ad.size = 16.0
    fill = bpy.data.objects.new("fill", ad)
    fill.location = (-11, -14, 12)
    fill.rotation_euler = (math.radians(58), 0.0, math.radians(-38))
    bpy.context.collection.objects.link(fill)
    return ground


def add_camera(name, loc, target, lens_mm=55.0, sensor=36.0):
    cd = bpy.data.cameras.new(name)
    cd.lens = lens_mm
    cd.sensor_width = sensor
    cam = bpy.data.objects.new(name, cd)
    cam.location = loc
    d = Vector(target) - Vector(loc)
    cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    bpy.context.collection.objects.link(cam)
    return cam


def fit_lens(cam, points, res_x, res_y, margin=0.90):
    """Tinh tieu cu (mm) de moi diem nam trong khung, chua le margin."""
    inv = cam.matrix_world.inverted()
    sensor = cam.data.sensor_width
    sensor_v = sensor * res_y / res_x
    mx = my = 1e-6
    for p in points:
        c = inv @ Vector(p)
        d = -c.z
        if d <= 0.05:
            continue
        mx = max(mx, abs(c.x) / d)
        my = max(my, abs(c.y) / d)
    return min((sensor / 2.0) * margin / mx, (sensor_v / 2.0) * margin / my)


def frame_camera(cam, target, direction, points, res_x, res_y, target_lens=62.0):
    """Dat camera theo huong cho truoc, chinh khoang cach de tieu cu ~ target_lens."""
    d = Vector(direction).normalized()
    dist = 30.0
    lens = target_lens
    for _ in range(6):
        cam.location = Vector(target) + d * dist
        cam.rotation_euler = (Vector(target) - cam.location).to_track_quat("-Z", "Y").to_euler()
        bpy.context.view_layer.update()
        lens = fit_lens(cam, points, res_x, res_y)
        dist = max(8.0, min(400.0, dist * target_lens / max(lens, 1e-3)))
        print(f"[make_cars]   thu: cach {dist:.1f} m -> tieu cu {lens:.1f} mm")
    cam.data.lens = lens
    bpy.context.view_layer.update()
    print(f"[make_cars] camera {cam.name}: cach {dist:.1f} m, tieu cu {lens:.1f} mm")
    return cam


def dataset_camera():
    """Camera dataset: cao 33,6 m tren goc, chui 80 do, f = 288/640*36 mm."""
    cd = bpy.data.cameras.new("cam_dataset")
    cd.sensor_fit = "HORIZONTAL"
    cd.sensor_width = 36.0
    cd.lens = CAM["f_px"] / CAM["res"] * 36.0
    cam = bpy.data.objects.new("cam_dataset", cd)
    cam.location = (0.0, 0.0, CAM["height_m"])
    cam.rotation_euler = (math.radians(90.0 - CAM["pitch_deg"]), 0.0, 0.0)
    bpy.context.collection.objects.link(cam)
    return cam


def duplicate_car(car, offset, paint):
    out = []
    for o in car_objects(car):
        d = o.copy()
        d.name = o.name + "_" + car["model"] + "_" + str(len(out))
        d.location = (o.location.x + offset[0], o.location.y + offset[1], o.location.z)
        bpy.context.collection.objects.link(d)
        if paint is not None:
            for slot in d.material_slots:
                if slot.material and slot.material.name == "paint":
                    slot.link = "OBJECT"
                    slot.material = paint
        out.append(d)
    return out


def render_to(path, cam, res_x, res_y):
    sc = bpy.context.scene
    sc.camera = cam
    sc.render.resolution_x = res_x
    sc.render.resolution_y = res_y
    sc.render.resolution_percentage = 100
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGBA"
    sc.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)
    print(f"[make_cars] render {path.name}")


def load_px(path):
    import numpy as np
    img = bpy.data.images.load(str(path))
    w, h = img.size
    px = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)[::-1].copy()
    bpy.data.images.remove(img)
    return px


def upscale(px, k):
    import numpy as np
    return np.repeat(np.repeat(px, k, axis=0), k, axis=1)


def save_px(px, path):
    h, w, _ = px.shape
    img = bpy.data.images.new("composite", w, h, alpha=True, float_buffer=False)
    img.pixels = px[::-1].ravel().tolist()
    img.file_format = "PNG"
    img.filepath_raw = str(path)
    img.save()
    print(f"[make_cars] {path}")


def set_stamp(note, size=26):
    r = bpy.context.scene.render
    r.use_stamp = True
    for attr in ("use_stamp_date", "use_stamp_time", "use_stamp_render_time", "use_stamp_frame",
                 "use_stamp_scene", "use_stamp_camera", "use_stamp_lens", "use_stamp_filename",
                 "use_stamp_marker", "use_stamp_sequencer_strip", "use_stamp_frame_range",
                 "use_stamp_memory", "use_stamp_hostname"):
        if hasattr(r, attr):
            setattr(r, attr, False)
    r.use_stamp_note = True
    r.use_stamp_labels = True
    r.stamp_note_text = note
    r.stamp_font_size = size
    r.stamp_foreground = (1.0, 1.0, 1.0, 1.0)
    r.stamp_background = (0.0, 0.0, 0.0, 0.55)


def build_preview(cars):
    sc = bpy.context.scene
    setup_world()

    paints = {c: mat(f"paint_{c}", rgb, 0.15, 0.30) for c, rgb in COLORS}

    # luoi: hang = model, cot = mau
    dx, dy = 6.4, 7.0
    spots = {}
    for mi, model in enumerate(MODELS):
        for ci, (cname, _rgb) in enumerate(COLORS):
            x = (ci - 1) * dx
            y = (mi - 1) * dy
            spots[(model, cname)] = (x, y)
            duplicate_car(cars[model], (x, y), paints[cname])
    for car in cars.values():
        destroy_car(car)

    # nhan chu: billboard noi tren noc xe, luon doc duoc tu camera
    tmat = mat("label", (0.95, 0.95, 0.95), 0.0, 0.5, emission=(1.0, 1.0, 1.0), e_str=1.2)
    cam_dir = Vector((0.62, 0.72, 0.42))

    bpy.context.view_layer.update()
    pts = []
    for o in sc.objects:
        if o.type == "MESH" and o.name != "ground":
            pts.extend([o.matrix_world @ Vector(v) for v in o.bound_box])
    if pts:
        print(f"[make_cars] vung dung: x[{min(p.x for p in pts):.1f},{max(p.x for p in pts):.1f}] "
              f"y[{min(p.y for p in pts):.1f},{max(p.y for p in pts):.1f}] "
              f"z[{min(p.z for p in pts):.1f},{max(p.z for p in pts):.1f}]")

    cam_ob = add_camera("cam_oblique", (10.0, 12.0, 8.0), (0.0, 1.0, 0.5))
    frame_camera(cam_ob, (0.0, 1.0, 0.55), cam_dir, pts, 1600, 760, target_lens=68.0)
    cam_ds = dataset_camera()

    for (model, cname), (x, y) in spots.items():
        bpy.ops.object.text_add(location=(x, y, 2.25))
        t = bpy.context.object
        t.data.body = f"{model} - {cname}"
        t.data.align_x = "CENTER"
        t.data.align_y = "CENTER"
        t.data.size = 0.55
        t.rotation_euler = cam_ob.rotation_euler.copy()
        t.data.materials.append(tmat)

    tmp = Path(tempfile.mkdtemp(prefix="cars_"))
    p_obl = tmp / "oblique.png"
    p_ds = tmp / "dataset.png"

    set_stamp("3 model x 3 mau - nhin cheo 3/4 | met, goc o tam san, mui xe +Y (Blender)")
    render_to(p_obl, cam_ob, 1600, 760)

    for o in sc.objects:
        if o.type == "FONT":
            o.hide_render = True
    set_stamp("camera dataset: chui 80 do, cao 33,6 m, f=288 px/640 - ti le 1:1")
    render_to(p_ds, cam_ds, CAM["res"], CAM["res"])

    import numpy as np
    a = load_px(p_obl)
    b = load_px(p_ds)

    # vung cum xe trong khung dataset -> cat va phong to
    us, vs = [], []
    for mi, model in enumerate(MODELS):
        L = SPECS[model]["L"]
        W = SPECS[model]["W"]
        for ci in range(len(COLORS)):
            x = (ci - 1) * dx
            y = (mi - 1) * dy
            for sx in (-1, 1):
                for sy in (-1, 1):
                    u, v = project(x + sx * (W / 2 + 0.35), y + sy * (L / 2 + 0.35))
                    us.append(u)
                    vs.append(v)
    x0 = int(max(0, math.floor(min(us)) - 12))
    x1 = int(min(CAM["res"], math.ceil(max(us)) + 12))
    y0 = int(max(0, math.floor(min(vs)) - 12))
    y1 = int(min(CAM["res"], math.ceil(max(vs)) + 12))
    crop = b[y0:y1, x0:x1]
    k = max(1, min(6, int(min(900 / crop.shape[1], 700 / crop.shape[0]))))
    z = upscale(crop, k)

    cw = 700 + z.shape[1] + 40
    chh = 780 + max(640, z.shape[0]) + 20
    canvas = np.ones((chh, max(1600, cw), 4), dtype=np.float32)
    canvas[..., :3] = 0.07
    canvas[0:760, 0:1600] = a
    canvas[780:780 + CAM["res"], 40:40 + CAM["res"]] = b
    zy = 780 + max(0, (640 - z.shape[0]) // 2)
    canvas[zy:zy + z.shape[0], 700:700 + z.shape[1]] = z
    print(f"[make_cars] dataset crop {crop.shape[1]}x{crop.shape[0]} px -> x{k} = "
          f"{z.shape[1]}x{z.shape[0]}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    save_px(canvas, PREVIEW_PNG)

    for p in (p_obl, p_ds):
        try:
            p.unlink()
        except OSError:
            pass
    try:
        tmp.rmdir()
    except OSError:
        pass


# ---------------------------------------------------------------- main


def main():
    clean_scene()
    for model in MODELS:
        car = build_car(model)
        bpy.context.view_layer.update()
        lo = Vector((1e9, 1e9, 1e9))
        hi = Vector((-1e9, -1e9, -1e9))
        for o in car_objects(car):
            for v in o.bound_box:
                w = o.matrix_world @ Vector(v)
                lo = Vector((min(lo.x, w.x), min(lo.y, w.y), min(lo.z, w.z)))
                hi = Vector((max(hi.x, w.x), max(hi.y, w.y), max(hi.z, w.z)))
        print(f"[make_cars] {model}: rong={hi.x - lo.x:.4f} dai={hi.y - lo.y:.4f} "
              f"cao={hi.z - lo.z:.4f} z_min={lo.z:.4f} x=[{lo.x:.3f},{hi.x:.3f}] "
              f"y=[{lo.y:.3f},{hi.y:.3f}]")
        export_glb(model, car)
        destroy_car(car)

    cars = {m: build_car(m) for m in MODELS}
    build_preview(cars)
    print("[make_cars] done")


if __name__ == "__main__":
    main()
