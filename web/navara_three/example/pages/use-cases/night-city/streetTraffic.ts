import type ThreeView from "@navaramap/three";
import {
  MeshDesc,
  type MeshConfig,
  type MeshUpdate,
  type ViewContext,
} from "@navaramap/three";
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Points,
  ShaderMaterial,
} from "three";

/** Per-car segments, as ECEF offsets from a shared origin. */
export type StreetTrafficData = {
  start: Float32Array;
  end: Float32Array;
  phase: Float32Array;
  speed: Float32Array;
};

export type StreetTrafficOptions = {
  /** Multiplier on every car's speed. */
  speed?: number;
  /** Diameter of a car's light in meters. */
  size?: number;
};

type Description = {
  streetTraffic: { data: StreetTrafficData } & StreetTrafficOptions;
};

export type StreetTrafficMeshConfig = MeshConfig & Description;

export type StreetTrafficMeshUpdate = MeshUpdate & {
  streetTraffic?: StreetTrafficOptions;
};

export type StreetTrafficDescriptions = { mesh: StreetTrafficMeshConfig };

const DEFAULTS: Required<StreetTrafficOptions> = {
  speed: 1,
  size: 2.5,
};

const isStreetTrafficMeshConfig = (
  config: MeshConfig,
): config is StreetTrafficMeshConfig =>
  "streetTraffic" in config &&
  typeof config.streetTraffic === "object" &&
  config.streetTraffic !== null &&
  "data" in config.streetTraffic;

const vertexShader = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

attribute vec3 aEnd;
attribute float aPhase;
attribute float aSpeed;

uniform float uTime;
uniform float uSpeedScale;
uniform float uSize;
uniform vec3 uViewport;
uniform float uTanHalfFov;

varying vec3 vColor;
varying float vFade;

const vec3 HEADLIGHT = vec3(1.0, 0.97, 0.9);
const vec3 TAILLIGHT = vec3(1.0, 0.15, 0.08);

void main() {
  vec3 along = aEnd - position;
  float segmentLength = max(length(along), 0.001);
  float t = fract(aPhase + uTime * aSpeed * uSpeedScale / segmentLength);
  // modelViewMatrix is built on the CPU, so the kilometers-scale offsets of
  // the origin never meet float32 here.
  vec4 mvPosition = modelViewMatrix * vec4(position + along * t, 1.0);
  gl_Position = projectionMatrix * mvPosition;

  // Headlights toward the camera, taillights away from it.
  vec3 directionView = normalize((modelViewMatrix * vec4(along, 0.0)).xyz);
  float facing = dot(directionView, normalize(-mvPosition.xyz));
  vColor = mix(TAILLIGHT, HEADLIGHT, smoothstep(-0.15, 0.15, facing));

  // Ease in and out at the segment ends instead of popping.
  vFade = smoothstep(0.0, 0.08, t) * (1.0 - smoothstep(0.92, 1.0, t));

  float pixelsPerMeter = (uViewport.y * uViewport.z * 0.5) / (uTanHalfFov * -mvPosition.z);
  float sizePx = uSize * pixelsPerMeter;
  gl_PointSize = clamp(sizePx, 1.0, 24.0);
  // Sub-pixel cars dim out instead of piling up as fixed-size dots.
  vFade *= smoothstep(0.3, 2.0, sizePx);

  #include <logdepthbuf_vertex>
}
`;

const fragmentShader = /* glsl */ `
#include <logdepthbuf_pars_fragment>

varying vec3 vColor;
varying float vFade;

void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  float soft = 1.0 - smoothstep(0.5, 1.0, d);
  gl_FragColor = vec4(vColor * soft * vFade, 1.0);
  #include <logdepthbuf_fragment>
}
`;

/**
 * Street traffic: one point per car, each driving its road segment on the GPU and
 * wrapping around. Headlights face the camera white, taillights red.
 */
export class StreetTrafficMeshDesc extends MeshDesc<
  StreetTrafficMeshConfig,
  StreetTrafficMeshUpdate,
  Points<BufferGeometry, ShaderMaterial>
> {
  static key = "streetTraffic";

  private config: StreetTrafficMeshConfig;

  // The mesh registry hands over the generic MeshConfig.
  constructor(view: ThreeView, ctx: ViewContext, config: MeshConfig) {
    if (!isStreetTrafficMeshConfig(config)) {
      throw new Error(
        "StreetTrafficMeshDesc: `streetTraffic.data` is required.",
      );
    }
    super(view, ctx, config);
    this.config = config;
  }

  private get options(): Required<StreetTrafficOptions> {
    const { speed, size } = this.config.streetTraffic;
    return { speed: speed ?? DEFAULTS.speed, size: size ?? DEFAULTS.size };
  }

  createMesh() {
    const { data } = this.config.streetTraffic;
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(data.start, 3));
    geometry.setAttribute("aEnd", new BufferAttribute(data.end, 3));
    geometry.setAttribute("aPhase", new BufferAttribute(data.phase, 1));
    geometry.setAttribute("aSpeed", new BufferAttribute(data.speed, 1));

    // Stays in the default opaque pass, which is forward-rendered after the
    // G-buffer copy: the lights need no normals or effect ids, so the
    // material does not opt in to MRT.
    const material = new ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uSpeedScale: { value: this.options.speed },
        uSize: { value: this.options.size },
        uViewport: this.ctx.getViewportAndPixelRatioUniform(),
        uTanHalfFov: { value: 1 },
      },
      vertexShader,
      fragmentShader,
      // Additive so the soft edges add light instead of cutting dark discs.
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });

    const points = new Points(geometry, material);
    // Cars cover kilometers; the set as a whole is always partly in view.
    points.frustumCulled = false;
    return points;
  }

  update(time: number): void {
    if (!this._instance) return;
    const uniforms = this._instance.material.uniforms;
    uniforms.uTime.value = time / 1000;
    uniforms.uTanHalfFov.value = Math.tan(
      (this.view.camera.raw.fov * Math.PI) / 360,
    );
  }

  onUpdateConfig(updates: StreetTrafficMeshUpdate): void {
    super.onUpdateConfig(updates);
    Object.assign(this.config.streetTraffic, updates.streetTraffic);
    if (!this._instance) return;
    const uniforms = this._instance.material.uniforms;
    uniforms.uSpeedScale.value = this.options.speed;
    uniforms.uSize.value = this.options.size;
  }
}
