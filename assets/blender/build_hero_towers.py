"""Agent City hero towers: procedural Blender build + glTF export.

Builds the nine division landmark towers from scratch (no external assets),
exports one GLB per tower plus manifest.json for the three.js city.

Run with the Blender binary:
    blender -b -P assets/blender/build_hero_towers.py -- --out apps/city/public/models \
        [--blend assets/blender/hero_towers.blend] [--only deco-spire,glass-led]

or with the `bpy` Python module:
    python assets/blender/build_hero_towers.py --out apps/city/public/models

See assets/blender/README.md for the conventions (node names, materials,
attributes, manifest fields) the city loader relies on.
"""

import argparse
import json
import math
import os
import random
import shutil
import struct
import subprocess
import sys

import bpy
from mathutils import Vector


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

MODEL_KEYS = [
    "deco-spire",
    "glass-led",
    "ring-cylinder",
    "neoclassical",
    "warehouse-loft",
    "twist-tower",
    "bank-dome",
    "glass-pavilion",
    "billboard-block",
]

SEED = 20261009            # global seed; each model derives its own RNG from it
GROUND_H = 0.6             # ground floor height (city units, 1 unit ~ 10 m)
FLOOR_H = 0.38             # typical floor height
WIN_PROUD = 0.012          # windows sit this far in front of the wall they are on
PREFIX_SEP = "/"           # Blender object names are "<model>/<Node>"; stripped on export



def _find_repo_root():
    try:
        return os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
    except NameError:      # exec()'d inside Blender (e.g. via an MCP bridge): walk up from the cwd
        d = os.getcwd()
        while True:
            if os.path.isdir(os.path.join(d, "apps", "city")):
                return d
            parent = os.path.dirname(d)
            if parent == d:
                return os.getcwd()
            d = parent


REPO_ROOT = _find_repo_root()
DEFAULT_OUT = os.path.join(REPO_ROOT, "apps", "city", "public", "models")


# ---------------------------------------------------------------------------
# Materials
# ---------------------------------------------------------------------------
# Body materials: the city picks its look by material NAME; the PBR values here
# are sensible defaults so the GLBs also look right in any glTF viewer.
# Colors are linear RGB.

BODY_MATERIALS = {
    "Stone":     dict(color=(0.30, 0.27, 0.23), rough=0.75),            # darker granite base
    "Limestone": dict(color=(0.62, 0.55, 0.45), rough=0.85),            # warm Indiana limestone
    "Marble":    dict(color=(0.80, 0.78, 0.74), rough=0.45),            # white civic marble
    "Brick":     dict(color=(0.34, 0.11, 0.07), rough=0.9),             # NYC red-brown brick
    "Glass":     dict(color=(0.025, 0.06, 0.07), rough=0.08, metal=0.6),  # dark blue-green glass
    "Metal":     dict(color=(0.42, 0.43, 0.45), rough=0.35, metal=1.0),   # brushed steel / aluminium
    "Copper":    dict(color=(0.20, 0.42, 0.33), rough=0.6, metal=0.15),   # green patina copper
    "Concrete":  dict(color=(0.66, 0.66, 0.64), rough=0.85),            # pale architectural concrete
    "Roof":      dict(color=(0.07, 0.07, 0.075), rough=0.95),           # tar / slate roofing
    "Trim":      dict(color=(0.055, 0.05, 0.045), rough=0.5, metal=0.5),  # dark bronze / cast iron
}


# Light-emitting parts (the city drives these; exported with a modest emissive).
LIGHT_MATERIALS = {
    "Window":     dict(color=(0.02, 0.025, 0.03), emit=(1.0, 0.72, 0.42), rough=0.15),
    "CrownLight": dict(color=(0.6, 0.55, 0.45), emit=(1.0, 0.84, 0.6), rough=0.4),
    "Accent":     dict(color=(0.6, 0.55, 0.5), emit=(1.0, 0.9, 0.75), rough=0.4),
    "LED":        dict(color=(0.01, 0.01, 0.012), emit=(0.25, 0.7, 1.0), rough=0.3),
    "Screen":     dict(color=(0.01, 0.01, 0.012), emit=(0.9, 0.9, 1.0), rough=0.3),
    "Ring":       dict(color=(0.7, 0.85, 0.9), emit=(0.55, 0.88, 1.0), rough=0.3),
    "Flag":       dict(color=(0.55, 0.06, 0.06), emit=None, rough=0.8, double=True),
}


def get_material(name):
    """Return the shared material `name`, creating/configuring it if needed."""
    mat = bpy.data.materials.get(name)
    if mat is None:
        mat = bpy.data.materials.new(name)
    spec = BODY_MATERIALS.get(name) or LIGHT_MATERIALS.get(name)
    if spec is None:
        raise KeyError("unknown material " + name)
    mat.use_nodes = True
    mat.use_backface_culling = not spec.get("double", False)
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (-300, 0)
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    col = spec["color"]
    bsdf.inputs["Base Color"].default_value = (col[0], col[1], col[2], 1.0)
    bsdf.inputs["Roughness"].default_value = spec.get("rough", 0.5)
    bsdf.inputs["Metallic"].default_value = spec.get("metal", 0.0)
    emit = spec.get("emit")
    if emit:
        bsdf.inputs["Emission Color"].default_value = (emit[0], emit[1], emit[2], 1.0)
        bsdf.inputs["Emission Strength"].default_value = 1.0
    mat.diffuse_color = (col[0], col[1], col[2], 1.0)
    return mat


# ---------------------------------------------------------------------------
# Floors
# ---------------------------------------------------------------------------

class Floors:
    """Floor 0 is the ground floor [0, ground]; floor i>=1 spans
    [ground + (i-1)*fh, ground + i*fh]."""

    def __init__(self, ground=GROUND_H, fh=FLOOR_H):
        self.ground = ground
        self.fh = fh

    def z0(self, i):
        return 0.0 if i == 0 else self.ground + (i - 1) * self.fh

    def z1(self, i):
        return self.ground if i == 0 else self.ground + i * self.fh

    def at(self, z):
        """Floor index containing height z."""
        if z < self.ground:
            return 0
        return int((z - self.ground) // self.fh) + 1

    def between(self, za, zb):
        """Indices of floors entirely inside [za, zb]."""
        out = []
        i = self.at(za + 1e-6)
        while self.z1(i) <= zb + 1e-6:
            if self.z0(i) >= za - 1e-6:
                out.append(i)
            i += 1
        return out


# ---------------------------------------------------------------------------
# Mesh building
# ---------------------------------------------------------------------------

def V(x, y, z):
    return Vector((x, y, z))


class MeshBuilder:
    """Accumulates polygons (with materials, UVs, smoothing and per-vertex
    float attributes) and turns them into Blender objects.

    Polygons must be wound counter-clockwise as seen from outside."""

    def __init__(self, name):
        self.name = name
        self.verts = []
        self.faces = []
        self.face_mat = []
        self.face_smooth = []
        self.loop_uv = []
        self.has_uv = False
        self.mats = []
        self.vattr = {}

    # -- low level ---------------------------------------------------------
    def _mat_index(self, mat):
        if mat not in self.mats:
            self.mats.append(mat)
        return self.mats.index(mat)

    def _add_verts(self, pts, attrs):
        base = len(self.verts)
        for p in pts:
            self.verts.append((float(p[0]), float(p[1]), float(p[2])))
        for k in set(self.vattr) | set(attrs or {}):
            lst = self.vattr.setdefault(k, [0.0] * base)
            val = (attrs or {}).get(k, 0.0)
            if isinstance(val, (list, tuple)):
                lst.extend(float(v) for v in val)
            else:
                lst.extend([float(val)] * len(pts))
        return base

    def _add_face(self, idx, mat, uvs, smooth):
        self.faces.append(tuple(idx))
        self.face_mat.append(self._mat_index(mat))
        self.face_smooth.append(bool(smooth))
        if uvs is not None:
            self.has_uv = True
            self.loop_uv.extend(uvs)
        else:
            self.loop_uv.extend([(0.0, 0.0)] * len(idx))

    def poly(self, pts, mat, uvs=None, smooth=False, attrs=None):
        """Add one polygon with its own (unshared) vertices."""
        if len(pts) < 3:
            return
        base = self._add_verts(pts, attrs)
        self._add_face(range(base, base + len(pts)), mat, uvs, smooth)

    def quad(self, a, b, c, d, mat, uvs=None, attrs=None):
        self.poly([a, b, c, d], mat, uvs, False, attrs)

    def grid(self, rows, mat, closed=True, smooth=True):
        """Shared-vertex surface. rows[i][j]: i runs up the surface, j runs
        counter-clockwise (seen from above / outside). A row may be a single
        point (pole) to close a cone or dome."""
        idx_rows = []
        for i, row in enumerate(rows):
            base = self._add_verts(row, None)
            idx_rows.append(list(range(base, base + len(row))))
        for i in range(len(rows) - 1):
            ra, rb = idx_rows[i], idx_rows[i + 1]
            n = max(len(ra), len(rb))
            segs = n if closed else n - 1
            for j in range(segs):
                j1 = (j + 1) % n
                if len(rb) == 1:
                    face = [ra[j], ra[j1], rb[0]]
                elif len(ra) == 1:
                    face = [ra[0], rb[j1], rb[j]]
                else:
                    face = [ra[j], ra[j1], rb[j1], rb[j]]
                self._add_face(face, mat, None, smooth)

    # -- primitives ----------------------------------------------------------
    def box(self, x0, y0, z0, x1, y1, z1, mat, skip=""):
        """Axis-aligned box. `skip` lists faces to omit: any of
        'n','s','e','w','t','b' (north=+y, south=-y, east=+x, west=-x, top, bottom)."""
        if x1 < x0:
            x0, x1 = x1, x0
        if y1 < y0:
            y0, y1 = y1, y0
        if z1 < z0:
            z0, z1 = z1, z0
        if "s" not in skip:
            self.quad(V(x0, y0, z0), V(x1, y0, z0), V(x1, y0, z1), V(x0, y0, z1), mat)
        if "e" not in skip:
            self.quad(V(x1, y0, z0), V(x1, y1, z0), V(x1, y1, z1), V(x1, y0, z1), mat)
        if "n" not in skip:
            self.quad(V(x1, y1, z0), V(x0, y1, z0), V(x0, y1, z1), V(x1, y1, z1), mat)
        if "w" not in skip:
            self.quad(V(x0, y1, z0), V(x0, y0, z0), V(x0, y0, z1), V(x0, y1, z1), mat)
        if "t" not in skip:
            self.quad(V(x0, y0, z1), V(x1, y0, z1), V(x1, y1, z1), V(x0, y1, z1), mat)
        if "b" not in skip:
            self.quad(V(x0, y0, z0), V(x0, y1, z0), V(x1, y1, z0), V(x1, y0, z0), mat)

    def cbox(self, cx, cy, w, d, z0, z1, mat, skip=""):
        """Box centred on (cx, cy) with width w (x) and depth d (y)."""
        self.box(cx - w / 2, cy - d / 2, z0, cx + w / 2, cy + d / 2, z1, mat, skip)

    def prism(self, outline, z0, z1, mat, top=True, bottom=False, top_mat=None, sides=True):
        """Vertical prism over a CCW outline [(x, y), ...]."""
        n = len(outline)
        if sides:
            for i in range(n):
                a, b = outline[i], outline[(i + 1) % n]
                self.quad(V(a[0], a[1], z0), V(b[0], b[1], z0), V(b[0], b[1], z1), V(a[0], a[1], z1), mat)
        if top:
            self.poly([V(p[0], p[1], z1) for p in outline], top_mat or mat)
        if bottom:
            self.poly([V(p[0], p[1], z0) for p in reversed(outline)], mat)

    def loft(self, outline0, z0, outline1, z1, mat, top=False, top_mat=None, bottom=False):
        """Connect two CCW outlines with the same vertex count (or apex if
        outline1 has a single point)."""
        n = len(outline0)
        for i in range(n):
            a0, b0 = outline0[i], outline0[(i + 1) % n]
            if len(outline1) == 1:
                ap = outline1[0]
                self.poly([V(a0[0], a0[1], z0), V(b0[0], b0[1], z0), V(ap[0], ap[1], z1)], mat)
            else:
                a1, b1 = outline1[i], outline1[(i + 1) % n]
                self.quad(V(a0[0], a0[1], z0), V(b0[0], b0[1], z0), V(b1[0], b1[1], z1), V(a1[0], a1[1], z1), mat)
        if top and len(outline1) > 2:
            self.poly([V(p[0], p[1], z1) for p in outline1], top_mat or mat)
        if bottom:
            self.poly([V(p[0], p[1], z0) for p in reversed(outline0)], mat)

    def revolve(self, profile, mat, segs=24, cx=0.0, cy=0.0, smooth=True, a0=0.0):
        """Surface of revolution around the vertical axis through (cx, cy).
        profile: [(r, z), ...] bottom to top. r == 0 makes a pole."""
        rows = []
        for r, z in profile:
            if r <= 1e-6:
                rows.append([V(cx, cy, z)])
            else:
                rows.append([V(cx + r * math.cos(a0 + 2 * math.pi * j / segs),
                               cy + r * math.sin(a0 + 2 * math.pi * j / segs), z) for j in range(segs)])
        self.grid(rows, mat, closed=True, smooth=smooth)

    def cylinder(self, cx, cy, r, z0, z1, mat, segs=16, top=True, bottom=False, smooth=True, r1=None):
        r1 = r if r1 is None else r1
        self.revolve([(r, z0), (r1, z1)], mat, segs, cx, cy, smooth)
        if top and r1 > 0:
            self.poly([V(cx + r1 * math.cos(2 * math.pi * j / segs), cy + r1 * math.sin(2 * math.pi * j / segs), z1)
                       for j in range(segs)], mat)
        if bottom:
            self.poly([V(cx + r * math.cos(2 * math.pi * j / segs), cy + r * math.sin(2 * math.pi * j / segs), z0)
                       for j in reversed(range(segs))], mat)

    def torus(self, cx, cy, cz, R, r, mat, segs=64, rsegs=10, smooth=True):
        """Horizontal torus. The tube profile is walked counter-clockwise in the
        (r, z) plane from its bottom, so grid() winding gives outward normals."""
        rows = []
        for i in range(rsegs + 1):
            t = 2 * math.pi * i / rsegs - math.pi / 2
            rr = R + r * math.cos(t)
            z = cz + r * math.sin(t)
            rows.append([V(cx + rr * math.cos(2 * math.pi * j / segs), cy + rr * math.sin(2 * math.pi * j / segs), z)
                         for j in range(segs)])
        self.grid(rows, mat, closed=True, smooth=smooth)

    def strip(self, path, width, mat, normal_hint, out=0.0):
        """Flat ribbon of given width centred on a 3D polyline lying on a
        surface whose outward normal is `normal_hint` (Vector)."""
        n = normal_hint
        for i in range(len(path) - 1):
            a, b = Vector(path[i]), Vector(path[i + 1])
            t = (b - a).normalized()
            side = n.cross(t).normalized() * (width / 2)
            off = n * out
            # CCW seen from outside (normal n): a-side, b-side, b+side, a+side
            self.quad(a - side + off, b - side + off, b + side + off, a + side + off, mat)

    # -- output -------------------------------------------------------------
    def is_empty(self):
        return not self.faces

    def to_objects(self, model, collection, split=True):
        """Create one object (or one per material if split) in `collection`.
        Object names are '<model>/<name>' or '<model>/<name>_<Material>'."""
        if self.is_empty():
            return []
        if not split or len(self.mats) == 1:
            groups = [(self.name, None)]
        else:
            groups = [(self.name + "_" + m, i) for i, m in enumerate(self.mats)]
        objs = []
        for oname, mi in groups:
            objs.append(self._make(model, collection, oname, mi))
        return objs

    def _make(self, model, collection, oname, only_mat):
        sel = [k for k in range(len(self.faces)) if only_mat is None or self.face_mat[k] == only_mat]
        # compact vertices
        remap = {}
        verts = []
        faces = []
        loop_uv = []
        loop_start = []
        acc = 0
        for k in range(len(self.faces)):
            loop_start.append(acc)
            acc += len(self.faces[k])
        attr_out = {k: [] for k in self.vattr}
        for k in sel:
            f = []
            for vi in self.faces[k]:
                if vi not in remap:
                    remap[vi] = len(verts)
                    verts.append(self.verts[vi])
                    for an, lst in self.vattr.items():
                        attr_out[an].append(lst[vi])
                f.append(remap[vi])
            faces.append(f)
            s = loop_start[k]
            loop_uv.extend(self.loop_uv[s:s + len(self.faces[k])])
        mats = [self.mats[only_mat]] if only_mat is not None else list(self.mats)
        me = bpy.data.meshes.new(model + PREFIX_SEP + oname)
        me.from_pydata(verts, [], faces)
        for m in mats:
            me.materials.append(get_material(m))
        if only_mat is None:
            me.polygons.foreach_set("material_index", [self.face_mat[k] for k in sel])
        me.polygons.foreach_set("use_smooth", [self.face_smooth[k] for k in sel])
        if self.has_uv:
            uvl = me.uv_layers.new(name="UVMap")
            flat = [c for uv in loop_uv for c in uv]
            uvl.data.foreach_set("uv", flat)
        for an, vals in attr_out.items():
            a = me.attributes.new(an, "FLOAT", "POINT")
            a.data.foreach_set("value", vals)
        me.validate(clean_customdata=False)
        me.update()
        ob = bpy.data.objects.new(model + PREFIX_SEP + oname, me)
        collection.objects.link(ob)
        return ob


class WindowBuilder(MeshBuilder):
    """Window quads with per-vertex `_floor` and `_seed` (identical on all
    vertices of one window) and a 0..1 UV per window."""

    def __init__(self, rng, name="Windows"):
        super().__init__(name)
        self.rng = rng
        self.count = 0

    def add(self, pts, floor, seed=None):
        """pts: corners CCW seen from outside; quads start bottom-left."""
        if seed is None:
            seed = self.rng.random()
        uvs = [(0, 0), (1, 0), (1, 1), (0, 1)] if len(pts) == 4 else planar_uvs(pts)
        self.poly(pts, "Window", uvs=uvs, attrs={"_floor": float(floor), "_seed": float(seed)})
        self.count += 1


def planar_uvs(pts):
    """0..1 UVs for a planar polygon: u left to right seen from outside, v up
    (horizontal panes: u along +x, v along +y)."""
    n = Vector((0.0, 0.0, 0.0))
    for i in range(len(pts)):
        a, b = Vector(pts[i]), Vector(pts[(i + 1) % len(pts)])
        n.x += (a.y - b.y) * (a.z + b.z)
        n.y += (a.z - b.z) * (a.x + b.x)
        n.z += (a.x - b.x) * (a.y + b.y)
    n.normalize()
    up = Vector((0.0, 0.0, 1.0))
    if abs(n.dot(up)) > 0.9:
        uax, vax = Vector((1.0, 0.0, 0.0)), Vector((0.0, 1.0, 0.0))
    else:
        uax, vax = up.cross(n).normalized(), up
    us = [Vector(p).dot(uax) for p in pts]
    vs = [Vector(p).dot(vax) for p in pts]
    du, dv = (max(us) - min(us)) or 1.0, (max(vs) - min(vs)) or 1.0
    return [((u - min(us)) / du, (v - min(vs)) / dv) for u, v in zip(us, vs)]


# ---------------------------------------------------------------------------
# Facades and outlines
# ---------------------------------------------------------------------------

class Facade:
    """A vertical wall plane from 2D point a (left, seen from outside) to b.
    Local coordinates: s along the wall from a, z up, `out` along the outward normal."""

    def __init__(self, a, b):
        self.a = V(a[0], a[1], 0.0)
        self.b = V(b[0], b[1], 0.0)
        d = self.b - self.a
        self.length = d.length
        self.u = d.normalized()
        self.n = V(self.u.y, -self.u.x, 0.0)

    def p(self, s, z, out=0.0):
        return self.a + self.u * s + self.n * out + V(0, 0, z)

    def rect(self, s0, s1, z0, z1, out=0.0):
        return [self.p(s0, z0, out), self.p(s1, z0, out), self.p(s1, z1, out), self.p(s0, z1, out)]

    def slab(self, mb, s0, s1, z0, z1, out0, out1, mat, skip=""):
        """A box attached to the facade spanning s0..s1, z0..z1 and from out0
        to out1 along the normal. skip: 'l','r','t','b','f','k' (left, right,
        top, bottom, front, back)."""
        P = self.p
        if "f" not in skip:
            mb.quad(P(s0, z0, out1), P(s1, z0, out1), P(s1, z1, out1), P(s0, z1, out1), mat)
        if "k" not in skip:
            mb.quad(P(s1, z0, out0), P(s0, z0, out0), P(s0, z1, out0), P(s1, z1, out0), mat)
        if "l" not in skip:
            mb.quad(P(s0, z0, out0), P(s0, z0, out1), P(s0, z1, out1), P(s0, z1, out0), mat)
        if "r" not in skip:
            mb.quad(P(s1, z0, out1), P(s1, z0, out0), P(s1, z1, out0), P(s1, z1, out1), mat)
        if "t" not in skip:
            mb.quad(P(s0, z1, out1), P(s1, z1, out1), P(s1, z1, out0), P(s0, z1, out0), mat)
        if "b" not in skip:
            mb.quad(P(s0, z0, out0), P(s1, z0, out0), P(s1, z0, out1), P(s0, z0, out1), mat)

    def plate(self, mb, poly2d, out0, out1, mat, back=True, sides=True, skip_edges=()):
        """Extrude a CCW polygon given in facade (s, z) coordinates from out0
        (back) to out1 (front). Edge i runs from vertex i to i+1."""
        P = self.p
        mb.poly([P(s, z, out1) for s, z in poly2d], mat)
        if back:
            mb.poly([P(s, z, out0) for s, z in reversed(poly2d)], mat)
        if sides:
            n = len(poly2d)
            for i in range(n):
                if i in skip_edges:
                    continue
                (sa, za), (sb, zb) = poly2d[i], poly2d[(i + 1) % n]
                mb.quad(P(sb, zb, out1), P(sa, za, out1), P(sa, za, out0), P(sb, zb, out0), mat)


def rect_outline(w, d, cx=0.0, cy=0.0):
    hx, hy = w / 2, d / 2
    return [(cx - hx, cy - hy), (cx + hx, cy - hy), (cx + hx, cy + hy), (cx - hx, cy + hy)]


def chamfer_outline(w, d, c, cx=0.0, cy=0.0):
    hx, hy = w / 2, d / 2
    return [(cx - hx + c, cy - hy), (cx + hx - c, cy - hy), (cx + hx, cy - hy + c), (cx + hx, cy + hy - c),
            (cx + hx - c, cy + hy), (cx - hx + c, cy + hy), (cx - hx, cy + hy - c), (cx - hx, cy - hy + c)]


def rect_facades(w, d, cx=0.0, cy=0.0):
    """South, east, north, west facades of a w x d rectangle."""
    o = rect_outline(w, d, cx, cy)
    return [Facade(o[i], o[(i + 1) % 4]) for i in range(4)]


def outline_facades(outline):
    return [Facade(outline[i], outline[(i + 1) % len(outline)]) for i in range(len(outline))]


def offset_outline(outline, dist):
    """Offset a convex CCW outline outward by dist (negative = inward)."""
    n = len(outline)
    out = []
    for i in range(n):
        p0 = Vector(outline[i - 1])
        p1 = Vector(outline[i])
        p2 = Vector(outline[(i + 1) % n])
        d0 = (p1 - p0).normalized()
        d1 = (p2 - p1).normalized()
        n0 = Vector((d0.y, -d0.x))
        n1 = Vector((d1.y, -d1.x))
        bis = (n0 + n1)
        if bis.length < 1e-9:
            bis = n0
        bis.normalize()
        scale = dist / max(bis.dot(n0), 1e-6)
        q = p1 + bis * scale
        out.append((q.x, q.y))
    return out


def rotate_outline(outline, a):
    c, s = math.cos(a), math.sin(a)
    return [(x * c - y * s, x * s + y * c) for x, y in outline]


def circle(r, n, cx=0.0, cy=0.0, a0=0.0):
    return [(cx + r * math.cos(a0 + 2 * math.pi * k / n), cy + r * math.sin(a0 + 2 * math.pi * k / n)) for k in range(n)]


def superellipse(a, b, n=4.0, count=48, cx=0.0, cy=0.0):
    """CCW squircle outline resampled to `count` points of equal spacing."""
    dense = []
    for k in range(720):
        t = 2 * math.pi * k / 720
        c, s = math.cos(t), math.sin(t)
        dense.append((cx + a * math.copysign(abs(c) ** (2 / n), c), cy + b * math.copysign(abs(s) ** (2 / n), s)))
    lens = [0.0]
    for k in range(1, len(dense) + 1):
        lens.append(lens[-1] + math.dist(dense[k - 1], dense[k % len(dense)]))
    total = lens[-1]
    out = []
    j = 0
    for k in range(count):
        target = total * k / count
        while lens[j + 1] < target:
            j += 1
        f = (target - lens[j]) / max(lens[j + 1] - lens[j], 1e-9)
        p, q = dense[j], dense[(j + 1) % len(dense)]
        out.append((p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f))
    return out


def even_bays(length, n, pier, margin):
    """Split [margin, length - margin] into n bays separated by n-1 piers of
    width `pier`. Returns list of (s0, s1) bay extents and pier extents."""
    inner = length - 2 * margin
    bay = (inner - (n - 1) * pier) / n
    bays, piers = [], []
    s = margin
    for i in range(n):
        bays.append((s, s + bay))
        s += bay
        if i < n - 1:
            piers.append((s, s + pier))
            s += pier
    return bays, piers


def best_bay_count(length, target, pier, margin):
    inner = length - 2 * margin
    return max(1, int(round((inner + pier) / (target + pier))))


# ---------------------------------------------------------------------------
# Model context
# ---------------------------------------------------------------------------

class Model:
    """Collects the builders and metadata of one hero tower."""

    def __init__(self, key, floors):
        self.key = key
        self.rng = random.Random("%s:%d" % (key, SEED))
        self.floors = floors
        self.body = MeshBuilder("Body")
        self.windows = WindowBuilder(self.rng)
        self.crown = MeshBuilder("Crown")
        self.accent = MeshBuilder("Accent")
        self.extra = []            # additional MeshBuilders (LED, Ring, Screen_n, Flag_n ...)
        self.empties = {}          # name -> (x, y, z) in Blender coordinates
        self.meta = {}             # manifest values that cannot be derived from geometry

    def add_extra(self, mb):
        self.extra.append(mb)
        return mb

    def empty(self, name, x, y, z):
        self.empties[name] = (x, y, z)


# ---------------------------------------------------------------------------
# Shared architectural helpers
# ---------------------------------------------------------------------------

def window_rows(m, fac, bays, floors, sill=0.07, head=0.07, inset=0.025, out=WIN_PROUD, exclude=()):
    """Punch one window per bay per floor onto facade `fac`. `exclude` is a
    list of (s0, s1, z0, z1) facade rectangles where no windows go."""
    F = m.floors
    for fi in floors:
        wz0, wz1 = F.z0(fi) + sill, F.z1(fi) - head
        for s0, s1 in bays:
            if any(s1 > e0 and s0 < e1 and wz1 > ez0 and wz0 < ez1 for e0, e1, ez0, ez1 in exclude):
                continue
            m.windows.add(fac.rect(s0 + inset, s1 - inset, wz0, wz1, out), fi)


def tall_window(m, fac, s0, s1, zb, zt, out, mullion=0.035, arch=False, seed=None):
    """A tall window split into one pane per floor (so it lights per floor);
    with arch=True the top pane gets a round head reaching zt."""
    F = m.floors
    r = (s1 - s0) / 2
    zs = zt - r if arch else zt
    z = zb
    seed = m.rng.random() if seed is None else seed
    while z < zs - 0.05:
        fl = F.at(z + 1e-4)
        z_next = min(F.z1(fl), zs)
        last = z_next >= zs - 0.12
        if last:
            z_next = zs
        top = z_next - (0 if (last and arch) else mullion / 2)
        bot = z + (mullion / 2 if z > zb else 0)
        if last and arch:
            m.windows.add([fac.p(s, zz, out) for s, zz in arch_poly(s0, s1, bot, zs)], fl, seed)
        else:
            m.windows.add(fac.rect(s0, s1, bot, top, out), fl, seed)
        z = z_next


def stepped_cap(mb, cx, cy, w, d, z, steps, mat, step_h=0.08, step_in=0.05):
    """Small stepped (ziggurat) cap: a stack of shrinking boxes starting at z."""
    for k in range(steps):
        mb.cbox(cx, cy, w - 2 * k * step_in, d - 2 * k * step_in, z + k * step_h, z + (k + 1) * step_h, mat, skip="b")
    return z + steps * step_h


def obox(mb, c, ax, ay, az, hx, hy, hz, mat, skip=""):
    """Box centred at c with right-handed orthonormal axes (ax, ay, az) and
    half sizes. Face letters as in MeshBuilder.box (relative to the axes)."""
    def P(i, j, k):
        return c + ax * (i * hx) + ay * (j * hy) + az * (k * hz)
    if "s" not in skip:
        mb.quad(P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1), P(-1, -1, 1), mat)
    if "e" not in skip:
        mb.quad(P(1, -1, -1), P(1, 1, -1), P(1, 1, 1), P(1, -1, 1), mat)
    if "n" not in skip:
        mb.quad(P(1, 1, -1), P(-1, 1, -1), P(-1, 1, 1), P(1, 1, 1), mat)
    if "w" not in skip:
        mb.quad(P(-1, 1, -1), P(-1, -1, -1), P(-1, -1, 1), P(-1, 1, 1), mat)
    if "t" not in skip:
        mb.quad(P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1), mat)
    if "b" not in skip:
        mb.quad(P(-1, -1, -1), P(-1, 1, -1), P(1, 1, -1), P(1, -1, -1), mat)


def ring_flat(mb, outer, inner, z, mat, up=True):
    """Flat ring between two outlines with matching vertex counts."""
    n = len(outer)
    for k in range(n):
        a0, b0 = outer[k], outer[(k + 1) % n]
        a1, b1 = inner[k], inner[(k + 1) % n]
        q = [V(a0[0], a0[1], z), V(b0[0], b0[1], z), V(b1[0], b1[1], z), V(a1[0], a1[1], z)]
        mb.poly(q if up else list(reversed(q)), mat)


def band(mb, outline, z0, z1, out, mat, depth=0.08, top=True, bottom=True):
    """Closed horizontal band wrapping an outline, its face `out` units
    outside it and `depth` thick."""
    o = offset_outline(outline, out)
    i = offset_outline(outline, out - depth)
    mb.prism(o, z0, z1, mat, top=False)
    if top:
        ring_flat(mb, o, i, z1, mat, up=True)
    if bottom:
        ring_flat(mb, o, i, z0, mat, up=False)


def outline_strip(mb, outline, z0, z1, out, mat):
    """Light strip following an outline, standing `out` proud of it, closed
    at the top and bottom so its back is never visible."""
    band(mb, outline, z0, z1, out, mat, depth=out + 0.005)


def water_tower(m, cx, cy, z, r=0.42, h=0.75, legs=0.55):
    """Classic NYC rooftop water tank on a steel stand with a conical cap."""
    b = m.body
    # stand: four legs + a platform
    for sx in (-1, 1):
        for sy in (-1, 1):
            b.cbox(cx + sx * r * 0.62, cy + sy * r * 0.62, 0.06, 0.06, z, z + legs, "Metal", skip="b")
    b.cbox(cx, cy, r * 2.1, 0.04, z + legs * 0.45, z + legs * 0.45 + 0.03, "Metal")
    b.cbox(cx, cy, 0.04, r * 2.1, z + legs * 0.45, z + legs * 0.45 + 0.03, "Metal")
    b.cylinder(cx, cy, r * 1.08, z + legs, z + legs + 0.05, "Metal", segs=16, top=True, bottom=True)
    # tank (wood staves) with hoops
    tz0 = z + legs + 0.05
    b.cylinder(cx, cy, r, tz0, tz0 + h, "Roof", segs=16, top=False, bottom=False)
    for k in (0.2, 0.5, 0.8):
        hz = tz0 + h * k
        band(b, circle(r, 16, cx, cy), hz, hz + 0.025, 0.015, "Metal", depth=0.02)
    # conical roof
    b.revolve([(r + 0.04, tz0 + h), (0.0, tz0 + h + r * 0.75)], "Roof", segs=16, cx=cx, cy=cy, smooth=False)
    return tz0 + h + r * 0.75


# ---------------------------------------------------------------------------
# Classical vocabulary (columns, arches, stairs, flags)
# ---------------------------------------------------------------------------

def star_ring(r, flutes, z, cx, cy, depth=0.9):
    pts = []
    for k in range(2 * flutes):
        rr = r if k % 2 == 0 else r * depth
        a = math.pi * k / flutes
        pts.append(V(cx + rr * math.cos(a), cy + rr * math.sin(a), z))
    return pts


def column(mb, cx, cy, z0, h, r, mat="Marble", flutes=16, order="corinthian", plinth=True):
    """Classical column standing at z0, total height h (plinth to abacus top).
    The shaft is a fluted star prism with entasis; the capital is a flared
    bell ('corinthian') or a simple echinus ('doric')."""
    z = z0
    if plinth:
        mb.cbox(cx, cy, 2.7 * r, 2.7 * r, z, z + 0.4 * r, mat, skip="b")
        z += 0.4 * r
    mb.revolve([(1.32 * r, z), (1.3 * r, z + 0.18 * r), (1.1 * r, z + 0.3 * r), (1.05 * r, z + 0.42 * r),
                (0.85 * r, z + 0.42 * r)], mat, segs=16, cx=cx, cy=cy)
    z += 0.42 * r
    cap_h = (1.3 if order == "corinthian" else 0.55) * r
    abacus_h = 0.3 * r
    zs = z0 + h - cap_h - abacus_h
    mb.grid([star_ring(r, flutes, z, cx, cy), star_ring(0.86 * r, flutes, zs, cx, cy)], mat, closed=True, smooth=False)
    if order == "corinthian":
        prof = [(0.75 * r, zs), (0.95 * r, zs), (0.97 * r, zs + 0.12 * r), (1.0 * r, zs + 0.55 * r),
                (1.18 * r, zs + 0.68 * r), (1.22 * r, zs + 1.0 * r), (1.42 * r, zs + cap_h)]
    else:
        prof = [(0.75 * r, zs), (0.95 * r, zs), (0.95 * r, zs + 0.18 * r), (1.3 * r, zs + cap_h)]
    mb.revolve(prof, mat, segs=16, cx=cx, cy=cy, smooth=True)
    z = zs + cap_h
    mb.cbox(cx, cy, 2.9 * r, 2.9 * r, z, z + abacus_h, mat)
    return z + abacus_h


def arch_poly(s0, s1, zb, zs, segs=10):
    """Round-headed opening in facade coords: rectangle zb..zs plus a semicircle."""
    r, sc = (s1 - s0) / 2, (s0 + s1) / 2
    pts = [(s0, zb), (s1, zb), (s1, zs)]
    for k in range(1, segs):
        t = math.pi * k / segs
        pts.append((sc + r * math.cos(t), zs + r * math.sin(t)))
    pts.append((s0, zs))
    return pts


def arch_window_poly(s0, s1, wz0, zs, segs=10):
    """The part of a round-headed opening (s0..s1, springing at zs) above wz0:
    a rectangle-plus-arch if wz0 is below the springing line, else a circular
    segment."""
    if wz0 < zs - 1e-4:
        return arch_poly(s0, s1, wz0, zs, segs)
    r, sc = (s1 - s0) / 2, (s0 + s1) / 2
    h = wz0 - zs
    if h >= r - 0.02:
        return []
    a0 = math.asin(h / r)
    pts = []
    for k in range(segs + 1):
        t = a0 + (math.pi - 2 * a0) * k / segs
        pts.append((sc + r * math.cos(t), zs + r * math.sin(t)))
    return pts


def arch_ring(sc, zs, r_in, r_out, segs=10):
    outer = [(sc + r_out * math.cos(math.pi * k / segs), zs + r_out * math.sin(math.pi * k / segs)) for k in range(segs + 1)]
    inner = [(sc + r_in * math.cos(math.pi * k / segs), zs + r_in * math.sin(math.pi * k / segs)) for k in range(segs, -1, -1)]
    return outer + inner


def stairs(mb, x0, x1, y_front, y_back, z_top, n, mat):
    """Straight flight rising from y_front (south) to y_back, n risers."""
    rise = z_top / n
    tread = (y_back - y_front) / n
    for k in range(n):
        y = y_front + k * tread
        z0, z1 = k * rise, (k + 1) * rise
        mb.quad(V(x0, y, z0), V(x1, y, z0), V(x1, y, z1), V(x0, y, z1), mat)
        mb.quad(V(x0, y, z1), V(x1, y, z1), V(x1, y_back, z1), V(x0, y_back, z1), mat) if k == n - 1 else \
            mb.quad(V(x0, y, z1), V(x1, y, z1), V(x1, y + tread, z1), V(x0, y + tread, z1), mat)
    prof = [(y_front, 0.0), (y_back, 0.0), (y_back, z_top)]
    for k in range(n - 1, -1, -1):
        y = y_front + k * tread
        prof.append((y, (k + 1) * rise))
        prof.append((y, k * rise))
    prof = prof[:-1]
    mb.poly([V(x1, y, z) for y, z in prof], mat)
    mb.poly([V(x0, y, z) for y, z in reversed(prof)], mat)


def flag(m, name, hoist_x, hoist_y, z_top, w, h, direction=1.0, cols=8, rows=3, wave=0.05):
    """A flag hanging from a vertical pole at (hoist_x, hoist_y), flying along
    +x (direction=1) or -x. UV u runs hoist -> fly, v bottom -> top."""
    fb = m.add_extra(MeshBuilder(name))
    pts = {}
    for i in range(cols + 1):
        u = i / cols
        for j in range(rows + 1):
            v = j / rows
            x = hoist_x + direction * (0.02 + u * w)
            y = hoist_y + wave * math.sin(u * math.pi * 1.6) * (0.3 + u)
            z = z_top - h + v * h - 0.04 * u * u
            pts[i, j] = V(x, y, z)
    for i in range(cols):
        for j in range(rows):
            q = [pts[i, j], pts[i + 1, j], pts[i + 1, j + 1], pts[i, j + 1]]
            uv = [(i / cols, j / rows), ((i + 1) / cols, j / rows), ((i + 1) / cols, (j + 1) / rows), (i / cols, (j + 1) / rows)]
            if direction < 0:
                q = [q[1], q[0], q[3], q[2]]
                uv = [uv[1], uv[0], uv[3], uv[2]]
            fb.quad(*q, "Flag", uvs=uv)
    return fb


# ---------------------------------------------------------------------------
# 1. deco-spire (HQ)
# ---------------------------------------------------------------------------

def deco_bays(L, corner, n, bay):
    """n bays of width `bay` between corner piers of width `corner`, separated
    by n-1 equal intermediate piers. Returns (bays, piers) as (s0, s1) lists."""
    p = (L - 2 * corner - n * bay) / (n - 1) if n > 1 else 0.0
    bays, piers = [], []
    s = corner if n > 1 else (L - bay) / 2
    for i in range(n):
        bays.append((s, s + bay))
        s += bay
        if i < n - 1:
            piers.append((s, s + p))
            s += p
    return bays, piers


def deco_tier(m, w, d, z0, z1, *, corner, layout, pier_d=0.1, parapet=0.22, post_ext=0.42, pier_ext=0.3,
              finial_steps=3, accent=True, post_z0=None, exclude=None):
    """One Art Deco tier. Continuous limestone piers run the full tier height
    and rise past the parapet into stepped caps; between them sit recessed bays,
    each holding a vertical ribbon of glazing (one tall window per floor with a
    thin dark bronze spandrel). Wide corner posts end in stepped finials.
    layout = ((bays front/back, bay width), (bays sides, bay width)).
    Windows of one bay share their _seed over runs of 3-6 floors, so lit floors
    form vertical streaks. Returns (parapet top, bays per facade)."""
    b = m.body
    F = m.floors
    rng = m.rng
    zt = z1 + parapet
    hx, hy = w / 2, d / 2
    band_out = -0.035                     # parapet band sits just behind the pier faces
    floors = F.between(z0, z1)
    all_bays = []
    for k, fac in enumerate(rect_facades(w, d)):
        L = fac.length
        n, bw = layout[k % 2]
        bays, piers = deco_bays(L, corner, n, bw)
        all_bays.append((bays, piers))
        ex = (exclude or {}).get(k, ())
        for s0, s1 in bays:
            b.quad(*fac.rect(s0, s1, z0, z1, -pier_d), "Trim")
            run, seed = 0, 0.0
            for fi in floors:
                if run == 0:
                    seed, run = rng.random(), rng.randint(3, 6)
                run -= 1
                wz0, wz1 = F.z0(fi) + 0.04, F.z1(fi) - 0.035
                if any(s1 > e0 and s0 < e1 and wz1 > ez0 and wz0 < ez1 for e0, e1, ez0, ez1 in ex):
                    continue
                m.windows.add(fac.rect(s0 + 0.035, s1 - 0.035, wz0, wz1, -pier_d + WIN_PROUD), fi, seed)
        ztop = zt + pier_ext
        for s0, s1 in piers:
            fac.slab(b, s0, s1, z0, ztop, -pier_d, 0.0, "Limestone", skip="kb")
            fac.slab(b, s0, s1, zt, ztop, -pier_d, 0.0, "Limestone", skip="flrtb")
            inset = min(0.06, (s1 - s0) * 0.12)
            for i in (1, 2):
                fac.slab(b, s0 + i * inset, s1 - i * inset, ztop + (i - 1) * 0.07, ztop + i * 0.07,
                         -pier_d + i * 0.015, -i * 0.015, "Limestone", skip="b")
        fac.slab(b, corner, L - corner, z1, zt, -pier_d, band_out, "Limestone", skip="klrt")
        if accent:
            m.accent.quad(*fac.rect(corner, L - corner, zt - 0.05, zt - 0.015, band_out + 0.012), "Accent")
    inner = rect_outline(w - 2 * pier_d, d - 2 * pier_d)
    outer = offset_outline(rect_outline(w, d), band_out)
    ring_flat(b, outer, inner, zt, "Limestone")
    b.prism(list(reversed(inner)), z1, zt, "Limestone", top=False)
    b.poly([V(p[0], p[1], z1) for p in inner], "Roof")
    pz0 = z0 if post_z0 is None else post_z0
    for sx in (-1, 1):
        for sy in (-1, 1):
            cx = sx * (hx - corner / 2)
            cy = sy * (hy - corner / 2)
            b.cbox(cx, cy, corner, corner, pz0, zt + post_ext, "Limestone", skip="b")
            stepped_cap(b, cx, cy, corner * 0.82, corner * 0.82, zt + post_ext, finial_steps, "Limestone",
                        step_h=0.08, step_in=corner * 0.11)
    return zt, all_bays


def deco_podium_base(m, w, d, base_top, bays, portal):
    """Ground + mezzanine of the podium: the tier's piers run down to the street
    on granite plinths; shop and mezzanine windows fill the bays."""
    b = m.body
    F = m.floors
    ps0, ps1 = portal
    for k, fac in enumerate(rect_facades(w, d)):
        L = fac.length
        bl, pl = bays[k]
        corner = bl[0][0]
        for s0, s1 in bl:
            if k == 0 and s1 > ps0 and s0 < ps1:
                continue
            m.windows.add(fac.rect(s0 + 0.03, s1 - 0.03, 0.05, F.z1(0) - 0.035, -0.1 + WIN_PROUD), 0)
            m.windows.add(fac.rect(s0 + 0.04, s1 - 0.04, F.z0(1) + 0.05, base_top - 0.05, -0.1 + WIN_PROUD), 1)
            fac.slab(b, s0, s1, F.z1(0) - 0.035, F.z1(0) + 0.035, -0.1, -0.05, "Trim", skip="kblr")
        for s0, s1 in pl + [(0.0, corner), (L - corner, L)]:
            fac.slab(b, s0 - 0.012, s1 + 0.012, 0.0, 0.42, 0.0, 0.025, "Stone", skip="kb")


def deco_portal(m, fac, pw=1.8, ph=2.3):
    """Tall stepped entrance portal projecting from facade `fac` with a lit
    lobby screen and a sunburst crest. Returns its (s0, s1, top) extent."""
    b = m.body
    F = m.floors
    L = fac.length
    s0, s1 = L / 2 - pw / 2, L / 2 + pw / 2
    fw = 0.18
    b.quad(*fac.rect(s0, s1, 0.0, ph, 0.02), "Stone")
    for i, depth in enumerate((0.12, 0.22)):
        e0, e1 = i * fw, (i + 1) * fw
        fac.slab(b, s0 - e1, s0 - e0, 0.0, ph + e0, 0.0, depth, "Limestone", skip="kb")
        fac.slab(b, s1 + e0, s1 + e1, 0.0, ph + e0, 0.0, depth, "Limestone", skip="kb")
        fac.slab(b, s0 - e1, s1 + e1, ph + e0, ph + e1, 0.0, depth, "Limestone", skip="k")
    # stepped crest above the lintel
    zc = ph + 2 * fw
    crest = [(s0 - 0.1, zc), (s1 + 0.1, zc), (s1 + 0.1, zc + 0.22), (s1 - 0.25, zc + 0.22),
             (s1 - 0.25, zc + 0.44), (L / 2 + 0.3, zc + 0.44), (L / 2 + 0.3, zc + 0.66),
             (L / 2 - 0.3, zc + 0.66), (L / 2 - 0.3, zc + 0.44), (s0 + 0.25, zc + 0.44),
             (s0 + 0.25, zc + 0.22), (s0 - 0.1, zc + 0.22)]
    fac.plate(b, crest, 0.0, 0.16, "Limestone", back=False, skip_edges=(0,))
    # glass: doors (floor 0) and a tall transom split per floor
    mul, cols = 0.035, 4
    cw = (pw - (cols + 1) * mul) / cols
    for c in range(cols):
        a = s0 + mul + c * (cw + mul)
        m.windows.add(fac.rect(a, a + cw, 0.02, F.z1(0) - 0.03, 0.02 + WIN_PROUD), 0, seed=0.03)
        for fi in F.between(F.z1(0), ph - 0.04):
            m.windows.add(fac.rect(a, a + cw, F.z0(fi) + 0.03, F.z1(fi) - 0.03, 0.02 + WIN_PROUD), fi, seed=0.03)
    # sunburst over the doors
    cxs, cz = L / 2, F.z1(0) + 0.05
    for k in range(7):
        ang = math.radians(15 + k * 25)
        p0 = fac.p(cxs + 0.12 * math.cos(ang), cz + 0.12 * math.sin(ang), 0.045)
        p1 = fac.p(cxs + 0.85 * math.cos(ang), cz + 0.85 * math.sin(ang), 0.045)
        m.accent.strip([p0, p1], 0.03, "Accent", normal_hint=fac.n)
    return (s0 - 2 * fw, s1 + 2 * fw, zc + 0.66)


def deco_crown_stage(m, w, d, z0, h, rise, sunburst=False, ribs=None):
    """A copper crown stage: walls with vertical ribs, a chevron gable on each
    face, lit gable edges and base band, and (optionally) a lit sunburst.
    ribs: optional ((front/back rib list), (side rib list)) of (s, width)."""
    b = m.body
    c = m.crown
    z1 = z0 + h
    for kf, fac in enumerate(rect_facades(w, d)):
        L = fac.length
        b.quad(*fac.rect(0.0, L, z0, z1), "Copper")
        # gable plate standing on the wall top, flush with the face
        fac.plate(b, [(0.0, z1), (L, z1), (L / 2, z1 + rise)], -0.06, 0.0, "Copper", skip_edges=(0,))
        # lit gable edges, kept just inside the plate's sloped edges
        ln = math.hypot(L / 2, rise)
        ds, dz = rise / ln * 0.04, (L / 2) / ln * 0.04
        c.strip([fac.p(0.05 + ds, z1 - dz + 0.03), fac.p(L / 2, z1 + rise - 0.06)], 0.05, "CrownLight",
                normal_hint=fac.n, out=0.012)
        c.strip([fac.p(L / 2, z1 + rise - 0.06), fac.p(L - 0.05 - ds, z1 - dz + 0.03)], 0.05, "CrownLight",
                normal_hint=fac.n, out=0.012)
        if ribs is not None:
            for s, rw in ribs[kf % 2]:
                fac.slab(b, s - rw / 2, s + rw / 2, z0, z1, 0.0, 0.09, "Copper", skip="kb")
        else:
            nf = max(3, int(L / 0.3))
            for k in range(1, nf):
                s = L * k / nf
                fac.slab(b, s - 0.025, s + 0.025, z0, z1, 0.0, 0.07, "Copper", skip="kb")

        if sunburst:
            cx = L / 2
            zb = z0 + 0.1
            for k in range(9):
                ang = math.radians(10 + k * 20)
                dx, dz = math.cos(ang), math.sin(ang)
                r0, rmax = 0.26, 0.0
                for i in range(1, 400):
                    t = i / 100.0
                    xx, zz = cx + dx * t, zb + dz * t
                    in_wall = 0.08 < xx < L - 0.08 and zz < z1
                    in_gable = zz >= z1 and (zz - z1) < rise * (1 - abs(xx - cx) / (L / 2)) - 0.1
                    if not (in_wall or in_gable):
                        break
                    rmax = t
                r1 = rmax - 0.06
                if r1 > r0 + 0.1:
                    p0 = fac.p(cx + dx * r0, zb + dz * r0, 0.075)
                    p1 = fac.p(cx + dx * r1, zb + dz * r1, 0.075)
                    c.strip([p0, p1], 0.045, "CrownLight", normal_hint=fac.n)
            c.poly([fac.p(cx + 0.2 * math.cos(math.pi * t / 8), zb + 0.2 * math.sin(math.pi * t / 8), 0.075)
                    for t in range(9)], "CrownLight")
    b.poly([V(p[0], p[1], z1) for p in rect_outline(w, d)], "Copper")
    band(c, rect_outline(w, d), z0, z0 + 0.06, 0.095, "CrownLight", depth=0.1)
    return z1


def build_deco_spire():
    F = Floors()
    m = Model("deco-spire", F)
    b = m.body
    # massing: (width, depth, first floor, last floor, corner pier, bay layout)
    # bay layout: ((bays on front/back, bay width), (bays on sides, bay width))
    tiers = [
        (9.2, 4.9, 0, 14, 1.15, ((5, 0.58), (3, 0.5))),     # podium
        (7.0, 4.3, 15, 54, 0.85, ((5, 0.5), (3, 0.5))),     # main shaft
        (5.6, 3.7, 55, 78, 0.7, ((5, 0.44), (3, 0.44))),
        (4.4, 3.1, 79, 94, 0.8, ((3, 0.48), (2, 0.48))),
        (3.4, 2.5, 95, 100, 0.6, ((3, 0.38), (2, 0.38))),   # belvedere under the copper crown
    ]
    zt = 0.0
    bays = None
    for i, (w, d, f0, f1, corner, layout) in enumerate(tiers):
        z1 = F.z1(f1)
        if i == 0:
            base_top = F.z1(1)
            portal = deco_portal(m, rect_facades(w, d)[0])
            ex = {k: [(-1.0, 99.0, 0.0, base_top)] for k in range(4)}
            ex[0].append((portal[0], portal[1], 0.0, portal[2]))
            zt, bays = deco_tier(m, w, d, 0.0, z1, corner=corner, layout=layout, parapet=0.3,
                                 post_ext=0.5, pier_ext=0.32, exclude=ex)
            deco_podium_base(m, w, d, base_top, bays, portal[:2])
            # podium roof: mechanical bulkheads beside the shaft
            b.cbox(-4.0, 1.0, 0.7, 1.3, z1, z1 + 0.45, "Roof", skip="b")
            b.cbox(4.0, -0.6, 0.6, 0.9, z1, z1 + 0.32, "Roof", skip="b")
        else:
            last = i == len(tiers) - 1
            zt, bays = deco_tier(m, w, d, F.z0(f0), z1, corner=corner, layout=layout,
                                 parapet=0.16 if last else 0.22, post_ext=1.35 if last else 0.5,
                                 pier_ext=1.0 if last else 0.3, finial_steps=3, accent=not last)
    # crown ribs continue the belvedere's piers (wide) and bay centres (slender)
    bw, bd = tiers[-1][0], tiers[-1][1]
    ribs = []
    for k, (half_b, half_c) in enumerate(((bw / 2, 2.9 / 2), (bd / 2, 2.15 / 2))):
        bl, pl = bays[k]
        rl = [((p0 + p1) / 2 - half_b + half_c, 0.13) for p0, p1 in pl]
        rl += [((s0 + s1) / 2 - half_b + half_c, 0.06) for s0, s1 in bl]
        ribs.append([r for r in rl if 0.1 < r[0] < 2 * half_c - 0.1])
    # copper crown: three stepped stages with chevron gables
    z = zt
    for k, (w, d, h, rise) in enumerate(((2.9, 2.15, 1.25, 0.8), (2.15, 1.6, 1.05, 0.62), (1.45, 1.1, 0.9, 0.48))):
        z0 = z
        z = deco_crown_stage(m, w, d, z0, h, rise, sunburst=(k == 0), ribs=ribs if k == 0 else None)
        if k == 1:
            m.empty("Searchlight", 0.0, 0.0, z0 + h * 0.55)
    roof = z
    b.loft(rect_outline(0.95, 0.75), roof, [(0.0, 0.0)], roof + 1.5, "Copper")
    nb, tip = roof + 0.6, 54.0
    b.revolve([(0.0, nb), (0.13, nb), (0.11, nb + 2.0), (0.075, nb + 5.0), (0.035, nb + 8.5), (0.0, tip)], "Metal",
              segs=8)
    for rz, rr in ((nb + 1.5, 0.2), (nb + 3.1, 0.16), (nb + 5.1, 0.11)):
        b.cylinder(0, 0, rr, rz, rz + 0.08, "Metal", segs=12, bottom=True, smooth=False)
    m.crown.revolve([(0.065, tip - 0.9), (0.05, tip - 0.45), (0.0, tip + 0.02)], "CrownLight", segs=8)
    m.empty("Beacon", 0.0, 0.0, tip)
    m.empty("Label", 0.0, 0.0, tip + 2.0)
    m.meta.update(roofHeight=round(roof, 3), floors=tiers[-1][3] + 1)
    return m


# ---------------------------------------------------------------------------
# 2. glass-led (ParlayLab)
# ---------------------------------------------------------------------------

def build_glass_led():
    F = Floors()
    m = Model("glass-led", F)
    b = m.body
    rng = m.rng
    W, D, C = 6.0, 4.6, 0.75
    outline = chamfer_outline(W, D, C)
    top_floor = 108
    roof = F.z1(top_floor)
    lobby_top = F.z1(1)
    screen_top = roof + 0.9
    led_f = (95, 100)
    led_z0, led_z1 = F.z0(led_f[0]) + 0.03, F.z1(led_f[1]) - 0.03
    mech = (34, 35, 70, 71)
    # glass skin, parapet screen and roof
    b.prism(outline, lobby_top, screen_top, "Glass", top=False)
    inner = offset_outline(outline, -0.08)
    b.prism(list(reversed(inner)), roof, screen_top, "Glass", top=False)
    ring_flat(b, outline, inner, screen_top, "Metal")
    b.poly([V(x, y, roof) for x, y in inner], "Roof")
    # recessed double-height lobby under a soffit, on slim columns
    lob = offset_outline(outline, -0.42)
    b.prism(lob, 0.0, lobby_top, "Glass", top=False)
    ring_flat(b, outline, lob, lobby_top, "Metal", up=False)
    for fac in outline_facades(lob):
        n = max(1, int(round(fac.length / 0.6)))
        for k in range(n):
            s0, s1 = fac.length * k / n, fac.length * (k + 1) / n
            m.windows.add(fac.rect(s0 + 0.025, s1 - 0.025, 0.03, lobby_top - 0.05, WIN_PROUD), 0,
                          seed=rng.uniform(0.0, 0.12))
    for x, y in offset_outline(outline, -0.13):
        b.cbox(x, y, 0.15, 0.15, 0.0, lobby_top, "Metal", skip="tb")
    for x in (-1.0, 1.0):
        for y in (-1, 1):
            b.cbox(x, y * (D / 2 - 0.13), 0.15, 0.15, 0.0, lobby_top, "Metal", skip="tb")
    # curtain wall: mullion fins, vision panels per floor, two mechanical floors.
    # The four chamfers stay solid dark glass with a vertical light seam that
    # runs from the lobby up into the LED band.
    for i, fac in enumerate(outline_facades(outline)):
        L = fac.length
        if i % 2 == 1:
            for s in (0.0, L):
                fac.slab(b, s - 0.02, s + 0.02, lobby_top, screen_top, -0.03, 0.05, "Metal", skip="kb")
            m.accent.quad(*fac.rect(L / 2 - 0.05, L / 2 + 0.05, lobby_top + 0.05, led_z0 - 0.07, 0.014), "Accent")
            m.accent.quad(*fac.rect(L / 2 - 0.05, L / 2 + 0.05, led_z1 + 0.07, roof - 0.06, 0.014), "Accent")
            for f0 in mech[::2]:
                b.quad(*fac.rect(0.0, L, F.z0(f0) + 0.02, F.z1(f0 + 1) - 0.02, 0.012), "Metal")
            continue
        n = max(1, int(round(L / 0.55)))
        bw = L / n
        for k in range(1, n):
            s = k * bw
            fac.slab(b, s - 0.02, s + 0.02, lobby_top, screen_top, -0.03, 0.05, "Metal", skip="kb")
        for fl in range(2, top_floor + 1):
            if led_f[0] <= fl <= led_f[1] or fl in mech:
                continue
            z0, z1 = F.z0(fl), F.z1(fl)
            run, seed = 0, 0.0
            for k in range(n):
                if run == 0:          # lit office runs along the floor
                    run, seed = rng.randint(2, 5), rng.random()
                run -= 1
                m.windows.add(fac.rect(k * bw + 0.035, (k + 1) * bw - 0.035, z0 + 0.06, z1 - 0.05, WIN_PROUD),
                              fl, seed)
        for f0 in mech[::2]:
            b.quad(*fac.rect(0.0, L, F.z0(f0) + 0.02, F.z1(f0 + 1) - 0.02, 0.012), "Metal")
    # LED band: u runs 0..1 counter-clockwise (left to right seen from outside),
    # starting and ending at the middle of the back (north) face.
    led = m.add_extra(MeshBuilder("LED"))
    lo = offset_outline(outline, 0.075)
    pts = [(0.0, D / 2 + 0.075)] + [lo[i] for i in (5, 6, 7, 0, 1, 2, 3, 4)] + [(0.0, D / 2 + 0.075)]
    segs = [(pts[i], pts[i + 1], math.dist(pts[i], pts[i + 1])) for i in range(len(pts) - 1)]
    total = sum(s[2] for s in segs)
    acc = 0.0
    for a, c, ln in segs:
        u0, u1 = acc / total, (acc + ln) / total
        acc += ln
        led.quad(V(a[0], a[1], led_z0), V(c[0], c[1], led_z0), V(c[0], c[1], led_z1), V(a[0], a[1], led_z1),
                 "LED", uvs=[(u0, 0), (u1, 0), (u1, 1), (u0, 1)])
    band(b, outline, led_z0 - 0.07, led_z0, 0.1, "Metal", depth=0.12)
    band(b, outline, led_z1, led_z1 + 0.07, 0.1, "Metal", depth=0.12)
    m.meta["led"] = {"name": "LED", "circumference": round(total, 3), "height": round(led_z1 - led_z0, 3),
                     "y": round(led_z0, 3)}
    # lit crown edge: a glowing line around the top of the parapet screen
    outline_strip(m.crown, outline, screen_top - 0.11, screen_top - 0.02, 0.058, "CrownLight")
    outline_strip(m.crown, outline, roof - 0.05, roof + 0.0, 0.058, "CrownLight")
    # rooftop plant room (hidden by the screen) and a beacon mast
    b.cbox(0.0, 0.3, 2.4, 1.8, roof, roof + 0.75, "Metal", skip="b")
    b.cylinder(0.0, 0.3, 0.05, roof + 0.75, roof + 2.4, "Metal", segs=6)
    m.empty("Beacon", 0.0, 0.3, roof + 2.45)
    m.empty("Label", 0.0, 0.0, roof + 2.45 + 2.0)
    m.meta.update(roofHeight=round(screen_top, 3), floors=top_floor + 1)
    return m


# ---------------------------------------------------------------------------
# 3. ring-cylinder (Halo)
# ---------------------------------------------------------------------------

def build_ring_cylinder():
    F = Floors()
    m = Model("ring-cylinder", F)
    b = m.body
    rng = m.rng
    N = 32
    R, Rf = 2.28, 2.56
    top_floor = 84
    roof = F.z1(top_floor)
    lobby_top = F.z1(1)
    fin_top = roof + 1.15
    a0 = -math.pi / 2 + math.pi / N            # a bay is centred on the front (-y)
    ang = [a0 + 2 * math.pi * j / N for j in range(N)]
    ring_pts = [(R * math.cos(a), R * math.sin(a)) for a in ang]
    # white spandrel drum (smooth N-gon) up to a parapet, roof inside
    rows = [[V(x, y, z) for x, y in ring_pts] for z in (lobby_top, roof + 0.45)]
    b.grid(rows, "Concrete", closed=True, smooth=True)
    inner = offset_outline(ring_pts, -0.1)
    rows = [[V(x, y, z) for x, y in reversed(inner)] for z in (roof, roof + 0.45)]
    b.grid(rows, "Concrete", closed=True, smooth=True)
    ring_flat(b, ring_pts, inner, roof + 0.45, "Concrete")
    b.poly([V(x, y, roof) for x, y in inner], "Roof")
    # glass lobby drum under a soffit
    lob = circle(1.95, N, a0=a0)
    b.grid([[V(x, y, z) for x, y in lob] for z in (0.0, lobby_top)], "Glass", closed=True, smooth=True)
    ring_flat(b, ring_pts, lob, lobby_top, "Concrete", up=False)
    for fac in outline_facades(lob):
        m.windows.add(fac.rect(0.03, fac.length - 0.03, 0.03, lobby_top - 0.05, WIN_PROUD), 0,
                      seed=rng.uniform(0.0, 0.12))
    # ribbon windows: one per bay per floor; seeds run around each floor in
    # stretches of 3-8 bays so lit windows read as horizontal bands
    facs = outline_facades(ring_pts)
    for fl in range(2, top_floor + 1):
        z0, z1 = F.z0(fl), F.z1(fl)
        run, seed = 0, 0.0
        for fac in facs:
            if run == 0:
                run, seed = rng.randint(3, 8), rng.random()
            run -= 1
            m.windows.add(fac.rect(0.055, fac.length - 0.055, z0 + 0.075, z1 - 0.06, WIN_PROUD), fl, seed)
    # white radial fins from the ground to above the roof (pilotis at the base)
    up = V(0, 0, 1)
    for a in ang:
        r_hat = V(math.cos(a), math.sin(a), 0)
        t_hat = V(-math.sin(a), math.cos(a), 0)
        c = r_hat * ((Rf + R - 0.02) / 2) + V(0, 0, (lobby_top + fin_top) / 2)
        obox(b, c, r_hat, t_hat, up, (Rf - R + 0.02) / 2, 0.032, (fin_top - lobby_top) / 2, "Concrete", skip="b")
        # below the soffit the fins become slender columns reaching the lobby glass
        c2 = r_hat * ((Rf + 1.95) / 2) + V(0, 0, lobby_top / 2)
        obox(b, c2, r_hat, t_hat, up, (Rf - 1.95) / 2, 0.032, lobby_top / 2, "Concrete", skip="wbt")
    # crown light: a glowing ring line around the fin tips, and one at the roof line
    m.crown.grid([[V(Rf * 1.006 * math.cos(a), Rf * 1.006 * math.sin(a), z) for a in ang]
                  for z in (fin_top - 0.12, fin_top - 0.03)], "CrownLight", closed=True, smooth=True)
    m.crown.grid([[V((R + 0.012) * math.cos(a), (R + 0.012) * math.sin(a), z) for a in ang]
                  for z in (roof + 0.3, roof + 0.38)], "CrownLight", closed=True, smooth=True)
    # the halo: a glowing torus floating above the roof, and a slender mast
    ring_z = fin_top + 1.35
    halo = m.add_extra(MeshBuilder("Ring"))
    halo.torus(0.0, 0.0, ring_z, 2.42, 0.14, "Ring", segs=96, rsegs=12)
    b.cylinder(0.0, 0.0, 0.06, roof, ring_z - 0.1, "Metal", segs=8, r1=0.035)
    b.cbox(0.0, 0.0, 1.6, 1.2, roof, roof + 0.4, "Roof", skip="b")
    m.empty("Beacon", 0.0, 0.0, ring_z)
    m.empty("Label", 0.0, 0.0, ring_z + 2.2)
    m.meta.update(roofHeight=round(roof + 0.45, 3), floors=top_floor + 1)
    return m


# ---------------------------------------------------------------------------
# 4. neoclassical (FedOps)
# ---------------------------------------------------------------------------

def build_neoclassical():
    F = Floors()
    m = Model("neoclassical", F)
    b = m.body
    rng = m.rng
    X = 4.25                      # half width of the temple
    plat = 0.5                    # podium / stylobate height
    y_col = -1.6                  # column centre line
    y_hall = -1.0                 # hall front wall (behind the colonnade)
    y_back = 2.38
    z_arch = 4.22                 # top of capitals = bottom of the architrave
    z_corn = 4.95                 # top of the cornice
    # podium, front stair between two cheek plinths
    b.box(-X - 0.15, -2.0, 0.0, X + 0.15, y_back + 0.1, plat, "Marble", skip="sb")
    stairs(b, -3.3, 3.3, -2.6, -2.0, plat, 4, "Marble")
    for sx in (-1, 1):
        b.box(sx * 3.3, -2.6, 0.0, sx * (X + 0.15), -2.0, plat + 0.14, "Marble", skip="b")
    # hall: front wall with a giant window screen, side and back walls
    hall = rect_outline(2 * X - 0.1, y_back - y_hall, 0.0, (y_back + y_hall) / 2)
    b.prism(hall, plat, z_arch, "Marble", top=False)
    # antae: solid piers framing the portico
    for sx in (-1, 1):
        b.box(sx * 3.55, -1.95, plat, sx * (X - 0.05), y_hall, z_arch, "Marble", skip="b")
    xs = [-2.75, -1.65, -0.55, 0.55, 1.65, 2.75]
    for x in xs:
        column(b, x, y_col, plat, z_arch - plat, 0.19, "Marble", flutes=16)
    # window screen behind the colonnade (panes split per floor), lit early
    front = Facade((-X + 0.05, y_hall), (X - 0.05, y_hall))
    gaps = [(-3.55, -2.95)] + [((xs[i] + 0.21), (xs[i + 1] - 0.21)) for i in range(5)] + [(2.95, 3.55)]
    for g0, g1 in gaps:
        s0, s1 = g0 + X - 0.05 + 0.04, g1 + X - 0.05 - 0.04
        front.slab(b, s0 - 0.05, s1 + 0.05, plat, 3.95, 0.0, 0.012, "Trim", skip="kb")
        tall_window(m, front, s0, s1, plat + 0.05, 3.85, 0.024, arch=False, seed=rng.uniform(0.0, 0.3))
    # porch ceiling
    b.poly([V(-3.55, -1.35, z_arch), V(-3.55, y_hall, z_arch), V(3.55, y_hall, z_arch), V(3.55, -1.35, z_arch)], "Marble")
    # side and back walls: pilasters and tall windows
    for fac in rect_facades(2 * X - 0.1, y_back - y_hall, 0.0, (y_back + y_hall) / 2)[1:]:
        L = fac.length
        n = 3 if L < 5 else 6
        bays, piers = even_bays(L, n, 0.28, 0.3)
        for s0, s1 in piers:
            fac.slab(b, s0, s1, plat, z_arch, 0.0, 0.08, "Marble", skip="kb")
        for s0, s1 in bays:
            c = (s0 + s1) / 2
            fac.slab(b, c - 0.3, c + 0.3, plat + 0.25, 3.95, 0.0, 0.012, "Trim", skip="kb")
            tall_window(m, fac, c - 0.25, c + 0.25, plat + 0.3, 3.85, 0.024, arch=True)
    # entablature wrapping portico + hall, then the roof
    ent = rect_outline(2 * X + 0.0, y_back - (-1.95), 0.0, (y_back - 1.95) / 2)
    band(b, ent, z_arch, z_arch + 0.26, 0.0, "Marble", depth=0.6)
    band(b, ent, z_arch + 0.26, z_arch + 0.52, -0.035, "Marble", depth=0.6, top=False, bottom=False)
    band(b, ent, z_arch + 0.52, z_arch + 0.58, 0.06, "Marble", depth=0.6, top=False)
    band(b, ent, z_arch + 0.58, z_corn, 0.15, "Marble", depth=0.75, top=True)
    b.poly([V(x, y, z_corn) for x, y in offset_outline(ent, -0.6)], "Roof")
    # pediment: recessed tympanum, raking cornices, sloped roof running back
    zp = z_corn + 1.2
    tymp = Facade((-X, -1.9), (X, -1.9))
    tymp.plate(b, [(0.15, z_corn), (2 * X - 0.15, z_corn), (X, zp - 0.12)], -1.95, 0.0, "Marble", back=False,
               skip_edges=(0,))
    for sgn in (-1, 1):
        a = V(sgn * (X + 0.12), -2.0, z_corn - 0.02)
        c = V(0.0, -2.0, zp)
        d = (c - a).normalized()
        az = d.cross(V(0, 1, 0)).normalized()
        if az.z < 0:
            az = -az
        ay = az.cross(d)
        mid = (a + c) / 2
        obox(b, mid + V(0, 0.95, 0) + az * 0.09, d, ay, az, (c - a).length / 2 + 0.06, 1.08, 0.1, "Marble",
             skip="")
        # lit raking edge on the cornice's front fascia (the pediment outline glows at night)
        m.crown.strip([a + az * 0.12 + V(0, -0.142, 0) + d * 0.1, c + az * 0.12 + V(0, -0.142, 0) - d * 0.05], 0.05,
                      "CrownLight", normal_hint=V(0, -1, 0))
    # relief: a central seal and reclining figures
    tymp.plate(b, [(X + 0.3 * math.cos(2 * math.pi * k / 16), z_corn + 0.48 + 0.3 * math.sin(2 * math.pi * k / 16))
                   for k in range(16)], -0.04, 0.05, "Marble", back=False)
    for sgn in (-1, 1):
        for k, (dx, w, h) in enumerate(((0.75, 0.42, 0.62), (1.4, 0.5, 0.42), (2.1, 0.55, 0.28), (2.8, 0.55, 0.15))):
            s = X + sgn * dx
            tymp.plate(b, [(s - w / 2, z_corn + 0.02), (s + w / 2, z_corn + 0.02), (s + w / 2, z_corn + 0.02 + h),
                           (s - w / 2, z_corn + 0.02 + h)], -0.03, 0.035, "Marble", back=False, skip_edges=(0,))
    # office block behind
    ox, oy0, oy1 = 3.7, 0.0, 2.45
    o_top = F.z1(24)
    office = rect_outline(2 * ox, oy1 - oy0, 0.0, (oy0 + oy1) / 2)
    b.prism(office, z_corn, o_top, "Marble", top=False)
    for k, fac in enumerate(rect_facades(2 * ox, oy1 - oy0, 0.0, (oy0 + oy1) / 2)):
        L = fac.length
        n = best_bay_count(L, 0.5, 0.0, 0.25)
        bays, _ = even_bays(L, n, 0.0, 0.25)
        floors = F.between(z_corn + 0.05, o_top)
        window_rows(m, fac, bays, floors, sill=0.08, head=0.07, inset=0.11, out=WIN_PROUD)
    band(b, office, o_top, o_top + 0.08, 0.04, "Marble", depth=0.3)
    band(b, office, o_top + 0.08, o_top + 0.22, 0.13, "Marble", depth=0.45)
    b.poly([V(x, y, o_top + 0.22) for x, y in offset_outline(office, 0.13 - 0.45)], "Roof")
    outline_strip(m.crown, office, o_top + 0.14, o_top + 0.2, 0.135, "CrownLight")
    # flags: two poles on the cheek plinths, one on the office roof
    for sx in (-1, 1):
        px, py = sx * 3.85, -2.3
        b.cylinder(px, py, 0.045, plat + 0.14, plat + 0.3, "Metal", segs=8)
        b.cylinder(px, py, 0.03, plat + 0.3, 4.55, "Metal", segs=8, r1=0.022)
        b.cylinder(px, py, 0.05, 4.55, 4.62, "Metal", segs=8)
        flag(m, "Flag_%d" % (0 if sx < 0 else 1), px, py, 4.45, 0.95, 0.6, direction=-sx)
    b.cylinder(0.0, 1.9, 0.035, o_top + 0.22, o_top + 1.7, "Metal", segs=8, r1=0.025)
    flag(m, "Flag_2", 0.0, 1.9, o_top + 1.62, 0.8, 0.5, direction=1.0)
    m.empty("Beacon", 0.0, 1.2, o_top + 0.3)
    m.empty("Label", 0.0, 1.0, o_top + 1.7 + 1.2)        # clear of the rooftop flag
    m.meta.update(roofHeight=round(o_top + 0.22, 3), floors=25)
    return m


# ---------------------------------------------------------------------------
# 5. warehouse-loft (GalleySwap)
# ---------------------------------------------------------------------------

def build_warehouse_loft():
    F = Floors(ground=0.7, fh=0.42)
    m = Model("warehouse-loft", F)
    b = m.body
    W, D = 9.0, 4.8
    corner, pier = 0.42, 0.22
    top_floor = 14
    z_top = F.z1(top_floor)
    z_attic = z_top + 0.62
    z_roof = z_attic + 0.2
    arcades = [(4, 6), (7, 9), (10, 12)]
    out_w = 0.012            # opening panels
    out_win = 0.026          # windows in front of the panels
    for k, fac in enumerate(rect_facades(W, D)):
        L = fac.length
        n = 7 if k % 2 == 0 else 4
        bays, piers = even_bays(L, n, pier, corner)
        # brick wall and the dark cast-iron storefront zone
        b.quad(*fac.rect(corner, L - corner, F.ground + 0.02, z_attic), "Brick")
        b.quad(*fac.rect(corner, L - corner, 0.0, F.ground + 0.02), "Trim")
        # corner piers (brick); the one at the facade end wraps the corner
        fac.slab(b, 0.0, corner, 0.0, z_attic, 0.0, 0.1, "Brick", skip="kbt")
        fac.slab(b, L - corner, L + 0.1, 0.0, z_attic, 0.0, 0.1, "Brick", skip="kbt")
        # bay piers above the storefront
        for s0, s1 in piers:
            fac.slab(b, s0, s1, F.ground + 0.1, z_top, 0.0, 0.07, "Brick", skip="kb")
        # storefront: iron columns, shop windows, cornice
        for s0, s1 in piers:
            fac.slab(b, s0 + 0.03, s1 - 0.03, 0.0, F.ground, 0.0, 0.06, "Trim", skip="kbt")
        for s0, s1 in bays:
            m.windows.add(fac.rect(s0 + 0.05, s1 - 0.05, 0.08, F.ground - 0.12, out_w), 0)
        fac.slab(b, corner, L - corner, F.ground - 0.06, F.ground + 0.1, 0.0, 0.12, "Trim", skip="k")
        # belt courses (limestone) between the sections
        for f0 in (4, 7, 10, 13):
            z = F.z0(f0)
            fac.slab(b, -0.1, L + 0.1, z - 0.05, z + 0.04, 0.0, 0.11, "Limestone", skip="k")
        for s0, s1 in bays:
            sc = (s0 + s1) / 2
            ow = (s1 - s0) - 0.12
            # lower floors: paired flat-headed windows with limestone lintels and sills
            for fl in range(1, 4):
                z0, z1 = F.z0(fl), F.z1(fl)
                for a, c in ((s0 + 0.08, sc - 0.04), (sc + 0.04, s1 - 0.08)):
                    m.windows.add(fac.rect(a, c, z0 + 0.1, z1 - 0.1, out_w), fl)
                fac.slab(b, s0 + 0.05, s1 - 0.05, z1 - 0.1, z1 - 0.045, 0.0, 0.035, "Limestone", skip="k")
                fac.slab(b, s0 + 0.06, s1 - 0.06, z0 + 0.06, z0 + 0.1, 0.0, 0.04, "Limestone", skip="k")
            # arcades: three floors under one round arch
            for fa, fc in arcades:
                zb = F.z0(fa) + 0.06
                ztop = F.z1(fc) - 0.1
                r = ow / 2
                zs = ztop - r
                fac.plate(b, arch_poly(sc - r, sc + r, zb, zs), 0.0, out_w, "Trim", back=False, sides=False)
                for fl in range(fa, fc):
                    z0, z1 = F.z0(fl), F.z1(fl)
                    for a, c in ((sc - r + 0.05, sc - 0.03), (sc + 0.03, sc + r - 0.05)):
                        m.windows.add(fac.rect(a, c, max(z0 + 0.05, zb + 0.03), z1 - 0.07, out_win), fl)
                pts = arch_window_poly(sc - r + 0.05, sc + r - 0.05, F.z0(fc) + 0.05, zs)
                if pts:
                    m.windows.add([fac.p(s, z, out_win) for s, z in pts], fc)
                fac.plate(b, arch_ring(sc, zs, r, r + 0.11), 0.0, 0.04, "Brick", back=False,
                          skip_edges=range(10, 22))
                fac.slab(b, sc - 0.07, sc + 0.07, zs + r - 0.03, zs + r + 0.15, 0.0, 0.06, "Limestone", skip="k")
            # top floors: two narrow round-headed openings per bay
            zb, ztop = F.z0(13) + 0.06, F.z1(14) - 0.08
            for a, c in ((s0 + 0.07, sc - 0.05), (sc + 0.05, s1 - 0.07)):
                r = (c - a) / 2
                zs = ztop - r
                fac.plate(b, arch_poly(a, c, zb, zs, segs=6), 0.0, out_w, "Trim", back=False, sides=False)
                m.windows.add(fac.rect(a + 0.03, c - 0.03, zb + 0.03, F.z1(13) - 0.06, out_win), 13)
                pts = arch_window_poly(a + 0.03, c - 0.03, F.z0(14) + 0.04, zs, segs=6)
                if pts:
                    m.windows.add([fac.p(s, z, out_win) for s, z in pts], 14)
                fac.plate(b, arch_ring((a + c) / 2, zs, r, r + 0.07, segs=6), 0.0, 0.03, "Brick", back=False,
                          skip_edges=range(6, 14))
        # painted sign band in the attic (front and east), framed by bulb strings
        if k in (0, 1):
            m0 = 1.0 if k == 0 else 0.6
            fac.slab(b, m0, L - m0, z_top + 0.1, z_attic - 0.08, 0.0, 0.02, "Limestone", skip="k")
            for zz in (z_top + 0.06, z_attic - 0.07):
                m.crown.quad(*fac.rect(m0 - 0.05, L - m0 + 0.05, zz, zz + 0.035, 0.03), "CrownLight")
    # corbelled cornice, coping, parapet and roof
    outline = rect_outline(W, D)
    band(b, outline, z_attic - 0.04, z_attic + 0.06, 0.12, "Brick", depth=0.25)
    band(b, outline, z_attic + 0.06, z_attic + 0.16, 0.15, "Brick", depth=0.3)
    band(b, outline, z_attic + 0.16, z_attic + 0.3, 0.17, "Trim", depth=0.45)
    inner = offset_outline(outline, -0.28)
    b.prism(list(reversed(inner)), z_roof, z_attic + 0.3, "Brick", top=False)
    b.poly([V(x, y, z_roof) for x, y in inner], "Roof")
    outline_strip(m.crown, outline, z_attic + 0.24, z_attic + 0.28, 0.172, "CrownLight")
    # dentils under the cornice on the street faces
    for k, fac in enumerate(rect_facades(W, D)[:2]):
        L = fac.length
        s = 0.3
        while s < L - 0.3:
            fac.slab(b, s, s + 0.08, z_attic - 0.13, z_attic - 0.04, 0.0, 0.1, "Brick", skip="kt")
            s += 0.26
    # fire escape on the east face
    east = rect_facades(W, D)[1]
    bays, _ = even_bays(east.length, 4, pier, corner)
    fe0, fe1 = bays[1][0] - 0.05, bays[2][1] + 0.05
    dep = 0.26
    for fl in range(2, top_floor + 1):
        z = F.z0(fl) + 0.02
        east.slab(b, fe0, fe1, z, z + 0.025, 0.0, dep, "Metal", skip="k")
        for zz in (z + 0.1, z + 0.2):
            east.slab(b, fe0, fe1, zz, zz + 0.02, dep - 0.02, dep, "Metal", skip="k")
        for s in (fe0, fe1 - 0.02):
            east.slab(b, s, s + 0.02, z, z + 0.22, dep - 0.02, dep, "Metal", skip="kb")
        if fl < top_floor:
            sa, sb = (fe0 + 0.15, fe1 - 0.45) if fl % 2 else (fe1 - 0.15, fe0 + 0.45)
            pa = east.p(sa, z + 0.025, dep * 0.55)
            pb = east.p(sb, F.z0(fl + 1) + 0.02, dep * 0.55)
            d = (pb - pa)
            ax = d.normalized()
            ay = east.n.copy()
            az = ax.cross(ay).normalized()
            if az.z < 0:
                az = -az
                ay = -ay
            obox(b, (pa + pb) / 2, ax, ay, az, d.length / 2, 0.1, 0.012, "Metal")
    # rooftop: water tower and a brick stair bulkhead
    top = water_tower(m, -2.7, 0.9, z_roof, r=0.48, h=0.85, legs=0.6)
    b.cbox(2.6, 1.0, 1.3, 1.0, z_roof, z_roof + 0.65, "Brick", skip="b")
    b.cbox(2.6, 1.0, 1.42, 1.12, z_roof + 0.65, z_roof + 0.72, "Trim", skip="")
    m.empty("Beacon", -2.7, 0.9, top + 0.05)
    m.empty("Label", 0.0, 0.0, top + 2.0)
    m.meta.update(roofHeight=round(z_attic + 0.3, 3), floors=top_floor + 1)
    return m


# ---------------------------------------------------------------------------
# 6. twist-tower (AverageOutput / OTHERLIFE)
# ---------------------------------------------------------------------------

def build_twist_tower():
    F = Floors()
    m = Model("twist-tower", F)
    b = m.body
    rng = m.rng
    S, C = 3.84, 0.3                     # square plate with small chamfers; fits 5.2 at any angle
    plate = chamfer_outline(S, S, C)
    top_floor = 116
    roof = F.z1(top_floor)
    lobby_top = F.z1(1)
    twist = math.radians(90.0)
    slab_t = 0.09
    # lobby: recessed glass under the first slab, white columns
    lob = offset_outline(plate, -0.45)
    b.prism(lob, 0.0, lobby_top, "Glass", top=False)
    for fac in outline_facades(lob):
        n = max(1, int(round(fac.length / 0.6)))
        for k in range(n):
            s0, s1 = fac.length * k / n, fac.length * (k + 1) / n
            m.windows.add(fac.rect(s0 + 0.025, s1 - 0.025, 0.03, lobby_top - 0.05, WIN_PROUD), 0,
                          seed=rng.uniform(0.0, 0.12))
    for x, y in rect_outline(S - 0.3, S - 0.3):
        b.cylinder(x, y, 0.08, 0.0, lobby_top, "Concrete", segs=10, top=False)
    for x, y in ((0.0, -(S / 2 - 0.15)), (0.0, S / 2 - 0.15), (-(S / 2 - 0.15), 0.0), (S / 2 - 0.15, 0.0)):
        b.cylinder(x, y, 0.08, 0.0, lobby_top, "Concrete", segs=10, top=False)
    b.prism(offset_outline(plate, 0.07), lobby_top - 0.05, lobby_top, "Concrete", top=False, bottom=True)
    # stacked floor plates, each rotated a little more (counter-clockwise going up).
    # Window seeds are shared over short runs of floors per column, so lit
    # windows form streaks that follow the twist.
    runs = {}
    for fl in range(2, top_floor + 1):
        t = (fl - 2) / (top_floor - 2)
        ol = rotate_outline(plate, twist * t)
        z0, z1 = F.z0(fl), F.z1(fl)
        b.prism(offset_outline(ol, 0.07), z0, z0 + slab_t, "Concrete", top=True, bottom=True)
        b.prism(ol, z0 + slab_t, z1, "Glass", top=False)
        for i, fac in enumerate(outline_facades(ol)):
            L = fac.length
            if i % 2 == 1:
                # chamfered corners carry a light line; stacked, they trace four helices
                m.accent.quad(*fac.rect(L / 2 - 0.06, L / 2 + 0.06, z0 + slab_t, z1, 0.012), "Accent")
                continue
            n = max(1, int(round(L / 0.55)))
            for k in range(n):
                key = (i, k)
                left, seed = runs.get(key, (0, 0.0))
                if left == 0:
                    left, seed = rng.randint(2, 5), rng.random()
                runs[key] = (left - 1, seed)
                s0, s1 = L * k / n, L * (k + 1) / n
                m.windows.add(fac.rect(s0 + 0.035, s1 - 0.035, z0 + slab_t + 0.03, z1 - 0.045, WIN_PROUD), fl, seed)
    # roof slab
    top_ol = rotate_outline(plate, twist)
    zr = roof
    b.prism(offset_outline(top_ol, 0.07), zr, zr + slab_t, "Concrete", top=False, bottom=True)
    ring_flat(b, offset_outline(top_ol, 0.07), top_ol, zr + slab_t, "Concrete")
    # angular crown: the glass skin rises to a plane sloping up toward the back
    ymin = min(p[1] for p in top_ol)
    ymax = max(p[1] for p in top_ol)

    def hz(p):
        return zr + 0.7 + 2.9 * (p[1] - ymin) / (ymax - ymin)

    n = len(top_ol)
    for i in range(n):
        a, c = top_ol[i], top_ol[(i + 1) % n]
        b.quad(V(a[0], a[1], zr + slab_t), V(c[0], c[1], zr + slab_t), V(c[0], c[1], hz(c)), V(a[0], a[1], hz(a)),
               "Glass")
        # lit crown edge running along the sloped top
        fa = Facade(a, c)
        L = fa.length
        m.crown.quad(fa.p(0, hz(a) - 0.12, 0.012), fa.p(L, hz(c) - 0.12, 0.012), fa.p(L, hz(c) - 0.03, 0.012),
                     fa.p(0, hz(a) - 0.03, 0.012), "CrownLight")
        # vertical glazing fins on the crown
        nf = max(1, int(round(L / 0.55)))
        for k in range(1, nf):
            s = L * k / nf
            zt = hz(a) + (hz(c) - hz(a)) * k / nf
            fa.slab(b, s - 0.02, s + 0.02, zr + slab_t, zt - 0.13, 0.0, 0.05, "Concrete", skip="kb")
    b.poly([V(p[0], p[1], hz(p)) for p in top_ol], "Glass")
    # beacon on the high back corner of the crown
    hi = max(top_ol, key=lambda p: hz(p))
    m.empty("Beacon", hi[0], hi[1], hz(hi))
    m.empty("Label", 0.0, 0.0, hz(hi) + 2.0)
    m.meta.update(roofHeight=round(zr + slab_t, 3), floors=top_floor + 1)
    return m


# ---------------------------------------------------------------------------
# 7. bank-dome (Finances)
# ---------------------------------------------------------------------------

def build_bank_dome():
    F = Floors()
    m = Model("bank-dome", F)
    b = m.body
    W, D = 9.0, 4.5
    base_top = F.z1(2)
    main_top = F.z1(9)
    ent_top = main_top + 0.5
    attic_top = ent_top + 0.42
    pav = (3.0, 0.15)                      # central pavilion width, projection
    outline = rect_outline(W, D)
    # walls (the entablature bands and the attic close the top)
    b.prism(outline, 0.0, main_top + 0.01, "Limestone", top=False)
    for k, fac in enumerate(rect_facades(W, D)):
        L = fac.length
        # rusticated granite base
        fac.slab(b, 0.0, L, 0.0, base_top, 0.0, 0.015, "Stone", skip="kblr")
        for j in range(7):
            z0 = 0.05 + j * 0.18
            fac.slab(b, -0.03, L + 0.03, z0, z0 + 0.14, 0.0, 0.045, "Stone", skip="k")
        fac.slab(b, -0.06, L + 0.06, base_top - 0.1, base_top, 0.0, 0.09, "Stone", skip="k")
        # pilasters and tall windows on the piano nobile
        segs = [(0.0, L)]
        if k == 0:
            segs = [(0.0, L / 2 - pav[0] / 2), (L / 2 + pav[0] / 2, L)]
        for a, c in segs:
            n = max(1, int(round((c - a) / 0.95)))
            pil = [a + (c - a) * i / n for i in range(n + 1)]
            for i, s in enumerate(pil):
                w = 0.34
                s0, s1 = max(a, s - w / 2), min(c, s + w / 2)
                if k == 0 and (abs(s - (L / 2 - pav[0] / 2)) < 1e-6 or abs(s - (L / 2 + pav[0] / 2)) < 1e-6):
                    continue
                fac.slab(b, s0, s1, base_top, main_top, 0.0, 0.1, "Limestone", skip="kbt")
                fac.slab(b, s0 - 0.04, s1 + 0.04, base_top, base_top + 0.16, 0.0, 0.13, "Limestone", skip="k")
                fac.slab(b, s0 - 0.05, s1 + 0.05, main_top - 0.2, main_top, 0.0, 0.14, "Limestone", skip="kb")
            for i in range(n):
                sc = (pil[i] + pil[i + 1]) / 2
                hw = 0.24
                fac.slab(b, sc - hw - 0.04, sc + hw + 0.04, base_top + 0.22, main_top - 0.32, 0.0, 0.014, "Trim", skip="kbt")
                tall_window(m, fac, sc - hw, sc + hw, base_top + 0.26, main_top - 0.36, 0.028, arch=True)
                fac.slab(b, sc - hw - 0.1, sc + hw + 0.1, main_top - 0.3, main_top - 0.22, 0.0, 0.08, "Limestone", skip="k")
                # small barred window in the base
                fac.slab(b, sc - 0.2, sc + 0.2, F.z0(1) + 0.02, base_top - 0.18, 0.0, 0.055, "Trim", skip="k")
                m.windows.add(fac.rect(sc - 0.16, sc + 0.16, F.z0(1) + 0.05, base_top - 0.21, 0.068), 1)
    # entablature, cornice and attic around the block
    band(b, outline, main_top, main_top + 0.2, 0.06, "Limestone", depth=0.3)
    band(b, outline, main_top + 0.2, ent_top - 0.12, 0.03, "Limestone", depth=0.3, top=False, bottom=False)
    band(b, outline, ent_top - 0.12, ent_top, 0.2, "Limestone", depth=0.5)
    att = offset_outline(outline, -0.05)
    b.prism(att, ent_top, attic_top, "Limestone", top=False)
    inner = offset_outline(outline, -0.25)
    ring_flat(b, att, inner, attic_top, "Limestone")
    b.prism(list(reversed(inner)), ent_top - 0.1, attic_top, "Limestone", top=False)
    b.poly([V(x, y, ent_top - 0.1) for x, y in inner], "Roof")
    # central pavilion: projecting bay, giant arched entrance between engaged columns
    pw, pp = pav
    y0 = -D / 2
    pz = attic_top + 0.32
    b.box(-pw / 2, y0 - pp, 0.0, pw / 2, y0 + 0.02, pz, "Limestone", skip="b")
    pf = Facade((-pw / 2, y0 - pp), (pw / 2, y0 - pp))
    pf.plate(b, arch_poly(0.85, pw - 0.85, 0.0, 2.55, segs=12), 0.0, 0.015, "Trim", back=False, skip_edges=(0,))
    pf.plate(b, arch_ring(pw / 2, 2.55, 0.65, 0.82, segs=12), 0.0, 0.07, "Limestone", back=False)
    pf.slab(b, pw / 2 - 0.1, pw / 2 + 0.1, 3.1, 3.42, 0.0, 0.1, "Limestone", skip="k")
    pf.slab(b, 0.9, pw - 0.9, 0.0, 1.35, 0.015, 0.04, "Trim", skip="kb")
    m.windows.add(pf.rect(0.95, pw / 2 - 0.02, 0.05, 1.3, 0.052), 0, seed=0.02)
    m.windows.add(pf.rect(pw / 2 + 0.02, pw - 0.95, 0.05, 1.3, 0.052), 0, seed=0.02)
    tall_window(m, pf, 0.9, pw - 0.9, 1.45, 3.15, 0.027, arch=True, seed=0.03)
    for s in (0.42, pw - 0.42):
        p = pf.p(s, 0.0, -0.03)
        column(b, p.x, p.y, 0.0, ent_top - 0.12, 0.19, "Limestone", flutes=14, order="doric")
    pf.slab(b, -0.02, pw + 0.02, ent_top - 0.12, ent_top + 0.02, 0.0, 0.3, "Limestone", skip="k")
    pf.slab(b, 0.2, pw - 0.2, ent_top + 0.02, pz - 0.05, 0.0, 0.05, "Limestone", skip="kb")
    b.box(-pw / 2 - 0.05, y0 - pp - 0.06, pz, pw / 2 + 0.05, y0 + 0.05, pz + 0.08, "Limestone", skip="")
    # drum with pilasters and arched windows, glowing ring at the cornice
    cx, cy = 0.0, 0.3
    Rd = 1.62
    zd0, zd1 = ent_top - 0.1, 6.45
    drum = circle(Rd, 16, cx, cy, a0=math.pi / 16)
    b.grid([[V(x, y, z) for x, y in drum] for z in (zd0, zd1)], "Limestone", closed=True, smooth=False)
    for i, fac in enumerate(outline_facades(drum)):
        L = fac.length
        if i % 2 == 0:
            fac.plate(b, arch_poly(0.12, L - 0.12, attic_top + 0.05, zd1 - 0.5, segs=8), 0.0, 0.012, "Trim",
                      back=False, skip_edges=(0,))
            tall_window(m, fac, 0.16, L - 0.16, attic_top + 0.09, zd1 - 0.25, 0.024, arch=True)
    for i, (x, y) in enumerate(drum):
        rh = V(x - cx, y - cy, 0).normalized()
        th = V(-rh.y, rh.x, 0)
        c = V(cx, cy, 0) + rh * (Rd + 0.025) + V(0, 0, (zd0 + zd1) / 2)
        obox(b, c, rh, th, V(0, 0, 1), 0.07, 0.06, (zd1 - zd0) / 2, "Limestone", skip="wb")
    dc = circle(Rd, 32, cx, cy)
    band(b, dc, zd1, zd1 + 0.1, 0.06, "Limestone", depth=0.3)
    band(b, dc, zd1 + 0.1, zd1 + 0.2, 0.15, "Limestone", depth=0.4)
    outline_strip(m.crown, dc, zd1 + 0.12, zd1 + 0.18, 0.155, "CrownLight")
    # dome (raised hemisphere) with ribs, lantern, finial
    zb = zd1 + 0.2
    Rb, Hd = 1.6, 1.9
    prof = []
    for k in range(13):
        t = math.radians(78 * k / 12)
        prof.append((Rb * math.cos(t), zb + Hd * math.sin(t)))
    z_l = prof[-1][1]
    b.revolve(prof + [(0.0, z_l)], "Copper", segs=32, cx=cx, cy=cy)
    for j in range(12):
        a = 2 * math.pi * j / 12
        rh = V(math.cos(a), math.sin(a), 0)
        th = V(-math.sin(a), math.cos(a), 0)
        for k in range(len(prof) - 1):
            p0 = V(cx, cy, 0) + rh * (prof[k][0]) + V(0, 0, prof[k][1])
            p1 = V(cx, cy, 0) + rh * (prof[k + 1][0]) + V(0, 0, prof[k + 1][1])
            d = p1 - p0
            ax = d.normalized()
            ay = th
            az = ax.cross(ay).normalized()
            if az.dot(rh) < 0:
                ay = -ay
                az = -az
            obox(b, (p0 + p1) / 2 + az * 0.03, ax, ay, az, d.length / 2 + 0.01, 0.035, 0.03, "Copper", skip="bew")
    for j in range(8):
        a = 2 * math.pi * j / 8 + math.pi / 8
        b.cylinder(cx + 0.27 * math.cos(a), cy + 0.27 * math.sin(a), 0.04, z_l, z_l + 0.55, "Limestone", segs=6)
    m.crown.cylinder(cx, cy, 0.22, z_l, z_l + 0.55, "CrownLight", segs=12, top=False)
    b.cylinder(cx, cy, 0.4, z_l + 0.55, z_l + 0.62, "Limestone", segs=16, bottom=True)
    b.revolve([(0.36, z_l + 0.62), (0.3, z_l + 0.78), (0.17, z_l + 0.9), (0.0, z_l + 0.95)], "Copper", segs=16,
              cx=cx, cy=cy)
    b.revolve([(0.0, z_l + 0.93), (0.07, z_l + 1.0), (0.07, z_l + 1.04), (0.0, z_l + 1.11)], "Metal", segs=8,
              cx=cx, cy=cy)
    tip = z_l + 1.45
    b.cylinder(cx, cy, 0.018, z_l + 1.1, tip, "Metal", segs=6, r1=0.004, top=False)
    m.empty("Beacon", cx, cy, tip)
    m.empty("Label", cx, cy, tip + 2.0)
    m.meta.update(roofHeight=round(attic_top, 3), floors=F.at(zd1) + 1)
    return m


# ---------------------------------------------------------------------------
# 8. glass-pavilion (Health)
# ---------------------------------------------------------------------------

def build_glass_pavilion():
    F = Floors(ground=1.32, fh=1.0)      # two tall levels
    m = Model("glass-pavilion", F)
    b = m.body
    rng = m.rng
    zt = 0.12                             # terrace top
    z1 = 1.32                             # mezzanine slab
    z2 = 2.3                              # roof slab underside
    # terrace plinth with a step
    b.prism(superellipse(4.95, 3.45, 4.0, 64), 0.0, 0.06, "Concrete", top=True)
    b.prism(superellipse(4.75, 3.25, 4.0, 64), 0.06, zt, "Concrete", top=True)
    # lower glass hall (floor 0): full-height panels between slim mullions
    low = superellipse(3.9, 2.35, 4.0, 48)
    up = superellipse(3.1, 1.85, 4.0, 40, cx=-0.45, cy=0.25)
    for ol, za, zb, fl in ((low, zt, z1, 0), (up, z1 + 0.08, z2, 1)):
        b.prism(offset_outline(ol, -0.02), za, zb, "Glass", top=False)
        for fac in outline_facades(ol):
            L = fac.length
            m.windows.add(fac.rect(0.025, L - 0.025, za + 0.03, zb - 0.03, 0.0), fl,
                          seed=rng.uniform(0.0, 0.5) if fl == 0 else None)
            fac.slab(b, -0.015, 0.015, za, zb, -0.01, 0.035, "Metal", skip="kbt")
    # thin white mezzanine slab and its edge
    b.prism(superellipse(4.0, 2.45, 4.0, 48), z1, z1 + 0.08, "Concrete", top=True, bottom=True)
    # floating roof: thin white slab with a big overhang, glowing fascia line
    roof_ol = superellipse(4.85, 3.35, 4.0, 64)
    b.prism(roof_ol, z2, z2 + 0.12, "Concrete", top=False, bottom=True)
    inner = offset_outline(roof_ol, -0.18)
    ring_flat(b, roof_ol, inner, z2 + 0.12, "Concrete")
    b.prism(list(reversed(inner)), z2 + 0.08, z2 + 0.12, "Concrete", top=False)
    b.poly([V(x, y, z2 + 0.08) for x, y in inner], "Concrete")
    outline_strip(m.accent, roof_ol, z2 + 0.03, z2 + 0.06, 0.006, "Accent")
    # oval skylight over the upper hall: its panes belong to the window mesh
    # (upper level) so it glows when the pavilion is busy
    sky = superellipse(1.7, 0.85, 2.6, 24, cx=-0.45, cy=0.25)
    b.prism(sky, z2 + 0.08, z2 + 0.2, "Metal", top=False)
    skyi = offset_outline(sky, -0.06)
    ring_flat(b, sky, skyi, z2 + 0.2, "Metal")
    m.windows.add([V(x, y, z2 + 0.17) for x, y in skyi], 1, seed=0.1)

    # slender columns along the roof edge
    for x, y in superellipse(4.55, 3.05, 4.0, 22):
        b.cylinder(x, y, 0.04, zt, z2, "Metal", segs=8, top=False)
    m.empty("Beacon", 0.0, 0.0, z2 + 0.2)
    m.empty("Label", 0.0, 0.0, z2 + 0.2 + 2.0)
    m.meta.update(roofHeight=round(z2 + 0.12, 3), floors=2)
    return m


# ---------------------------------------------------------------------------
# 9. billboard-block (CreatorOS)
# ---------------------------------------------------------------------------

def build_billboard_block():
    F = Floors()
    m = Model("billboard-block", F)
    b = m.body
    W, D = 5.4, 4.4
    top_floor = 63
    roof = F.z1(top_floor)
    outline = rect_outline(W, D)
    facs = rect_facades(W, D)            # south (front), east, north, west
    b.prism(outline, 0.0, roof + 0.35, "Concrete", top=False)
    inner = offset_outline(outline, -0.12)
    ring_flat(b, outline, inner, roof + 0.35, "Concrete")
    b.prism(list(reversed(inner)), roof, roof + 0.35, "Concrete", top=False)
    b.poly([V(x, y, roof) for x, y in inner], "Roof")
    # billboards: (facade index, s0, s1, z0, z1); facade s runs left->right seen from outside
    screens = [
        (0, 0.15, W - 0.15, 1.8, 4.65),         # wide base board
        (0, 0.4, W - 0.4, 5.0, 11.65),          # tall portrait
        (0, 0.15, W - 0.15, 12.0, 15.2),        # landscape
        (0, 0.75, W - 0.75, 15.55, 19.65),      # square
        (1, 0.12, 3.5, 2.0, 10.2),              # east, tall vertical near the front corner
        (1, 0.25, 4.15, 10.6, 14.0),            # east, landscape
        (3, 0.55, 4.25, 2.6, 8.4),              # west
        (3, 0.25, 4.15, 8.8, 12.2),             # west, landscape
    ]
    excl = {0: [], 1: [], 2: [], 3: []}
    meta = []
    out_s = 0.16
    for i, (fi, s0, s1, z0, z1) in enumerate(screens):
        fac = facs[fi]
        sb = m.add_extra(MeshBuilder("Screen_%d" % i))
        sb.quad(*fac.rect(s0, s1, z0, z1, out_s), "Screen", uvs=[(0, 0), (1, 0), (1, 1), (0, 1)])
        f = 0.07
        # frame around the panel
        fac.slab(b, s0 - f, s1 + f, z0 - f, z0, 0.0, out_s + 0.02, "Metal", skip="k")
        fac.slab(b, s0 - f, s1 + f, z1, z1 + f, 0.0, out_s + 0.02, "Metal", skip="k")
        fac.slab(b, s0 - f, s0, z0, z1, 0.0, out_s + 0.02, "Metal", skip="ktb")
        fac.slab(b, s1, s1 + f, z0, z1, 0.0, out_s + 0.02, "Metal", skip="ktb")
        excl[fi].append((s0 - f, s1 + f, z0 - f, z1 + f))
        meta.append({"name": "Screen_%d" % i, "width": round(s1 - s0, 3), "height": round(z1 - z0, 3)})
    # LED news ticker wrapping the building above the storefronts
    led = m.add_extra(MeshBuilder("LED"))
    t0, t1 = 1.08, 1.52
    lo = offset_outline(outline, 0.14)
    pts = [(0.0, D / 2 + 0.14)] + [lo[i] for i in (3, 0, 1, 2)] + [(0.0, D / 2 + 0.14)]
    total = sum(math.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1))
    acc = 0.0
    for i in range(len(pts) - 1):
        a, c = pts[i], pts[i + 1]
        ln = math.dist(a, c)
        u0, u1 = acc / total, (acc + ln) / total
        acc += ln
        led.quad(V(a[0], a[1], t0), V(c[0], c[1], t0), V(c[0], c[1], t1), V(a[0], a[1], t1), "LED",
                 uvs=[(u0, 0), (u1, 0), (u1, 1), (u0, 1)])
    band(b, outline, t0 - 0.06, t0, 0.17, "Metal", depth=0.2)
    band(b, outline, t1, t1 + 0.06, 0.17, "Metal", depth=0.2)
    for k in excl:
        excl[k].append((-1, 99, t0 - 0.1, t1 + 0.1))
    # office windows wherever the boards leave the facade free
    for k, fac in enumerate(facs):
        L = fac.length
        n = best_bay_count(L, 0.45, 0.0, 0.2)
        bays, _ = even_bays(L, n, 0.0, 0.2)
        window_rows(m, fac, bays, F.between(F.z1(1), roof), sill=0.075, head=0.065, inset=0.06,
                    exclude=excl[k])
        # bright storefronts and a lit marquee canopy at the base
        sb_n = max(1, int(round(L / 0.9)))
        for j in range(sb_n):
            s0, s1 = 0.15 + (L - 0.3) * j / sb_n, 0.15 + (L - 0.3) * (j + 1) / sb_n
            m.windows.add(fac.rect(s0 + 0.04, s1 - 0.04, 0.05, F.z1(0) + 0.3, WIN_PROUD), 0,
                          seed=m.rng.uniform(0.0, 0.25))
    front = facs[0]
    front.slab(b, 1.3, W - 1.3, 0.93, 0.99, 0.17, 0.33, "Metal", skip="k")
    m.accent.quad(*front.rect(1.3, W - 1.3, 0.93, 0.99, 0.335), "Accent")
    # lit top: stepped crown with a glowing frame and a mast
    zc = roof + 0.35
    outline_strip(m.crown, outline, zc - 0.1, zc - 0.03, 0.012, "CrownLight")
    cw, cd, ch = W - 1.0, D - 1.0, 1.25
    for sx in (-1, 1):
        for sy in (-1, 1):
            b.cbox(sx * cw / 2, sy * cd / 2, 0.14, 0.14, roof, zc + ch, "Metal", skip="b")
    fo = rect_outline(cw, cd)
    for i in range(4):
        a, c = fo[i], fo[(i + 1) % 4]
        fa = Facade(a, c)
        L = fa.length
        fa.slab(b, 0.0, L, zc + ch - 0.12, zc + ch, -0.07, 0.07, "Metal", skip="")
        m.crown.quad(*fa.rect(0.07, L - 0.07, zc + ch - 0.1, zc + ch - 0.02, 0.072), "CrownLight")
        m.crown.quad(*fa.rect(0.07, L - 0.07, zc + 0.3, zc + 0.36, 0.052), "CrownLight")
        fa.slab(b, 0.0, L, zc + 0.28, zc + 0.38, -0.05, 0.05, "Metal", skip="")
    b.cbox(0.0, 0.0, 1.4, 1.2, roof, zc + 0.5, "Roof", skip="b")
    b.cylinder(0.0, 0.0, 0.06, zc + 0.5, zc + 2.3, "Metal", segs=6, r1=0.03)
    m.empty("Beacon", 0.0, 0.0, zc + 2.35)
    m.empty("Label", 0.0, 0.0, zc + 2.35 + 2.0)
    m.meta.update(roofHeight=round(zc, 3), floors=top_floor + 1, screens=meta,
                  led={"name": "LED", "circumference": round(total, 3), "height": round(t1 - t0, 3),
                       "y": round(t0, 3)})
    return m


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

BUILDERS = {
    "deco-spire": build_deco_spire,
    "glass-led": build_glass_led,
    "ring-cylinder": build_ring_cylinder,
    "neoclassical": build_neoclassical,
    "warehouse-loft": build_warehouse_loft,
    "twist-tower": build_twist_tower,
    "bank-dome": build_bank_dome,
    "glass-pavilion": build_glass_pavilion,
    "billboard-block": build_billboard_block,
}


# ---------------------------------------------------------------------------
# Scene creation, export, manifest
# ---------------------------------------------------------------------------

def realize(m):
    """Turn a Model into a Blender scene named after the model key."""
    old = bpy.data.scenes.get(m.key)
    if old is not None:
        for ob in list(old.objects):
            data = ob.data
            bpy.data.objects.remove(ob, do_unlink=True)
            if data is not None and data.users == 0:
                bpy.data.meshes.remove(data)
        bpy.data.scenes.remove(old)
    old_col = bpy.data.collections.get(m.key)
    if old_col is not None:
        bpy.data.collections.remove(old_col)
    scene = bpy.data.scenes.new(m.key)
    scene.unit_settings.system = "NONE"
    col = bpy.data.collections.new(m.key)
    scene.collection.children.link(col)
    m.body.to_objects(m.key, col, split=True)
    m.windows.to_objects(m.key, col, split=False)
    m.crown.to_objects(m.key, col, split=False)
    m.accent.to_objects(m.key, col, split=False)
    for mb in m.extra:
        mb.to_objects(m.key, col, split=False)
    for name, loc in m.empties.items():
        e = bpy.data.objects.new(m.key + PREFIX_SEP + name, None)
        e.empty_display_type = "SPHERE" if name != "Label" else "PLAIN_AXES"
        e.empty_display_size = 0.4
        e.location = loc
        col.objects.link(e)
    meta = dict(m.meta)
    meta.setdefault("floors", 0)
    meta["floorHeight"] = m.floors.fh
    meta["baseHeight"] = m.floors.ground
    scene["hero_meta"] = json.dumps(meta)
    return scene


def node_name(blender_name):
    name = blender_name.split(PREFIX_SEP, 1)[-1]
    # strip Blender duplicate suffixes like ".001"
    if len(name) > 4 and name[-4] == "." and name[-3:].isdigit():
        name = name[:-4]
    return name


def postprocess_glb(path):
    """Strip '<model>/' prefixes from node/mesh names and lowercase the custom
    attribute semantics (_FLOOR -> _floor)."""
    with open(path, "rb") as f:
        data = f.read()
    magic, version, _ = struct.unpack_from("<4sII", data, 0)
    off = 12
    chunks = []
    while off < len(data):
        clen, ctype = struct.unpack_from("<II", data, off)
        chunks.append([ctype, data[off + 8: off + 8 + clen]])
        off += 8 + clen
    js = json.loads(chunks[0][1].decode("utf-8"))
    for n in js.get("nodes", []):
        if "name" in n:
            n["name"] = node_name(n["name"])
    for me in js.get("meshes", []):
        if "name" in me:
            me["name"] = node_name(me["name"])
        for prim in me.get("primitives", []):
            attrs = prim.get("attributes", {})
            for k in list(attrs):
                if k.startswith("_"):
                    attrs[k.lower()] = attrs.pop(k)
    for mat in js.get("materials", []):
        mat["name"] = node_name(mat.get("name", ""))
    js.setdefault("asset", {})["extras"] = {"source": "assets/blender/build_hero_towers.py"}
    jb = json.dumps(js, separators=(",", ":")).encode("utf-8")
    jb += b" " * ((4 - len(jb) % 4) % 4)
    chunks[0][1] = jb
    body = b"".join(struct.pack("<II", len(c[1]), c[0]) + c[1] for c in chunks)
    with open(path, "wb") as f:
        f.write(struct.pack("<4sII", magic, version, 12 + len(body)))
        f.write(body)
    return js


def export_scene(scene, path):
    with bpy.context.temp_override(scene=scene, view_layer=scene.view_layers[0]):
        bpy.ops.export_scene.gltf(
            filepath=path, export_format="GLB", use_active_scene=True, export_apply=True,
            export_yup=True, export_attributes=True, export_texcoords=True, export_normals=True,
            export_vertex_color="NONE", export_all_vertex_colors=False,
            export_active_vertex_color_when_no_material=False,
            export_materials="EXPORT", export_cameras=False, export_lights=False,
            export_extras=False, export_animations=False, export_draco_mesh_compression_enable=False,
        )
    return postprocess_glb(path)


def read_glb_json(path):
    with open(path, "rb") as f:
        data = f.read()
    clen, _ = struct.unpack_from("<II", data, 12)
    return json.loads(data[20:20 + clen].decode("utf-8"))


def find_gltf_transform():
    names = ["gltf-transform.cmd", "gltf-transform"] if os.name == "nt" else ["gltf-transform"]
    for base in (os.path.join(REPO_ROOT, "apps", "city", "node_modules", ".bin"),
                 os.path.join(REPO_ROOT, "node_modules", ".bin")):
        for n in names:
            p = os.path.join(base, n)
            if os.path.exists(p):
                return p
    return shutil.which("gltf-transform")


def meshopt_compress(path):
    """Compress a GLB in place with `gltf-transform meshopt` (EXT_meshopt_compression
    + KHR_mesh_quantization). Keeps the uncompressed file if anything fails or
    the custom window attributes do not survive."""
    tool = find_gltf_transform()
    if not tool:
        print("[hero] gltf-transform not found; keeping uncompressed", path)
        return False
    raw = path[:-4] + ".raw.glb"
    os.replace(path, raw)
    res = subprocess.run([tool, "meshopt", raw, path], capture_output=True, text=True)
    ok = res.returncode == 0 and os.path.exists(path)
    if ok:
        js = read_glb_json(path)
        for me in js.get("meshes", []):
            if me.get("name") == "Windows":
                attrs = me["primitives"][0]["attributes"]
                ok = ok and "_floor" in attrs and "_seed" in attrs
    if not ok:
        print("[hero] meshopt failed for", path, res.stderr[-400:])
        if os.path.exists(path):
            os.remove(path)
        os.replace(raw, path)
        return False
    os.remove(raw)
    return True


def manifest_json(data):
    """Readable JSON: one key per line, short arrays and small objects inline."""
    def enc(v, ind):
        pad = "  " * ind
        if isinstance(v, dict):
            inline = json.dumps(v)
            if len(inline) <= 72 and not any(isinstance(x, (dict, list)) and len(json.dumps(x)) > 40
                                             for x in v.values()):
                return inline
            items = ['%s  "%s": %s' % (pad, k, enc(x, ind + 1)) for k, x in v.items()]
            return "{\n" + ",\n".join(items) + "\n" + pad + "}"
        if isinstance(v, list):
            inline = json.dumps(v)
            if len(inline) <= 100 and not any(isinstance(x, dict) for x in v):
                return inline
            items = ["%s  %s" % (pad, enc(x, ind + 1)) for x in v]
            return "[\n" + ",\n".join(items) + "\n" + pad + "]"
        return json.dumps(v)
    return enc(data, 0) + "\n"


def to_gltf(p):
    """Blender (x, y, z) -> glTF/three.js (x, z, -y)."""
    return [round(p[0], 3), round(p[2], 3), round(-p[1] + 0.0, 3)]


def scene_manifest(scene, js):
    meta = json.loads(scene.get("hero_meta", "{}"))
    xs, ys, zs = [], [], []
    tris = 0
    for ob in scene.objects:
        if ob.type != "MESH":
            continue
        me = ob.data
        for v in me.vertices:
            co = ob.matrix_world @ v.co
            xs.append(co.x)
            ys.append(co.y)
            zs.append(co.z)
        me.calc_loop_triangles()
        tris += len(me.loop_triangles)
    emp = {node_name(ob.name): ob.matrix_world.translation for ob in scene.objects if ob.type == "EMPTY"}
    floors = meta.get("floors")
    for ob in scene.objects:
        if ob.type == "MESH" and node_name(ob.name) == "Windows" and "_floor" in ob.data.attributes:
            vals = [0.0] * len(ob.data.vertices)
            ob.data.attributes["_floor"].data.foreach_get("value", vals)
            floors = int(round(max(vals))) + 1
    out = {
        "height": round(max(zs), 3),
        "roofHeight": meta.get("roofHeight"),
        "floors": floors,
        "floorHeight": meta.get("floorHeight"),
        "baseHeight": meta.get("baseHeight"),
        "footprint": {"w": round(max(xs) - min(xs), 3), "d": round(max(ys) - min(ys), 3)},
    }
    for key in ("Beacon", "Label", "Searchlight"):
        if key in emp:
            out[key.lower()] = to_gltf(emp[key])
    if meta.get("screens"):
        out["screens"] = meta["screens"]
    if meta.get("led"):
        out["led"] = meta["led"]
    out["nodes"] = [n["name"] for n in js.get("nodes", [])]
    return out, tris


# ---------------------------------------------------------------------------
# Preview renders (Cycles, dusk) and contact sheet
# ---------------------------------------------------------------------------

PREVIEW_EMIT = {
    "CrownLight": ((1.0, 0.8, 0.52), 9.0),
    "Accent": ((1.0, 0.88, 0.7), 5.0),
    "Ring": ((0.55, 0.88, 1.0), 14.0),
}


def _node(nt, kind, loc=(0, 0), **inputs):
    n = nt.nodes.new(kind)
    n.location = loc
    for k, v in inputs.items():
        n.inputs[k].default_value = v
    return n


def setup_preview_materials(mode="dusk"):
    """Rewire the shared materials for a night-read preview: windows lit from
    their `_seed`, light materials emissive, LED/Screen showing a UV test
    pattern. mode 'floors' colours windows by floor parity; 'normals' paints
    back faces magenta on every material."""
    for mat in bpy.data.materials:
        name = mat.name
        if name not in BODY_MATERIALS and name not in LIGHT_MATERIALS:
            continue
        get_material(name)          # reset to the export setup
        nt = mat.node_tree
        bsdf = nt.nodes["Principled BSDF"]
        out = nt.nodes["Material Output"]
        if name == "Window":
            seed = _node(nt, "ShaderNodeAttribute", (-900, 0))
            seed.attribute_name = "_seed"
            floor = _node(nt, "ShaderNodeAttribute", (-900, -200))
            floor.attribute_name = "_floor"
            lit = _node(nt, "ShaderNodeMath", (-700, 0))
            lit.operation = "LESS_THAN"
            nt.links.new(seed.outputs["Fac"], lit.inputs[0])
            lit.inputs[1].default_value = 0.45
            strength = _node(nt, "ShaderNodeMath", (-500, 0))
            strength.operation = "MULTIPLY"
            nt.links.new(lit.outputs[0], strength.inputs[0])
            strength.inputs[1].default_value = 4.0
            nt.links.new(strength.outputs[0], bsdf.inputs["Emission Strength"])
            mix = _node(nt, "ShaderNodeMix", (-500, 200))
            mix.data_type = "RGBA"
            if mode == "floors":
                par = _node(nt, "ShaderNodeMath", (-700, -200))
                par.operation = "MODULO"
                nt.links.new(floor.outputs["Fac"], par.inputs[0])
                par.inputs[1].default_value = 2.0
                nt.links.new(par.outputs[0], mix.inputs["Factor"])
                mix.inputs["A"].default_value = (1.0, 0.45, 0.1, 1)
                mix.inputs["B"].default_value = (0.1, 0.8, 1.0, 1)
                lit.inputs[1].default_value = 1.1
            else:
                cool = _node(nt, "ShaderNodeMath", (-700, 200))
                cool.operation = "GREATER_THAN"
                nt.links.new(seed.outputs["Fac"], cool.inputs[0])
                cool.inputs[1].default_value = 0.47
                nt.links.new(cool.outputs[0], mix.inputs["Factor"])
                mix.inputs["A"].default_value = (1.0, 0.68, 0.36, 1)
                mix.inputs["B"].default_value = (0.75, 0.88, 1.0, 1)
            nt.links.new(mix.outputs["Result"], bsdf.inputs["Emission Color"])
        elif name in ("LED", "Screen", "Flag"):
            uv = _node(nt, "ShaderNodeTexCoord", (-900, 0))
            sep = _node(nt, "ShaderNodeSeparateXYZ", (-700, 0))
            nt.links.new(uv.outputs["UV"], sep.inputs[0])
            comb = _node(nt, "ShaderNodeCombineXYZ", (-500, 0))
            if name == "Flag":
                # red/white stripes along v, blue canton at top-left (u small, v big)
                stripes = _node(nt, "ShaderNodeMath", (-500, 200))
                stripes.operation = "MULTIPLY"
                nt.links.new(sep.outputs["Y"], stripes.inputs[0])
                stripes.inputs[1].default_value = 6.5
                fr = _node(nt, "ShaderNodeMath", (-350, 200))
                fr.operation = "FRACT"
                nt.links.new(stripes.outputs[0], fr.inputs[0])
                gt = _node(nt, "ShaderNodeMath", (-200, 200))
                gt.operation = "GREATER_THAN"
                nt.links.new(fr.outputs[0], gt.inputs[0])
                gt.inputs[1].default_value = 0.5
                mix = _node(nt, "ShaderNodeMix", (-100, 200))
                mix.data_type = "RGBA"
                nt.links.new(gt.outputs[0], mix.inputs["Factor"])
                mix.inputs["A"].default_value = (0.5, 0.03, 0.04, 1)
                mix.inputs["B"].default_value = (0.8, 0.8, 0.78, 1)
                nt.links.new(mix.outputs["Result"], bsdf.inputs["Base Color"])
                continue
            # UV test pattern: red = u (left->right), green = v (bottom->top), plus a grid
            nt.links.new(sep.outputs["X"], comb.inputs["X"])
            nt.links.new(sep.outputs["Y"], comb.inputs["Y"])
            comb.inputs["Z"].default_value = 0.35
            chk = _node(nt, "ShaderNodeTexChecker", (-500, -250))
            chk.inputs["Scale"].default_value = 8.0
            nt.links.new(uv.outputs["UV"], chk.inputs["Vector"])
            mul = _node(nt, "ShaderNodeMix", (-300, 0))
            mul.data_type = "RGBA"
            mul.blend_type = "MULTIPLY"
            mul.inputs["Factor"].default_value = 0.35
            nt.links.new(comb.outputs[0], mul.inputs["A"])
            nt.links.new(chk.outputs["Color"], mul.inputs["B"])
            nt.links.new(mul.outputs["Result"], bsdf.inputs["Emission Color"])
            bsdf.inputs["Emission Strength"].default_value = 4.0
        elif name in PREVIEW_EMIT:
            col, s = PREVIEW_EMIT[name]
            bsdf.inputs["Emission Color"].default_value = (col[0], col[1], col[2], 1)
            bsdf.inputs["Emission Strength"].default_value = s
        if mode in ("normals", "normals-mat"):
            geo = _node(nt, "ShaderNodeNewGeometry", (-300, 400))
            red = _node(nt, "ShaderNodeEmission", (-100, 400))
            hue = (sum(map(ord, name)) * 0.618) % 1.0
            import colorsys
            rr, gg, bb = colorsys.hsv_to_rgb(hue, 1.0, 1.0)
            red.inputs["Color"].default_value = (rr, gg, bb, 1) if mode == "normals-mat" else (1, 0, 1, 1)
            red.inputs["Strength"].default_value = 4.0
            mixs = _node(nt, "ShaderNodeMixShader", (100, 200))
            lp = _node(nt, "ShaderNodeLightPath", (-300, 600))
            both = _node(nt, "ShaderNodeMath", (-100, 600))
            both.operation = "MULTIPLY"
            nt.links.new(geo.outputs["Backfacing"], both.inputs[0])
            nt.links.new(lp.outputs["Is Camera Ray"], both.inputs[1])
            nt.links.new(both.outputs[0], mixs.inputs[0])
            nt.links.new(bsdf.outputs["BSDF"], mixs.inputs[1])
            nt.links.new(red.outputs["Emission"], mixs.inputs[2])
            nt.links.new(mixs.outputs[0], out.inputs["Surface"])


def _dusk_world(scene):
    world = bpy.data.worlds.get("HeroDusk") or bpy.data.worlds.new("HeroDusk")
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    out = _node(nt, "ShaderNodeOutputWorld", (400, 0))
    bg = _node(nt, "ShaderNodeBackground", (200, 0))
    tc = _node(nt, "ShaderNodeTexCoord", (-600, 0))
    sep = _node(nt, "ShaderNodeSeparateXYZ", (-400, 0))
    ramp = _node(nt, "ShaderNodeValToRGB", (-200, 0))
    nt.links.new(tc.outputs["Generated"], sep.inputs[0])
    nt.links.new(sep.outputs["Z"], ramp.inputs["Fac"])
    cr = ramp.color_ramp
    cr.elements[0].position = 0.0
    cr.elements[0].color = (0.42, 0.24, 0.2, 1)
    cr.elements[1].position = 0.45
    cr.elements[1].color = (0.03, 0.055, 0.14, 1)
    e = cr.elements.new(0.12)
    e.color = (0.16, 0.13, 0.22, 1)
    nt.links.new(ramp.outputs["Color"], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = 1.0
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])
    scene.world = world


def _frame(scene, cam, pts, direction, margin=0.04):
    from bpy_extras.object_utils import world_to_camera_view
    from mathutils import Matrix
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    center = (lo + hi) / 2
    d = direction.normalized()
    rot = (-d).to_track_quat("-Z", "Y").to_matrix().to_4x4()
    a, bnd = 1.0, 2000.0
    for _ in range(50):
        mid = (a + bnd) / 2
        cam.matrix_world = Matrix.Translation(center + d * mid) @ rot
        ok = True
        for p in pts:
            q = world_to_camera_view(scene, cam, p)
            if q.z <= 0 or not (margin <= q.x <= 1 - margin and margin <= q.y <= 1 - margin):
                ok = False
                break
        if ok:
            bnd = mid
        else:
            a = mid
    cam.matrix_world = Matrix.Translation(center + d * bnd) @ rot


def render_preview(key, path, samples=32, res=(480, 640), direction=(1.0, -1.0, 0.92), distance=None,
                   target=None, fov=35.0):
    """Render one model scene into `path` (PNG) under a dusk setup."""
    src = bpy.data.scenes[key]
    sc = bpy.data.scenes.new("preview")
    for ob in src.objects:
        if ob.type == "MESH":
            sc.collection.objects.link(ob)
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = samples
    sc.cycles.use_denoising = True
    sc.cycles.max_bounces = 4
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.resolution_percentage = 100
    sc.render.film_transparent = False
    sc.view_settings.view_transform = "AgX"
    sc.view_settings.look = "AgX - Medium High Contrast"
    sc.view_settings.exposure = 0.6
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_depth = "8"
    _dusk_world(sc)
    # ground
    gm = bpy.data.meshes.new("preview_ground")
    gm.from_pydata([(-400, -400, 0), (400, -400, 0), (400, 400, 0), (-400, 400, 0)], [], [(0, 1, 2, 3)])
    gmat = bpy.data.materials.get("preview_ground") or bpy.data.materials.new("preview_ground")
    gmat.use_nodes = True
    gmat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.03, 0.03, 0.035, 1)
    gmat.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.6
    gm.materials.append(gmat)
    g = bpy.data.objects.new("preview_ground", gm)
    sc.collection.objects.link(g)
    # warm low sun from the south-west + faint cool rim from the north-east
    sun = bpy.data.lights.new("preview_sun", "SUN")
    sun.energy = 3.2
    sun.color = (1.0, 0.6, 0.36)
    sun.angle = math.radians(2.0)
    so = bpy.data.objects.new("preview_sun", sun)
    so.rotation_euler = (math.radians(76), 0.0, math.radians(-40))
    sc.collection.objects.link(so)
    rim = bpy.data.lights.new("preview_rim", "SUN")
    rim.energy = 0.5
    rim.color = (0.5, 0.65, 1.0)
    ro = bpy.data.objects.new("preview_rim", rim)
    ro.rotation_euler = (math.radians(60), 0.0, math.radians(150))
    sc.collection.objects.link(ro)
    camd = bpy.data.cameras.new("preview_cam")
    camd.sensor_fit = "VERTICAL"
    camd.angle_y = math.radians(fov)
    camd.clip_end = 3000
    cam = bpy.data.objects.new("preview_cam", camd)
    sc.collection.objects.link(cam)
    sc.camera = cam
    dvec = Vector(direction)
    if distance is None:
        pts = [ob.matrix_world @ Vector(c) for ob in src.objects if ob.type == "MESH" for c in ob.bound_box]
        _frame(sc, cam, pts, dvec)
    else:
        from mathutils import Matrix
        tgt = Vector(target or (0, 0, 0))
        rot = (-dvec.normalized()).to_track_quat("-Z", "Y").to_matrix().to_4x4()
        cam.matrix_world = Matrix.Translation(tgt + dvec.normalized() * distance) @ rot
    sc.render.filepath = path
    with bpy.context.temp_override(scene=sc, view_layer=sc.view_layers[0]):
        bpy.ops.render.render(write_still=True, scene=sc.name)
    # clean up the preview scene (model objects stay in their own scene)
    for ob in (g, so, ro, cam):
        bpy.data.objects.remove(ob, do_unlink=True)
    bpy.data.meshes.remove(gm)
    bpy.data.lights.remove(sun)
    bpy.data.lights.remove(rim)
    bpy.data.cameras.remove(camd)
    bpy.data.scenes.remove(sc)


def contact_sheet(paths, out_path, cols=3, tile=(264, 352), levels=32):
    """Assemble PNG renders into one grid image with numpy. Colours are
    quantised to `levels` per channel to keep the PNG small."""
    import numpy as np
    tw, th = tile
    rows = (len(paths) + cols - 1) // cols
    sheet = np.zeros((rows * th, cols * tw, 4), dtype=np.float32)
    sheet[..., 3] = 1.0
    for i, p in enumerate(paths):
        img = bpy.data.images.load(p)
        w, h = img.size
        px = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)
        # box-filter resample to the tile size
        ys = (np.arange(th + 1) * h / th).astype(int)
        xs = (np.arange(tw + 1) * w / tw).astype(int)
        cs = px.cumsum(0).cumsum(1)
        cs = np.pad(cs, ((1, 0), (1, 0), (0, 0)))
        tilepx = (cs[ys[1:]][:, xs[1:]] - cs[ys[:-1]][:, xs[1:]] - cs[ys[1:]][:, xs[:-1]] + cs[ys[:-1]][:, xs[:-1]])
        area = ((ys[1:] - ys[:-1])[:, None] * (xs[1:] - xs[:-1])[None, :])[..., None]
        tilepx = tilepx / area
        r, c = divmod(i, cols)
        # images are stored bottom-up: row 0 of the sheet is the bottom
        rr = rows - 1 - r
        sheet[rr * th:(rr + 1) * th, c * tw:(c + 1) * tw] = tilepx
        bpy.data.images.remove(img)
    if levels:
        sheet[..., :3] = np.round(np.clip(sheet[..., :3], 0.0, 1.0) * (levels - 1)) / (levels - 1)
    out = bpy.data.images.new("contact_sheet", cols * tw, rows * th, alpha=False)
    out.pixels.foreach_set(sheet.ravel())
    out.filepath_raw = out_path
    out.file_format = "PNG"
    out.save()
    bpy.data.images.remove(out)


def render_previews(keys, outdir, samples=32, mode="dusk", sheet=None, res=(480, 640)):
    os.makedirs(outdir, exist_ok=True)
    setup_preview_materials(mode)
    paths = []
    for key in keys:
        p = os.path.join(outdir, "%s.png" % key)
        render_preview(key, p, samples=samples, res=res)
        paths.append(p)
        print("[hero] preview", p)
    if sheet:
        contact_sheet(paths, sheet)
        print("[hero] contact sheet", sheet)
    # restore export materials
    for name in list(BODY_MATERIALS) + list(LIGHT_MATERIALS):
        if bpy.data.materials.get(name):
            get_material(name)
    return paths


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def parse_args(argv=None):
    if argv is None:
        argv = list(sys.argv)
        if "--" in argv:
            argv = argv[argv.index("--") + 1:]
        elif argv and argv[0].endswith(".py"):
            argv = argv[1:]
        else:
            argv = []
    p = argparse.ArgumentParser(description="Build the Agent City hero towers.")
    p.add_argument("--out", default=DEFAULT_OUT, help="output directory for <model>.glb and manifest.json")
    p.add_argument("--blend", default=None, help="also save all models (one scene each) to this .blend")
    p.add_argument("--only", default=None, help="comma-separated model keys to build")
    p.add_argument("--export-only", action="store_true",
                   help="do not rebuild: export the model scenes of the currently open .blend (after hand edits)")
    p.add_argument("--no-meshopt", action="store_true",
                   help="skip `gltf-transform meshopt` compression (done by default when the repo's "
                        "node_modules provide gltf-transform)")
    p.add_argument("--preview", default=None, help="render Cycles preview PNGs of each model into this directory")
    p.add_argument("--sheet", default=None, help="assemble the previews into this contact-sheet PNG")
    p.add_argument("--samples", type=int, default=32, help="Cycles samples for previews")
    return p.parse_known_args(argv)[0]


def reset_file():
    if bpy.app.background:
        bpy.ops.wm.read_factory_settings(use_empty=True)


def build(keys):
    models = {}
    for key in keys:
        m = BUILDERS[key]()
        scene = realize(m)
        models[key] = (m, scene)
        print("[hero] built %-16s windows=%d" % (key, m.windows.count))
    return models


def overview_scene():
    """A browsing scene that instances every model collection side by side
    (not exported)."""
    sc = bpy.data.scenes.get("overview") or bpy.data.scenes.new("overview")
    for ob in list(sc.collection.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    x = 0.0
    for key in MODEL_KEYS:
        col = bpy.data.collections.get(key)
        if col is None:
            continue
        e = bpy.data.objects.new("overview/" + key, None)
        e.instance_type = "COLLECTION"
        e.instance_collection = col
        e.location = (x, 0.0, 0.0)
        e.empty_display_size = 0.5
        sc.collection.objects.link(e)
        x += 12.0
    return sc


def main():
    args = parse_args()
    keys = MODEL_KEYS if not args.only else [k.strip() for k in args.only.split(",") if k.strip()]
    keys = [k for k in keys if k in BUILDERS]
    if args.export_only:
        models = {k: (None, bpy.data.scenes[k]) for k in keys if k in bpy.data.scenes}
        keys = list(models)
    else:
        reset_file()
        models = build(keys)
    os.makedirs(args.out, exist_ok=True)
    manifest_path = os.path.join(args.out, "manifest.json")
    manifest = {}
    if os.path.exists(manifest_path):      # merge: models not rebuilt keep their entries
        with open(manifest_path) as f:
            manifest = json.load(f)
    for key in keys:
        scene = models[key][1]
        path = os.path.join(args.out, key + ".glb")
        js = export_scene(scene, path)
        raw_size = os.path.getsize(path)
        entry, tris = scene_manifest(scene, js)
        manifest[key] = entry
        packed = False if args.no_meshopt else meshopt_compress(path)
        print("[hero] exported %-16s %6d tris  %7d bytes raw  %7d bytes%s" % (
            key, tris, raw_size, os.path.getsize(path), " meshopt" if packed else ""))
    ordered = {k: manifest[k] for k in MODEL_KEYS if k in manifest}
    with open(manifest_path, "w") as f:
        f.write(manifest_json(ordered))
    if args.blend:
        overview_scene()
        empty = bpy.data.scenes.get("Scene")
        if empty is not None and len(bpy.data.scenes) > 1 and not empty.objects:
            bpy.data.scenes.remove(empty)
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(args.blend), compress=True)
    if args.preview:
        render_previews(keys, os.path.abspath(args.preview), samples=args.samples,
                        sheet=os.path.abspath(args.sheet) if args.sheet else None)
    print("[hero] done")


if __name__ == "__main__":
    main()
