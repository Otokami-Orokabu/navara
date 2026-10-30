import type ThreeView from "@navaramap/three";
import {
  Color,
  Plugin,
  type EffectHandle,
  type FeatureEvaluator,
  type Layer,
  type Source,
  type ViewContext,
} from "@navaramap/three";
import type {
  BuildingWindowsConfig,
  BuildingWindowsEffectDesc,
  BuildingWindowsOptions,
} from "@navaramap/three-default-descs";

export type BuildingWindowsDescriptions = {
  effect: BuildingWindowsConfig;
};

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
 * Lit windows on buildings, through the built-in `buildingWindows` effect
 * (registered by `DefaultPlugin`). Add before `view.init()`; afterwards hand
 * it the building sources, and it takes care of the effect and the
 * per-feature heights.
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
