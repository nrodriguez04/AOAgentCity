# Agent City hero towers

Nine landmark towers, one per division (spec §10.3), for the city in `apps/city`.
`build_hero_towers.py` builds every model from scratch in Blender with plain
Python geometry (no external assets, textures or add-ons) and exports one GLB
per model plus `manifest.json` to `apps/city/public/models/`. The build is
deterministic: a fixed seed per model, so rebuilding gives identical files.

The designs are original, inspired by New York styles, and carry no real brand
names or logos.

| Model | Division | Design |
|---|---|---|
| `deco-spire` | HQ | Limestone Art Deco wedding cake: podium, 3 setback tiers and a belvedere. Continuous piers run each tier and rise past every parapet into stepped caps. Recessed bays hold vertical window ribbons with thin bronze spandrels. A three-stage green copper crown has lit chevron gables and a lit sunburst, then a needle spire (the tallest point in the city). |
| `glass-led` | ParlayLab | Dark blue-green chamfered glass prism with a mullion grid and a double-height lobby on columns. Its dark corners carry vertical light seams. A continuous LED band sits near the top, and the top is flat with a lit edge. |
| `ring-cylinder` | Halo | Slender white drum with 32 radial fins (pilotis at the base) and horizontal window bands. A glowing halo ring floats above the fin crown. |
| `neoclassical` | FedOps | Marble temple front: stair between cheek plinths, six fluted Corinthian columns between antae, entablature, and a pediment with a relief and lit raking cornices. A window screen sits behind the colonnade, an office block behind, and there are three flags. |
| `warehouse-loft` | GalleySwap | Red-brick Romanesque warehouse by the river: cast-iron storefront, three-storey round-arched arcades, limestone belt courses, a sign band framed by bulb strings, a corbelled cornice, a fire escape and a rooftop water tank. |
| `twist-tower` | AverageOutput / OTHERLIFE | 115 square floor plates, each rotated a little more (90° in total), with white slab edges. Light lines on the chamfered corners trace four helices. The angular crown is a glass wedge sloping up to the back. |
| `bank-dome` | Finances | Rusticated granite base, limestone piano nobile with giant pilasters and arched windows, and a projecting arched entrance pavilion. A drum with arched windows carries a ribbed green copper dome and a lit lantern. |
| `glass-pavilion` | Health | Low squircle glass pavilion in the park: two glass levels (the upper one offset), slim columns, and a thin white floating roof with a glowing fascia and a glowing oval skylight. |
| `billboard-block` | CreatorOS | Narrow Times Square tower. Eight framed billboard screens of varied aspect cover the front and sides, an LED news ticker wraps the base, and the top is a lit frame with a beacon mast. |

## Rebuild

With the Blender binary (5.x; developed against 5.2):

```sh
blender -b -P assets/blender/build_hero_towers.py -- \
    --out apps/city/public/models --blend assets/blender/hero_towers.blend
```

With the `bpy` Python module (no Blender UI needed):

```sh
python assets/blender/build_hero_towers.py --out apps/city/public/models
```

The script parses arguments after `--` when present, otherwise `sys.argv`. When
it is `exec`'d inside an interactive Blender (for example through an MCP
bridge), it uses the defaults and does not wipe the open file. It replaces only
the scenes it builds. In that mode it finds the default `--out` by walking up
from the working directory to the folder that contains `apps/city`.

| Option | Effect |
|---|---|
| `--out DIR` | Where `<model>.glb` and `manifest.json` go (default `apps/city/public/models`). |
| `--only a,b` | Build only these models. `manifest.json` is merged, not replaced. |
| `--blend FILE` | Also save every model, one scene each, plus an `overview` scene, to a `.blend`. |
| `--export-only` | Do not rebuild: export the model scenes of the currently open `.blend` (see below). |
| `--no-meshopt` | Keep plain GLBs (see Compression). |
| `--preview DIR` | Render a Cycles dusk preview PNG per model into `DIR`. |
| `--sheet FILE` | Assemble those previews into a contact sheet. |
| `--samples N` | Cycles samples for previews (default 32). |

The preview contact sheet in `previews/hero_towers.png` (row by row:
deco-spire, glass-led, ring-cylinder / neoclassical, warehouse-loft,
twist-tower / bank-dome, glass-pavilion, billboard-block) was made with:

```sh
python assets/blender/build_hero_towers.py --out apps/city/public/models \
    --preview /tmp/hero_previews --sheet assets/blender/previews/hero_towers.png
```

### Compression

After export, each GLB is compressed in place with `gltf-transform meshopt`
(`EXT_meshopt_compression` + `KHR_mesh_quantization`). The script uses the
`@gltf-transform/cli` devDependency of `apps/city` (`node_modules/.bin`) or a
global `gltf-transform`. If neither is found, or compression would drop the
window attributes, the plain GLB is kept. The loader must register the meshopt
decoder: drei's `useGLTF(url)` does this by default, and with a bare
`GLTFLoader` call `loader.setMeshoptDecoder(MeshoptDecoder)`.

Quantization stores positions as normalized int16 and puts a dequantization
transform (scale and offset) on the mesh nodes. So read world matrices, not raw
positions, when you need world coordinates. `_floor` and `_seed` stay float32.

## Contract with the three.js loader

### Units, axes, origin

- 1 unit = 1 city unit (about 10 m). Floors are 0.38 units with a 0.6 ground
  floor; the loft uses 0.42 / 0.7 and the pavilion two 1.0-unit levels (see the
  manifest).
- Each model's origin is the ground centre of its lot. Ground is y = 0 in glTF
  (z = 0 in Blender). All transforms are applied: every mesh node has an
  identity transform before compression.
- glTF is Y-up. The front facade faces glTF **+Z** (city south, toward the
  default camera); in Blender it faces -Y.
- Footprints fit the lot: at most 9.5 x 5.2 (w along x, d along z), except
  `glass-pavilion` (10 x 7) and `billboard-block` (6 x 5). The twist tower stays
  inside 5.2 at every rotation.

### Nodes

Node names are exact. The loader finds parts by prefix.

| Node | Material | Notes |
|---|---|---|
| `Body_<Material>` | the material named in the suffix | Structure, split into one node per material (for example `Body_Limestone`, `Body_Copper`). |
| `Windows` | `Window` | Only window panes: quads, plus round-headed polygons on the loft and the bank and the pavilion's oval skylight. See below. |
| `Crown` | `CrownLight` | Crown and top-edge light geometry that pulses and turns red on errors. Every model except `glass-pavilion` has one. |
| `Accent` | `Accent` | Static light strips: parapet floodlights, light seams, the twist helices, the pavilion fascia, the canopy edge. |
| `LED` | `LED` | glass-led band near the top, and the billboard-block news ticker. UV u runs 0 to 1 once around the building, counter-clockwise seen from above (left to right seen from outside), starting and ending at the middle of the back face. v runs 0 to 1 from bottom to top. |
| `Screen_0` ... `Screen_7` | `Screen` | billboard-block only. One quad each, UV 0..1 with u left to right seen from outside and v bottom to top. |
| `Ring` | `Ring` | ring-cylinder halo (torus). |
| `Flag_0` ... `Flag_2` | `Flag` | neoclassical only. Double-sided, 8 x 3 segments so a vertex shader can wave them. u runs from the hoist (pole) to the fly end, v bottom to top. |
| `Beacon` | (empty) | Rooftop beacon position: spire tip, mast top or roof centre. |
| `Label` | (empty) | About 2 units above the top, for the HTML badge. |
| `Searchlight` | (empty) | deco-spire only: inside the copper crown, where the two beams start. |

Body material names select the city's look. They also carry sensible PBR
defaults, so the GLBs look right in any viewer: `Stone` (dark granite),
`Limestone` (warm limestone), `Marble` (white), `Brick` (red-brown), `Glass`
(dark blue-green, reflective), `Metal` (brushed steel), `Copper` (green patina),
`Concrete` (pale; also used for white fins and slab edges), `Roof` (dark
roofing; also the water tank), `Trim` (dark bronze or cast iron: spandrels,
storefronts).

Light materials (`Window`, `CrownLight`, `Accent`, `LED`, `Screen`, `Ring`)
export with a modest emissive so they read in a plain viewer. The city is
expected to replace them. Body materials are single-sided (`doubleSided:
false`); only `Flag` is double-sided. Normals face outward everywhere: this was
checked by rendering back faces in magenta from five directions.

### Windows: `_floor` and `_seed`

The `Windows` mesh has two point-domain float attributes. three.js reads them
as `_floor` and `_seed` (the GLB also uses those lower-case names).

- `_floor`: floor index, 0 = ground floor. Floor `i >= 1` spans
  `baseHeight + (i-1)*floorHeight` to `baseHeight + i*floorHeight`. Tall
  windows (the temple screen, bank windows, drum windows) are split into one
  pane per floor so they still light floor by floor.
- `_seed`: 0..1, identical on every vertex of one window. Seeds are grouped
  per model so lit windows make readable patterns instead of noise:
  - deco-spire: one seed per bay over runs of 3-6 floors (vertical streaks).
  - twist-tower: runs of 2-5 floors per column (streaks that follow the twist).
  - glass-led: runs of 2-5 bays along a floor (lit office stretches).
  - ring-cylinder: runs of 3-8 bays around a floor (horizontal bands).
  - Lobbies, entrances and storefronts use low seeds (mostly below 0.3), so
    they light first.
- Every window has a 0..1 UV (u left to right seen from outside, v up; arched
  panes are mapped to their bounding box), so a shader can add a room
  gradient or a frame. Windows sit about 0.012 in front of their wall; if
  z-fighting shows with a very small near plane, give the window material a
  small `polygonOffset`.

### Manifest

`manifest.json` maps each model key to an entry. Every point is in glTF/three.js
model space (Y up, front +Z, origin at the lot's ground centre).

```jsonc
{
  "deco-spire": {
    "height": 54.02,              // absolute top (spire tip, mast, ring)
    "roofHeight": 41.96,          // top of the main roof or crown mass
    "floors": 101,                // max _floor + 1
    "floorHeight": 0.38,
    "baseHeight": 0.6,            // ground-floor height (floor 0 spans 0..baseHeight)
    "footprint": { "w": 9.25, "d": 5.145 },
    "beacon": [0, 54, 0], "label": [0, 56, 0], "searchlight": [0, 40.588, 0],
    "nodes": ["Accent", "Beacon", "Body_Copper", "..."]
  },
  "glass-led":       { "...": "...", "led": { "name": "LED", "circumference": 19.94, "height": 2.22, "y": 36.35 } },
  "billboard-block": { "...": "...", "screens": [{ "name": "Screen_0", "width": 5.1, "height": 2.85 }],
                       "led": { "name": "LED", "circumference": 20.72, "height": 0.44, "y": 1.08 } }
}
```

`screens[].width` and `height` are world sizes, useful for canvas texture aspect
ratios. `led.circumference` is the length that u runs along, and `led.y` is
the height of the band's bottom edge.

## Editing in Blender

`hero_towers.blend` holds one scene per model (scene name = model key, objects
in a collection of the same name) and an `overview` scene that instances all
nine side by side. Object names are prefixed with the model (`deco-spire/Body_Limestone`,
`deco-spire/Windows`) because Blender names are global. The exporter strips the
prefix, and any `.001` suffix, from node and mesh names.

The script is the source of truth. For lasting changes, edit the builder
function (one per model, for example `build_deco_spire`) and rebuild. For quick
hand edits:

1. Open `assets/blender/hero_towers.blend`, pick the model's scene and edit.
   Keep material names as they are. Window faces need `_floor` and `_seed`:
   set them in Edit Mode with Mesh > Set Attribute, the same value on all
   corners of one window. Keep the origin at the lot's ground centre and apply
   transforms.
2. Re-export without rebuilding:

   ```sh
   blender assets/blender/hero_towers.blend -b -P assets/blender/build_hero_towers.py -- \
       --export-only --out apps/city/public/models [--only deco-spire]
   ```

   This recomputes the manifest entry (height, footprint, empties, floors)
   from the edited scene and compresses as usual.

## Budgets

Numbers from the last build. Height is the absolute top / `roofHeight`.
Footprint is w (x) by d (z). Sizes are the plain GLB and the shipped
meshopt GLB.

| Model | Height / roof | Footprint w x d | Floors | Triangles | Plain GLB | Shipped GLB (meshopt) |
|---|---|---|---|---|---|---|
| `deco-spire` | 54.02 / 41.96 | 9.25 x 5.14 | 101 | 6,822 | 457 KB | 84 KB |
| `glass-led` | 44.04 / 42.54 | 6.20 x 4.80 | 109 | 6,210 | 506 KB | 83 KB |
| `ring-cylinder` | 35.16 / 32.97 | 5.13 x 5.13 | 85 | 8,702 | 546 KB | 106 KB |
| `neoclassical` | 11.42 / 9.94 | 8.96 x 5.18 | 25 | 4,651 | 225 KB | 54 KB |
| `warehouse-loft` | 9.26 / 7.50 | 9.43 x 5.14 | 15 | 10,810 | 548 KB | 114 KB |
| `twist-tower` | 48.28 / 44.77 | 5.17 x 5.17 | 117 | 11,982 | 785 KB | 164 KB |
| `bank-dome` | 9.96 / 4.94 | 9.40 x 5.15 | 16 | 6,225 | 294 KB | 72 KB |
| `glass-pavilion` | 2.50 / 2.42 | 9.90 x 6.90 | 2 | 2,810 | 143 KB | 36 KB |
| `billboard-block` | 27.19 / 24.89 | 5.76 x 4.91 | 64 | 3,390 | 279 KB | 60 KB |

Total shipped: 772 KB for all nine.

All nine pass the Khronos glTF validator (`gltf-transform validate`) with no
errors, warnings or hints.

## How the models were checked

- **Backfaces.** Cycles renders back faces seen by the camera in magenta, from
  five directions per model. The script counts magenta pixels: every model
  has 0. Use `setup_preview_materials("normals")` and `render_preview()`, or
  `"normals-mat"` to colour back faces per material.
- **Floors.** For every window, the `_floor` band must contain the window's
  bottom edge, and all its vertices must share one `_seed` in [0, 1). Zero
  failures. The preview mode `"floors"` colours windows by floor parity.
- **Round trip.** Each GLB was re-imported into an empty Blender scene: node
  names match the manifest, the empties exist, and `_floor` / `_seed` survive.
  The compressed GLBs were also decoded independently with gltf-transform and
  meshoptimizer to check attributes, UV ranges, footprints, heights and beacons.
- **Read at distance.** Each model was rendered at the city camera's distance
  (80-110 units, 35° fov) to check that its silhouette and night lighting are
  recognisable.

## Not included

- **Baked ambient occlusion (COLOR_0) is not shipped.** It was tried
  (horizontal loops every two floors plus a Cycles AO bake to a corner colour
  attribute). The bake works, but several models embed fins, pilasters or corner
  posts right at the vertices of the surfaces behind them (ring-cylinder drum,
  bank drum, deco roofs). Those vertices are fully occluded, so whole surfaces
  went dark. It also doubled vertex counts. The city's N8AO pass covers contact
  shading.
- **Textures.** Everything is geometry plus named materials. Window, screen and
  LED content comes from the city's shaders.
