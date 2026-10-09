"use client";

import { MeshReflectorMaterial } from "@react-three/drei";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { createFarGroundMaterial, createGroundMaterial } from "@/lib/scene/groundMaterial";
import { FAR_SHORES, HARBOR_ISLAND, ISLAND, POND, WATER_LEVEL, type Vec2 } from "@/lib/scene/layout";
import type { CityUniforms } from "@/lib/scene/materials";
import { GLSL_HASH } from "@/lib/scene/glsl";
import type { ParkModel } from "@/lib/scene/parkGen";
import { createParkTexture, createRippleNormals, createShoreSdf } from "@/lib/scene/textures";
import { useCity } from "./cityContext";

function shapeOf(points: readonly Vec2[]): THREE.Shape {
  // Shape space (x, y) maps to world (x, -z) after rotating -90 degrees about x.
  const shape = new THREE.Shape();
  points.forEach(([x, z], i) => (i ? shape.lineTo(x, -z) : shape.moveTo(x, -z)));
  shape.closePath();
  return shape;
}

function slabGeometry(points: readonly Vec2[], depth: number): THREE.BufferGeometry {
  const geo = new THREE.ExtrudeGeometry(shapeOf(points), { depth, bevelEnabled: false, curveSegments: 1, steps: 1 });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, -depth, 0);
  geo.computeVertexNormals();
  return geo;
}

export function Island({ park }: { park: ParkModel }) {
  const { uniforms } = useCity();
  const { geo, mats, farGeo, farMats } = useMemo(() => {
    const sdf = createShoreSdf();
    const parkTex = createParkTexture(park);
    const top = createGroundMaterial(uniforms, { shoreSdf: sdf, park: parkTex });
    const wall = new THREE.MeshStandardMaterial({ color: "#2b2a29", roughness: 0.92 });
    const farTop = createFarGroundMaterial(uniforms);
    const farWall = new THREE.MeshStandardMaterial({ color: "#1d1c1c", roughness: 0.95 });
    // Merge the far shores to keep one draw call per material.
    const shores = [...FAR_SHORES, HARBOR_ISLAND].map((p) => slabGeometry(p, 1.4));
    const mergedGeo = mergeWithGroups(shores);
    shores.forEach((g) => g.dispose());
    return {
      geo: slabGeometry(ISLAND, 1.4),
      mats: [top, wall],
      farGeo: mergedGeo,
      farMats: [farTop, farWall],
    };
  }, [park, uniforms]);

  useEffect(
    () => () => {
      geo.dispose();
      farGeo.dispose();
      mats.forEach((m) => m.dispose());
      farMats.forEach((m) => m.dispose());
    },
    [geo, farGeo, mats, farMats],
  );

  return (
    <group name="ground">
      <mesh geometry={geo} material={mats} />
      <mesh geometry={farGeo} material={farMats} />
    </group>
  );
}

/** Concatenate extruded slabs, keeping caps in group 0 and walls in group 1. */
function mergeWithGroups(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const caps: number[][] = [[], []];
  const capN: number[][] = [[], []];
  for (const g of geos) {
    const ng = g.index ? g.toNonIndexed() : g;
    const pos = ng.attributes.position!;
    const nor = ng.attributes.normal!;
    const groups = g.groups.length ? g.groups : [{ start: 0, count: pos.count, materialIndex: 0 }];
    for (const grp of groups) {
      const mi = Math.min(1, grp.materialIndex ?? 0);
      for (let i = grp.start; i < grp.start + grp.count; i++) {
        caps[mi]!.push(pos.getX(i), pos.getY(i), pos.getZ(i));
        capN[mi]!.push(nor.getX(i), nor.getY(i), nor.getZ(i));
      }
    }
  }
  const out = new THREE.BufferGeometry();
  const all = [...caps[0]!, ...caps[1]!];
  const allN = [...capN[0]!, ...capN[1]!];
  out.setAttribute("position", new THREE.Float32BufferAttribute(all, 3));
  out.setAttribute("normal", new THREE.Float32BufferAttribute(allN, 3));
  out.addGroup(0, caps[0]!.length / 3, 0);
  out.addGroup(caps[0]!.length / 3, caps[1]!.length / 3, 1);
  out.computeBoundingSphere();
  return out;
}

// --- Water -----------------------------------------------------------------

const WATER_FRAG_HEAD = /* glsl */ `
uniform float uTime;
uniform float uReflect;
uniform sampler2D uRipple;
varying vec2 vWaterXZ;
${GLSL_HASH}
`;

function patchWater(shader: THREE.WebGLProgramParametersWithUniforms, u: CityUniforms, ripple: THREE.Texture, reflect: boolean) {
  shader.uniforms.uTime = u.uTime;
  shader.uniforms.uRipple = { value: ripple };
  shader.uniforms.uReflect = { value: reflect ? 1 : 0 };
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", "#include <common>\nvarying vec2 vWaterXZ;")
    .replace("#include <begin_vertex>", "#include <begin_vertex>\nvWaterXZ = (modelMatrix * vec4(position, 1.0)).xz;");
  shader.fragmentShader = shader.fragmentShader.replace("#include <common>", `#include <common>\n${WATER_FRAG_HEAD}`);
  // Rippled normal for the sky sheen.
  shader.fragmentShader = shader.fragmentShader.replace(
    "#include <normal_fragment_maps>",
    /* glsl */ `#include <normal_fragment_maps>
    vec2 rUv1 = vWaterXZ * 0.045 + vec2(uTime * 0.006, uTime * 0.011);
    vec2 rUv2 = vWaterXZ * vec2(0.11, 0.07) - vec2(uTime * 0.012, uTime * 0.004);
    vec2 rip = (texture2D(uRipple, rUv1).xy + texture2D(uRipple, rUv2).xy) - 1.0;
    normal = normalize(normal + (viewMatrix * vec4(rip.x, 0.0, rip.y, 0.0)).xyz * 0.32);`,
  );
  if (reflect) {
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "vec4 new_vUv = my_vUv;",
        /* glsl */ `vec4 new_vUv = my_vUv;
        // Ripples smear reflections into long vertical streaks.
        new_vUv.x += rip.x * 0.006 * new_vUv.w;
        new_vUv.y += (rip.y * 0.03 + rip.x * 0.01) * new_vUv.w;`,
      )
      .replace(
        "diffuseColor.rgb = diffuseColor.rgb * ((1.0 - min(1.0, mirror)) + newMerge.rgb * mixStrength);",
        /* glsl */ `{
          float ndv = clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0);
          float fres = mix(0.32, 1.0, pow(1.0 - ndv, 3.0));
          totalEmissiveRadiance += max(merge.rgb, 0.0) * mixStrength * fres * mirror;
        }`,
      );
  }
}

export function Water({ lowGraphics }: { lowGraphics: boolean }) {
  const { uniforms } = useCity();
  const ripple = useMemo(() => createRippleNormals(), []);
  const lowMat = useMemo(() => {
    const m = new THREE.MeshStandardMaterial({ color: "#070b14", roughness: 0.22, metalness: 0.2, envMapIntensity: 1.2 });
    m.onBeforeCompile = (shader) => patchWater(shader, uniforms, ripple, false);
    m.customProgramCacheKey = () => "water-low-v1";
    return m;
  }, [uniforms, ripple]);
  useEffect(() => () => {
    ripple.dispose();
    lowMat.dispose();
  }, [ripple, lowMat]);

  const patchRef = (mat: THREE.MeshStandardMaterial | null) => {
    if (!mat || (mat.userData as { cityPatched?: boolean }).cityPatched) return;
    (mat.userData as { cityPatched?: boolean }).cityPatched = true;
    const original = mat.onBeforeCompile.bind(mat);
    mat.onBeforeCompile = (shader, renderer) => {
      original(shader, renderer);
      patchWater(shader, uniforms, ripple, true);
    };
    mat.customProgramCacheKey = () => "water-reflector-v1";
    mat.needsUpdate = true;
  };

  return (
    <mesh rotation-x={-Math.PI / 2} position={[0, WATER_LEVEL, 0]} name="water">
      <planeGeometry args={[2600, 2600, 1, 1]} />
      {lowGraphics ? (
        <primitive object={lowMat} attach="material" />
      ) : (
        <MeshReflectorMaterial
          ref={patchRef}
          resolution={768}
          blur={[220, 90]}
          mixBlur={0.75}
          mixStrength={1.0}
          mirror={0.8}
          color="#060a12"
          roughness={0.42}
          metalness={0.25}
          envMapIntensity={1.0}
        />
      )}
    </mesh>
  );
}

export function Pond() {
  const geo = useMemo(() => {
    const g = new THREE.ShapeGeometry(shapeOf(POND), 1);
    g.rotateX(-Math.PI / 2);
    g.translate(0, 0.03, 0);
    return g;
  }, []);
  useEffect(() => () => geo.dispose(), [geo]);
  return (
    <mesh geometry={geo}>
      <meshStandardMaterial color="#04070d" roughness={0.06} metalness={0.3} envMapIntensity={1.6} />
    </mesh>
  );
}
