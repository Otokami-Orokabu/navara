import type ThreeView from "@navaramap/three";
import {
  Color,
  NORMAL_PACKING_SHADER,
  Pass,
  Plugin,
  SelectiveEffectDesc,
  createFullscreenQuad,
  eastNorthUpToFixedFrame,
  type EffectConfig,
  type EffectHandle,
  type EffectUpdate,
  type FeatureEvaluator,
  type GBufferName,
  type Layer,
  type MRTPassEffectDesc,
  type Source,
  type ViewContext,
} from "@navaramap/three";
import { Pass as PostProcessingPass } from "postprocessing";
import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  MathUtils,
  Matrix3,
  Matrix4,
  Mesh,
  type OrthographicCamera,
  type PerspectiveCamera,
  type PlaneGeometry,
  RGBAFormat,
  RepeatWrapping,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  Vector3,
  type WebGLRenderTarget,
  type WebGLRenderer,
} from "three";

export type BuildingWindowsOptions = {
  /** Share of windows that are lit on the tallest buildings, 0–1. */
  litRatio?: number;
  /** Floor pitch in meters. */
  floorHeight?: number;
  /** Window pitch along the wall in meters. */
  columnWidth?: number;
  /** Brightness multiplier of the lit windows. */
  intensity?: number;
};

export type BuildingWindowsEffectConfig = {
  buildingWindows: BuildingWindowsOptions;
} & EffectConfig;

export type BuildingWindowsEffectUpdate = {
  buildingWindows?: BuildingWindowsOptions;
} & EffectUpdate;

export type BuildingWindowsDescriptions = {
  effect: BuildingWindowsEffectConfig;
};

const DEFAULTS: Required<BuildingWindowsOptions> = {
  litRatio: 0.55,
  floorHeight: 3.5,
  columnWidth: 3,
  intensity: 1,
};

const EARTH_RADIUS = 6371000;

// --- World anchor ----------------------------------------------------------

// Re-anchor beyond this distance so float32 local coordinates stay precise.
const REANCHOR_DISTANCE = 50_000;

/**
 * A fixed east/north/up frame at a point on the ellipsoid under the camera.
 * Screen-space effects reconstruct camera-relative positions; adding
 * `cameraFromOrigin` turns them into coordinates that stay put in the world
 * while the camera moves.
 */
class WorldAnchor {
  readonly east = new Vector3();
  readonly north = new Vector3();
  readonly up = new Vector3();
  /** Camera position relative to the anchor origin, in world orientation. */
  readonly cameraFromOrigin = new Vector3();

  private readonly origin = new Vector3();
  private readonly cameraPosition = new Vector3();
  private readonly frame = new Matrix4();
  private anchored = false;

  update(camera: PerspectiveCamera, cameraHeight: number): void {
    this.cameraPosition.setFromMatrixPosition(camera.matrixWorld);
    this.cameraFromOrigin.subVectors(this.cameraPosition, this.origin);
    if (this.anchored && this.cameraFromOrigin.length() < REANCHOR_DISTANCE) {
      return;
    }

    // Drop the camera onto the ellipsoid along the geodetic up, then take the
    // frame at that point.
    this.frame.copy(eastNorthUpToFixedFrame(this.cameraPosition));
    this.up.setFromMatrixColumn(this.frame, 2);
    this.origin
      .copy(this.cameraPosition)
      .addScaledVector(this.up, -cameraHeight);
    this.frame.copy(eastNorthUpToFixedFrame(this.origin));
    this.east.setFromMatrixColumn(this.frame, 0);
    this.north.setFromMatrixColumn(this.frame, 1);
    this.up.setFromMatrixColumn(this.frame, 2);
    this.cameraFromOrigin.subVectors(this.cameraPosition, this.origin);
    this.anchored = true;
  }
}

// --- Window atlas ----------------------------------------------------------

// Window atlas: a CELLS × CELLS grid of window cells, each CELL texels square,
// repeated over the wall. Each cell holds one tall window; the RGBA channels
// are the lit pattern at cumulative LIT_LEVELS (a window lit at level k is lit
// at every higher level), with per-window brightness baked in.
const TEXTURE_SIZE = 1024;
const CELL = 16;
const CELLS = TEXTURE_SIZE / CELL;
const WINDOW_X = [5, 10];
const WINDOW_Y = [2, 14];
const LIT_LEVELS = [0.1, 0.3, 0.55, 0.85];
const MAX_BRIGHTNESS = 1.2;

// Lit decisions cluster: part per window, part per run of windows along the
// floor, part per whole floor, so lit windows come in rows and streaks.
const createWindowTexture = (): DataTexture => {
  // Seeded so the atlas is the same on every run; the generator is shared,
  // but these draws run to completion before anything else touches it.
  MathUtils.seededRandom(1);
  const rand = () => MathUtils.seededRandom();
  const floorRand = Array.from({ length: CELLS }, rand);
  const runLength = Array.from(
    { length: CELLS },
    () => 3 + Math.floor(rand() * 6),
  );
  const runRand = runLength.map((length) =>
    Array.from({ length: Math.ceil(CELLS / length) }, rand),
  );

  const data = new Uint8Array(TEXTURE_SIZE * TEXTURE_SIZE * 4);
  for (let floor = 0; floor < CELLS; floor++) {
    for (let column = 0; column < CELLS; column++) {
      const run = runRand[floor][Math.floor(column / runLength[floor])];
      const r = 0.45 * rand() + 0.3 * run + 0.25 * floorRand[floor];
      const brightness = 0.5 + 0.7 * rand();
      const value = Math.round((brightness / MAX_BRIGHTNESS) * 255);
      const channels = LIT_LEVELS.map((level) => (r < level ? value : 0));

      for (
        let y = floor * CELL + WINDOW_Y[0];
        y < floor * CELL + WINDOW_Y[1];
        y++
      ) {
        for (
          let x = column * CELL + WINDOW_X[0];
          x < column * CELL + WINDOW_X[1];
          x++
        ) {
          data.set(channels, (y * TEXTURE_SIZE + x) * 4);
        }
      }
    }
  }

  const texture = new DataTexture(
    data,
    TEXTURE_SIZE,
    TEXTURE_SIZE,
    RGBAFormat,
    UnsignedByteType,
  );
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
};

// --- Pass ------------------------------------------------------------------

const fragmentShader = /* glsl */ `
#include <packing>
${NORMAL_PACKING_SHADER}

uniform sampler2D tDiffuse;
uniform sampler2D tEffectIds;
uniform sampler2D tNormal;
uniform sampler2D tDepth;
uniform sampler2D tWindows;
uniform int uSlot;
uniform mat4 uInverseProjection;
uniform mat3 uCameraRotation;
uniform float uLogDepthFar;
uniform vec3 uEast;
uniform vec3 uNorth;
uniform vec3 uUp;
uniform vec3 uCameraFromOrigin;
uniform float uLitRatio;
uniform float uFloorHeight;
uniform float uColumnWidth;
uniform float uIntensity;
// Radians per screen pixel.
uniform float uPixelAngle;

varying vec2 vUv;

const float EARTH_RADIUS = ${EARTH_RADIUS.toFixed(1)};
const float CELLS = ${CELLS.toFixed(1)};
const float MAX_BRIGHTNESS = ${MAX_BRIGHTNESS.toFixed(2)};
// Lit share ramps from LOW_FRACTION on the ground to 1.0 at TALL_HEIGHT.
const float TALL_HEIGHT = 35.0;
const float LOW_FRACTION = 0.7;
// Color temperature varies in patches about this size (meters).
const float TINT_SCALE = 40.0;
const float FADE_DISTANCE = 6000.0;
// Windows shrunk to a pixel or two average out to a faint gray; brighten
// them up to this factor so low-rise districts still read as lit from afar.
const float FAR_BOOST = 3.0;
const vec3 WHITE = vec3(1.0, 0.97, 0.88);
const vec3 WARM = vec3(1.0, 0.78, 0.5);

float nvrHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float nvrTintNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = nvrHash(i);
  float b = nvrHash(i + vec2(1.0, 0.0));
  float c = nvrHash(i + vec2(0.0, 1.0));
  float d = nvrHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Interpolates the baked lit patterns to a continuous lit share.
float nvrLitMask(vec4 m, float ratio) {
  if (ratio < ${LIT_LEVELS[0]}) return m.r * (ratio / ${LIT_LEVELS[0]});
  if (ratio < ${LIT_LEVELS[1]}) return mix(m.r, m.g, (ratio - ${LIT_LEVELS[0]}) / ${LIT_LEVELS[1] - LIT_LEVELS[0]});
  if (ratio < ${LIT_LEVELS[2]}) return mix(m.g, m.b, (ratio - ${LIT_LEVELS[1]}) / ${LIT_LEVELS[2] - LIT_LEVELS[1]});
  if (ratio < ${LIT_LEVELS[3]}) return mix(m.b, m.a, (ratio - ${LIT_LEVELS[2]}) / ${LIT_LEVELS[3] - LIT_LEVELS[2]});
  return m.a;
}

// No early returns: the atlas lookup relies on screen-space derivatives for
// its mip level, which need uniform control flow.
void main() {
  vec4 base = texture2D(tDiffuse, vUv);
  int mask = int(texture2D(tEffectIds, vUv).r + 0.5);
  float depth = unpackRGBAToDepth(texture2D(tDepth, vUv));
  float selected = float((mask >> uSlot) & 1) * (1.0 - step(1.0 - 1.0 / 8388608.0, depth));

  vec3 normalWorld = uCameraRotation * unpackVec2ToNormal(texture2D(tNormal, vUv).xy);
  // Roofs and floors get no windows.
  float wall = 1.0 - step(0.5, abs(dot(normalWorld, uUp)));

  // Position relative to the anchor origin, in world orientation.
  vec4 nearPoint = uInverseProjection * vec4(vUv * 2.0 - 1.0, -1.0, 1.0);
  vec3 nearEc = nearPoint.xyz / nearPoint.w;
  float eyeDistance = exp2(depth * uLogDepthFar) - 1.0;
  vec3 local = uCameraRotation * (nearEc * (eyeDistance / -nearEc.z)) + uCameraFromOrigin;

  // Height above the ellipsoid. The ground itself drops below the anchor's
  // tangent plane with distance (by d² / 2R), so that drop is added back.
  float rise = dot(local, uUp);
  float horizontal2 = dot(local, local) - rise * rise;
  float height = rise + horizontal2 / (2.0 * EARTH_RADIUS);
  float aboveGround = step(0.0, height);

  // Distance along the wall on the anchor's ground plane.
  vec2 plane = vec2(dot(local, uEast), dot(local, uNorth));
  vec3 tangent = cross(uUp, normalWorld);
  vec2 alongRaw = vec2(dot(tangent, uEast), dot(tangent, uNorth));
  float alongLength = length(alongRaw);
  vec2 along = alongLength > 1e-4 ? alongRaw / alongLength : vec2(1.0, 0.0);
  float s = dot(plane, along);

  vec2 uv = vec2(s / uColumnWidth, height / uFloorHeight) / CELLS;
  vec4 masks = texture2D(tWindows, uv);
  float ratio = uLitRatio * mix(LOW_FRACTION, 1.0, smoothstep(0.0, TALL_HEIGHT, height));
  float lit = nvrLitMask(masks, ratio) * MAX_BRIGHTNESS;

  float warmth = nvrTintNoise(plane / TINT_SCALE);
  vec3 color = mix(WHITE, WARM, smoothstep(0.35, 0.75, warmth));

  // Distant walls hold thousands of windows per pixel; without this they
  // bloom into a white sheet. Squared so the foreground keeps full strength.
  float ratioDistance = eyeDistance / FADE_DISTANCE;
  float fade = exp(-ratioDistance * ratioDistance);

  // Boost once a pixel spans more than half a window pitch.
  float metersPerPixel = eyeDistance * uPixelAngle;
  float boost = clamp(
    (2.0 * metersPerPixel) / min(uColumnWidth, uFloorHeight),
    1.0,
    FAR_BOOST
  );

  vec3 glow = color * (lit * fade * boost * uIntensity * selected * wall * aboveGround);
  gl_FragColor = vec4(base.rgb + glow, base.a);
}
`;

const vertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const isBuildingWindowsOptions = (
  value: unknown,
): value is BuildingWindowsOptions =>
  typeof value === "object" && value !== null;

class BuildingWindowsPass extends PostProcessingPass {
  private readonly desc: BuildingWindowsEffectDesc;
  private readonly mrt: MRTPassEffectDesc;
  private readonly material: ShaderMaterial;
  private readonly windowTexture: DataTexture;
  private readonly quadScene = new Scene();
  private readonly quadCamera: OrthographicCamera;
  private readonly quadGeometry: PlaneGeometry;
  private readonly anchor = new WorldAnchor();

  constructor(desc: BuildingWindowsEffectDesc, mrt: MRTPassEffectDesc) {
    super("BuildingWindowsPass");
    this.desc = desc;
    this.mrt = mrt;

    const quad = createFullscreenQuad();
    this.quadCamera = quad.camera;
    this.quadGeometry = quad.geometry;
    this.windowTexture = createWindowTexture();

    this.material = new ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tEffectIds: { value: null },
        tNormal: { value: null },
        tDepth: { value: null },
        tWindows: { value: this.windowTexture },
        uSlot: { value: 0 },
        uInverseProjection: { value: new Matrix4() },
        uCameraRotation: { value: new Matrix3() },
        uLogDepthFar: { value: 1 },
        uEast: { value: this.anchor.east },
        uNorth: { value: this.anchor.north },
        uUp: { value: this.anchor.up },
        uCameraFromOrigin: { value: this.anchor.cameraFromOrigin },
        uLitRatio: { value: DEFAULTS.litRatio },
        uFloorHeight: { value: DEFAULTS.floorHeight },
        uColumnWidth: { value: DEFAULTS.columnWidth },
        uIntensity: { value: DEFAULTS.intensity },
        uPixelAngle: { value: 0 },
      },
      vertexShader,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this.quadScene.add(new Mesh(this.quadGeometry, this.material));
  }

  render(
    renderer: WebGLRenderer,
    inputBuffer: WebGLRenderTarget,
    outputBuffer: WebGLRenderTarget,
  ): void {
    const uniforms = this.material.uniforms;
    const camera = this.desc.getCamera();

    this.anchor.update(camera, this.desc.getCameraHeight());

    uniforms.tDiffuse.value = inputBuffer.texture;
    uniforms.tEffectIds.value = this.desc.getEffectIdsBuffer();
    // Re-read every frame: a G-buffer config change rebuilds the attachments.
    uniforms.tNormal.value = this.mrt.normalBuffer;
    uniforms.tDepth.value = this.mrt.depthBuffer;
    uniforms.uSlot.value = Math.max(0, this.desc.getEffectSlot());
    uniforms.uInverseProjection.value.copy(camera.projectionMatrixInverse);
    uniforms.uCameraRotation.value.setFromMatrix4(camera.matrixWorld);
    uniforms.uLogDepthFar.value = Math.log2(camera.far + 1);
    uniforms.uLitRatio.value = this.desc.options.litRatio;
    uniforms.uFloorHeight.value = this.desc.options.floorHeight;
    uniforms.uColumnWidth.value = this.desc.options.columnWidth;
    uniforms.uIntensity.value = this.desc.options.intensity;
    uniforms.uPixelAngle.value =
      (2 * Math.tan((camera.fov * Math.PI) / 360)) / inputBuffer.height;

    renderer.setRenderTarget(this.renderToScreen ? null : outputBuffer);
    renderer.render(this.quadScene, this.quadCamera);
  }

  dispose(): void {
    this.quadScene.clear();
    this.quadGeometry.dispose();
    this.windowTexture.dispose();
    this.material.dispose();
  }
}

// --- Effect ----------------------------------------------------------------

/**
 * Pastes a tall-window atlas on the walls of layers that list this effect in
 * `effectIds`: a floor/column grid anchored to the world, with the lit share
 * rising with height above the ellipsoid.
 */
export class BuildingWindowsEffectDesc extends SelectiveEffectDesc<
  BuildingWindowsEffectConfig & { selectiveEffect?: true },
  BuildingWindowsEffectUpdate
> {
  static key = "buildingWindows";
  static insertAfter = ["mrt"];
  static insertBefore = ["transparent"];
  static requiredBuffers: readonly GBufferName[] = [
    "normal",
    "selectiveEffect",
  ];

  // The effect registry hands over the generic EffectConfig.
  constructor(view: ThreeView, ctx: ViewContext, config: EffectConfig) {
    super(view, ctx, {
      ...config,
      buildingWindows:
        "buildingWindows" in config &&
        isBuildingWindowsOptions(config.buildingWindows)
          ? { ...config.buildingWindows }
          : {},
      selectiveEffect: true,
    });
  }

  get options(): Required<BuildingWindowsOptions> {
    return { ...DEFAULTS, ...this.config.buildingWindows };
  }

  onUpdateConfig(updates: BuildingWindowsEffectUpdate): void {
    super.onUpdateConfig(updates);
    Object.assign(this.config.buildingWindows, updates.buildingWindows);
  }

  getCamera() {
    return this.view.camera.raw;
  }

  getCameraHeight() {
    return this.view.camera.positionGeographic.height;
  }

  createPass(): Pass<BuildingWindowsPass, null> {
    const mrt = this.find<MRTPassEffectDesc>("mrt");
    if (!mrt) throw new Error("BuildingWindowsEffectDesc: MRT pass not found.");
    return new Pass(new BuildingWindowsPass(this, mrt), null, {
      enabled: true,
    });
  }
}

// --- Plugin ----------------------------------------------------------------

export type BuildingsOptions = {
  source: Source;
  /** Source layers holding the footprints. */
  sourceLayers?: string[];
  /** Wall color before the windows are painted on. */
  color?: Color;
};

const DEFAULT_WALL_COLOR = new Color().setStyle("#d9d0c9");

// Buildings without height data get a height picked per building, 6–16 m,
// so low-rise districts vary instead of sitting at one flat height.
const estimatedHeight = (batchId: number) =>
  6 + 10 * ((Math.imul(batchId, 2654435761) >>> 0) / 4294967296);

/**
 * Lit windows on buildings. Add before `view.init()`; afterwards hand it the
 * building sources, and it takes care of the effect and the per-feature
 * heights. Built on the Tier 1 `Plugin` / `ViewContext` API and on the
 * G-buffer's internal layout, so it is tied to the Navara version it was
 * written against.
 *
 * ```ts
 * const buildingWindows = new BuildingWindowsPlugin({ litRatio: 0.55 });
 * view.addPlugin(buildingWindows);
 * await view.init();
 * buildingWindows.addBuildings({ source: openfreemap });
 * buildingWindows.update({ litRatio: 0.7 });
 * ```
 */
export class BuildingWindowsPlugin extends Plugin<
  ThreeView<BuildingWindowsDescriptions>,
  ViewContext
> {
  private view?: ThreeView<BuildingWindowsDescriptions>;
  private effect?: EffectHandle<BuildingWindowsEffectDesc>;
  private readonly options: BuildingWindowsOptions;

  constructor(options: BuildingWindowsOptions = {}) {
    super();
    this.options = { ...options };
  }

  async init(view: ThreeView<BuildingWindowsDescriptions>): Promise<void> {
    this.view = view;
    view.registerEffect(
      BuildingWindowsEffectDesc.key,
      BuildingWindowsEffectDesc,
    );
  }

  // Effects can only be added once the view is initialized, so the effect
  // is created on first use.
  private get ready(): {
    view: ThreeView<BuildingWindowsDescriptions>;
    effect: EffectHandle<BuildingWindowsEffectDesc>;
  } {
    if (!this.view) {
      throw new Error(
        "BuildingWindowsPlugin: call view.addPlugin() and view.init() first.",
      );
    }
    this.effect ??= this.view.addEffect<BuildingWindowsEffectDesc>({
      buildingWindows: { ...this.options },
    });
    return { view: this.view, effect: this.effect };
  }

  /**
   * Extruded footprints from a vector source, with windows on their walls.
   * Heights follow the OpenMapTiles `building` schema: `render_height` on top
   * of the ground, and outlines whose building:part features are drawn
   * separately (`hide_3d`) are hidden. Parts always rise from the ground,
   * since parts mapped only for the upper floors would otherwise float.
   */
  addBuildings({
    source,
    sourceLayers = ["building"],
    color = DEFAULT_WALL_COLOR,
  }: BuildingsOptions): Layer {
    const { view, effect } = this.ready;
    const buildings = view.addLayer({
      type: "vector",
      source,
      sourceLayers,
      polygon: {
        color,
        // Seeds the attribute slots; the evaluator sets the values per feature.
        height: 0,
        extrudedHeight: 0,
        clampToGround: false,
        effectIds: [effect.id],
      },
    });

    const apply = ({ evaluator }: { evaluator: FeatureEvaluator }) => {
      evaluator.evaluate(({ properties, batchId }) => {
        if (properties?.hide_3d === true) return { show: false };
        const top = properties?.render_height;
        return {
          show: true,
          height: 0,
          extrudedHeight:
            typeof top === "number" ? top : estimatedHeight(batchId),
        };
      });
    };
    buildings.on("featureCreated", apply);
    buildings.on("featureUpdated", apply);
    return buildings;
  }

  update(options: BuildingWindowsOptions): void {
    Object.assign(this.options, options);
    this.ready.effect.update({ buildingWindows: options });
  }
}
