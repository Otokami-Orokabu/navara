import type ThreeView from "@navaramap/three";
import { Color } from "@navaramap/three";
import {
  DefaultPlugin,
  type DefaultDescriptions,
} from "@navaramap/three-default-plugin";
import { TileJsonPlugin } from "@navaramap/three-plugins";
import { Pane } from "tweakpane";

import {
  OPEN_FREE_MAP_TILEJSON,
  TILE_DATASETS,
} from "../../../helpers/constants";

import { BloomEffectDesc, type BloomDescriptions } from "./bloom";
import {
  BuildingWindowsPlugin,
  type BuildingWindowsDescriptions,
} from "./buildingWindows";
import { StreetsPlugin } from "./streets";
import type { StreetTrafficDescriptions } from "./streetTraffic";

export type NightDescriptions =
  | DefaultDescriptions
  | BuildingWindowsDescriptions
  | StreetTrafficDescriptions
  | BloomDescriptions;

type NightView = ThreeView<NightDescriptions>;

/**
 * Level of detail by camera altitude. Below `DETAIL_MAX_ALTITUDE` the streets
 * carry lamps, traffic and lit windows over dark road lines; above it those
 * go away and the map's own roads carry the city.
 */
type Lod = "street" | "aerial";

const DETAIL_MAX_ALTITUDE = 6000;

const lodForAltitude = (altitude: number): Lod =>
  altitude < DETAIL_MAX_ALTITUDE ? "street" : "aerial";

// Tiles of lights kept loaded around the camera, as a radius in tiles
// (2 = a 5 × 5 block, about 10 km across at Tokyo's latitude).
const STREET_TILE_RADIUS = 2;

// From the air the bloom eases off: the city is all small lights there.
const FAR_BLOOM_INTENSITY = 0.5;

// Lights come on as the sun sets: darkness is 1 with the sun 6° or more
// below the horizon (civil twilight) and 0 once it is 3° up.
const LIGHTS_ON_BELOW = Math.sin((-6 * Math.PI) / 180);
const LIGHTS_OFF_ABOVE = Math.sin((3 * Math.PI) / 180);

// Tunables, bound to the panel at the bottom.
const timeParams = { hour: 20 };
const starsParams = { intensity: 400 };
const bloomParams = { intensity: 1.2, threshold: 0.5, radius: 0.75 };
const windowsParams = {
  litRatio: 0.55,
  floorHeight: 3.5,
  columnWidth: 3,
  intensity: 1,
};
const mapParams = { brightness: 1 };
const trafficParams = { speed: 1, size: 2.5 };

export const run = async (view: NightView) => {
  const defaultPlugin = new DefaultPlugin();
  view.addPlugin(defaultPlugin);
  const tilejson = new TileJsonPlugin();
  view.addPlugin(tilejson);
  const buildingWindows = new BuildingWindowsPlugin(windowsParams);
  view.addPlugin(buildingWindows);
  const streets = new StreetsPlugin({
    radius: STREET_TILE_RADIUS,
    traffic: trafficParams,
  });
  view.addPlugin(streets);

  await view.init();

  view.registerEffect(BloomEffectDesc.key, BloomEffectDesc);

  const START = { lng: 139.762, lat: 35.672 };
  view.setCamera({
    ...START,
    height: 350,
    heading: 35,
    pitch: -14,
    roll: 0,
  });

  // --- Sky and light ---------------------------------------------------------

  // The clock drives the light: the photoreal set (sky, stars, sun, sky light,
  // aerial perspective, tone mapping, antialiasing) at 20:00 local solar time
  // today unless the slider says otherwise.
  const scene = defaultPlugin.addDefaultPhotorealScene();
  const stars = scene.stars;
  stars.update({ stars: { pointSize: 2, ...starsParams } });
  // A faint floor so walls still read on a moonless night.
  view.addLight({ ambient: { intensity: 0.08 } });
  const bloom = view.addEffect<BloomEffectDesc>({ bloom: { ...bloomParams } });

  // `hour` is local solar time at `lng`, where the camera is, so the slider
  // means the same over Tokyo and over New York: today, at that solar hour.
  // (The camera's own position is not readable before the first frame,
  // hence the explicit longitude.)
  let hourLng = Number.NaN;
  const setHour = (hour: number, lng: number) => {
    view.atmosphere.setSolarTime({ lng }, hour);
    hourLng = lng;
  };
  setHour(timeParams.hour, START.lng);

  // --- Map -------------------------------------------------------------------

  const osm = view.addSource({
    type: "raster-tile",
    url: TILE_DATASETS.openstreetmap.url,
    maxZoom: 18,
  });
  // A tint on top of the sun's lighting: as is by default, dimmed only by its
  // slider.
  const mapTint = (brightness: number) =>
    new Color().setRGB(brightness, brightness, brightness);
  const map = view.addLayer({
    type: "raster",
    source: osm,
    raster: { color: mapTint(mapParams.brightness) },
  });
  view.attribution?.add([TILE_DATASETS.openstreetmap]);

  // OpenMapTiles-schema vector tiles built from OSM. The plugin adds the
  // TileJSON attribution to the attribution UI; the same document names the
  // tile URL template the streets stream their road tiles from.
  let tileTemplate = "";
  tilejson.on("loaded", ({ tilejson: document }) => {
    tileTemplate = document.tiles[0];
  });
  const openfreemap = await tilejson.addSource({
    type: "vector-tile",
    url: OPEN_FREE_MAP_TILEJSON,
  });

  // --- Buildings and streets -------------------------------------------------

  buildingWindows.addBuildings({ source: openfreemap });
  streets.addRoads(openfreemap);
  // Street lamps, roof beacons and traffic stream in around the camera, one
  // tile of roads at a time, wherever it goes.
  streets.start(tileTemplate);

  // --- Darkness and level of detail ------------------------------------------

  let lod: Lod = "street";
  let darkness = 1;

  const currentDarkness = () => {
    const sun = view.atmosphere.sunDirection;
    const { x, y, z } = view.camera.positionECEF;
    const sinElevation =
      (sun.x * x + sun.y * y + sun.z * z) / Math.hypot(x, y, z);
    const t =
      (sinElevation - LIGHTS_ON_BELOW) / (LIGHTS_OFF_ABOVE - LIGHTS_ON_BELOW);
    return 1 - Math.min(1, Math.max(0, t));
  };

  // Windows, stars, street lights and the bloom follow the darkness; the map
  // is left to the sun and its own slider.
  const applyWindows = () =>
    buildingWindows.update({ intensity: windowsParams.intensity * darkness });
  const applyStars = () =>
    stars.update({ stars: { intensity: starsParams.intensity * darkness } });
  // Eases off from the air and by day, where sunlit walls would glow.
  const applyBloom = () =>
    bloom.update({
      bloom: {
        intensity:
          (lod === "street" ? bloomParams.intensity : FAR_BLOOM_INTENSITY) *
          (0.3 + 0.7 * darkness),
      },
    });

  // Re-evaluated when the camera moves (postUpdate only fires on state
  // changes) and when the clock moves the sun.
  const refresh = () => {
    const { lng, lat, height } = view.camera.positionGeographic;

    // Keeps the slider's solar hour as the camera crosses longitudes.
    if (Math.abs(lng - hourLng) > 0.5) setHour(timeParams.hour, lng);

    const nextLod = lodForAltitude(height);
    if (nextLod === "street") streets.follow(lng, lat);

    const nextDarkness = currentDarkness();
    const lodChanged = nextLod !== lod;
    const darknessChanged = Math.abs(nextDarkness - darkness) > 0.01;
    if (!lodChanged && !darknessChanged) return;
    lod = nextLod;
    darkness = nextDarkness;

    if (lodChanged) streets.setVisible(lod === "street");
    if (darknessChanged) {
      applyWindows();
      applyStars();
    }
    applyBloom();
    streets.setLightsOn(darkness > 0.02);
  };
  view.on("postUpdate", refresh);
  view.atmosphere.on("sunChanged", refresh);

  // --- Panel -----------------------------------------------------------------

  const pane = new Pane({ title: "Night city" });

  const skyFolder = pane.addFolder({ title: "Sky" });
  skyFolder
    .addBinding(timeParams, "hour", { min: 0, max: 24, step: 0.25 })
    .on("change", ({ value }) => setHour(value, hourLng));
  skyFolder
    .addBinding(starsParams, "intensity", { min: 0, max: 2000, step: 10 })
    .on("change", applyStars);

  const bloomFolder = pane.addFolder({ title: "Bloom" });
  bloomFolder
    .addBinding(bloomParams, "intensity", { min: 0, max: 4, step: 0.05 })
    .on("change", applyBloom);
  bloomFolder
    .addBinding(bloomParams, "threshold", { min: 0, max: 1.5, step: 0.01 })
    .on("change", ({ value }) => bloom.update({ bloom: { threshold: value } }));
  bloomFolder
    .addBinding(bloomParams, "radius", { min: 0, max: 1, step: 0.01 })
    .on("change", ({ value }) => bloom.update({ bloom: { radius: value } }));

  const windowsFolder = pane.addFolder({ title: "Windows" });
  windowsFolder
    .addBinding(windowsParams, "litRatio", { min: 0, max: 1, step: 0.01 })
    .on("change", ({ value }) => buildingWindows.update({ litRatio: value }));
  windowsFolder
    .addBinding(windowsParams, "floorHeight", { min: 2.5, max: 6, step: 0.1 })
    .on("change", ({ value }) =>
      buildingWindows.update({ floorHeight: value }),
    );
  windowsFolder
    .addBinding(windowsParams, "columnWidth", { min: 1.5, max: 8, step: 0.1 })
    .on("change", ({ value }) =>
      buildingWindows.update({ columnWidth: value }),
    );
  windowsFolder
    .addBinding(windowsParams, "intensity", { min: 0, max: 5, step: 0.05 })
    .on("change", applyWindows);

  const mapFolder = pane.addFolder({ title: "Map" });
  mapFolder
    .addBinding(mapParams, "brightness", { min: 0, max: 1, step: 0.05 })
    .on("change", ({ value }) =>
      map.update({ raster: { color: mapTint(value) } }),
    );

  const trafficFolder = pane.addFolder({ title: "Traffic" });
  const applyTraffic = () => streets.update({ traffic: trafficParams });
  trafficFolder
    .addBinding(trafficParams, "speed", { min: 0, max: 4, step: 0.05 })
    .on("change", applyTraffic);
  trafficFolder
    .addBinding(trafficParams, "size", { min: 1, max: 6, step: 0.1 })
    .on("change", applyTraffic);
};
