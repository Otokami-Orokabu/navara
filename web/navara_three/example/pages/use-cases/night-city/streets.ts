import { VectorTile, type VectorTileLayer } from "@mapbox/vector-tile";
import type ThreeView from "@navaramap/three";
import {
  Color,
  Plugin,
  geodeticToVector3,
  type FeatureEvaluator,
  type Layer,
  type MeshHandle,
  type Source,
  type ViewContext,
} from "@navaramap/three";
import type {
  Feature,
  FeatureCollection,
  LineString,
  MultiLineString,
  MultiPolygon,
  Point,
  Polygon,
  Position,
} from "geojson";
import { PbfReader } from "pbf";
import { MathUtils, type Vector3 } from "three";

import {
  StreetTrafficMeshDesc,
  type StreetTrafficData,
  type StreetTrafficDescriptions,
  type StreetTrafficOptions,
} from "./streetTraffic";

// --- OpenMapTiles road tiles -----------------------------------------------

type Road = {
  /** OpenMapTiles `transportation` class. */
  roadClass: string;
  /** 1 forward only, -1 backward only, 0 both ways. */
  oneway: number;
  /** Centerline as [lng, lat] positions. */
  line: Position[];
};

type TallBuilding = {
  lng: number;
  lat: number;
  height: number;
};

type RoadNetwork = {
  roads: Road[];
  tallBuildings: TallBuilding[];
};

type TileCoordinate = { x: number; y: number };

const ZOOM = 14;

// Road classes that carry lights and traffic; rail, paths, ferries etc. do not.
const ROAD_CLASSES = new Set([
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "tertiary",
  "minor",
  "service",
]);

// Buildings at least this tall get a beacon. High enough that skyscraper
// districts do not turn into a red mass.
const TALL_BUILDING_HEIGHT = 90;

const METERS_PER_DEGREE = 111320;

/** The zoom-14 tile containing a position. */
const tileCoordinate = (lng: number, lat: number): TileCoordinate => {
  const rad = (lat * Math.PI) / 180;
  const n = 2 ** ZOOM;
  return {
    x: Math.floor(((lng + 180) / 360) * n),
    y: Math.floor(
      ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n,
    ),
  };
};

const tileCenter = (tile: TileCoordinate): { lng: number; lat: number } => {
  const n = 2 ** ZOOM;
  const lng = ((tile.x + 0.5) / n) * 360 - 180;
  const lat =
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * (tile.y + 0.5)) / n))) * 180) /
    Math.PI;
  return { lng, lat };
};

const tileKey = (tile: TileCoordinate) => `${tile.x}/${tile.y}`;

const lineStrings = (geometry: LineString | MultiLineString): Position[][] =>
  geometry.type === "LineString"
    ? [geometry.coordinates]
    : geometry.coordinates;

const outerRings = (geometry: Polygon | MultiPolygon): Position[][] =>
  geometry.type === "Polygon"
    ? [geometry.coordinates[0]]
    : geometry.coordinates.map((polygon) => polygon[0]);

const readRoads = (
  layer: VectorTileLayer,
  tile: TileCoordinate,
  out: Road[],
) => {
  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i);
    const roadClass = feature.properties.class;
    if (typeof roadClass !== "string" || !ROAD_CLASSES.has(roadClass)) continue;

    const geometry = feature.toGeoJSON(tile.x, tile.y, ZOOM).geometry;
    if (geometry.type !== "LineString" && geometry.type !== "MultiLineString")
      continue;
    const oneway = feature.properties.oneway;
    for (const line of lineStrings(geometry)) {
      out.push({
        roadClass,
        oneway: typeof oneway === "number" ? oneway : 0,
        line,
      });
    }
  }
};

/** Roof center of every tall building, one per outer ring. */
const readTallBuildings = (
  layer: VectorTileLayer,
  tile: TileCoordinate,
  out: TallBuilding[],
) => {
  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i);
    const height = feature.properties.render_height;
    if (typeof height !== "number" || height < TALL_BUILDING_HEIGHT) continue;

    const geometry = feature.toGeoJSON(tile.x, tile.y, ZOOM).geometry;
    if (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon")
      continue;
    for (const ring of outerRings(geometry)) {
      let lng = 0;
      let lat = 0;
      for (const [x, y] of ring) {
        lng += x;
        lat += y;
      }
      out.push({ lng: lng / ring.length, lat: lat / ring.length, height });
    }
  }
};

/** Reads roads and tall buildings from OpenMapTiles-schema tiles, one at a time. */
class TileLoader {
  private readonly template: string;

  /** `template` is a `{z}/{x}/{y}` tile URL, as listed in a TileJSON document. */
  constructor(template: string) {
    this.template = template;
  }

  async load(tile: TileCoordinate): Promise<RoadNetwork> {
    const url = this.template
      .replace("{z}", String(ZOOM))
      .replace("{x}", String(tile.x))
      .replace("{y}", String(tile.y));
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Tile ${url} failed (${res.status})`);
    const vectorTile = new VectorTile(new PbfReader(await res.arrayBuffer()));

    const roads: Road[] = [];
    const tallBuildings: TallBuilding[] = [];
    const transportation = vectorTile.layers.transportation;
    if (transportation) readRoads(transportation, tile, roads);
    const building = vectorTile.layers.building;
    if (building) readTallBuildings(building, tile, tallBuildings);
    return { roads, tallBuildings };
  }
}

// --- Tile streaming --------------------------------------------------------

type TileStreamer<T> = {
  /** Loaded tiles by key. */
  readonly tiles: ReadonlyMap<string, { tile: TileCoordinate; loaded: T }>;
  /** Re-centers on a position; loads tiles that came into range, drops the rest. */
  update(lng: number, lat: number): void;
};

const chebyshev = (a: TileCoordinate, b: TileCoordinate) =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

/**
 * Keeps the tiles within `radius` of a center tile loaded, through `add`
 * (async) and `remove`. Nothing happens while the center tile is unchanged.
 */
const createTileStreamer = <T>(
  radius: number,
  add: (tile: TileCoordinate) => Promise<T>,
  remove: (loaded: T) => void,
): TileStreamer<T> => {
  const tiles = new Map<string, { tile: TileCoordinate; loaded: T }>();
  const pending = new Set<string>();
  let center: TileCoordinate | undefined;

  const update = (lng: number, lat: number) => {
    const next = tileCoordinate(lng, lat);
    if (center && center.x === next.x && center.y === next.y) return;
    center = next;

    for (const [key, entry] of tiles) {
      if (chebyshev(entry.tile, next) > radius) {
        remove(entry.loaded);
        tiles.delete(key);
      }
    }

    // Nearest first, so the view fills in from the camera outward.
    const wanted: TileCoordinate[] = [];
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        wanted.push({ x: next.x + dx, y: next.y + dy });
      }
    }
    wanted.sort((a, b) => chebyshev(a, next) - chebyshev(b, next));

    for (const tile of wanted) {
      const key = tileKey(tile);
      if (tiles.has(key) || pending.has(key)) continue;
      pending.add(key);
      add(tile).then(
        (loaded) => {
          pending.delete(key);
          // The camera may have moved on while this tile was loading.
          if (!center || chebyshev(tile, center) > radius) {
            remove(loaded);
            return;
          }
          tiles.set(key, { tile, loaded });
        },
        (error: unknown) => {
          pending.delete(key);
          console.error(error);
        },
      );
    }
  };

  return { tiles, update };
};

// --- Street lamps and roof beacons -----------------------------------------

type LightKind = "lamp" | "warm" | "beacon";

type LightProperties = {
  kind: LightKind;
  /** Meters above the ellipsoid; 0 for lights on the ground. */
  height: number;
};

// Street lamp spacing along the road and distance from the centerline, per
// OpenMapTiles road class, in meters.
const STREET_LAMPS: Record<string, { spacing: number; offset: number }> = {
  motorway: { spacing: 30, offset: 9 },
  trunk: { spacing: 30, offset: 7 },
  primary: { spacing: 35, offset: 7 },
  secondary: { spacing: 40, offset: 6 },
  tertiary: { spacing: 45, offset: 5 },
  minor: { spacing: 60, offset: 4 },
  service: { spacing: 90, offset: 3 },
};

const light = (
  lng: number,
  lat: number,
  properties: LightProperties,
): Feature<Point, LightProperties> => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [lng, lat] },
  properties,
});

/** Lamps spaced along one road centerline, alternating sides. */
const lampsAlongLine = (
  line: Position[],
  spacing: number,
  offset: number,
  rand: () => number,
  out: Feature<Point, LightProperties>[],
) => {
  let carry = spacing * rand();
  let side = rand() < 0.5 ? -1 : 1;
  for (let i = 1; i < line.length; i++) {
    const [lng0, lat0] = line[i - 1];
    const [lng1, lat1] = line[i];
    const metersPerDegreeLng =
      METERS_PER_DEGREE * Math.cos((lat0 * Math.PI) / 180);
    const dx = (lng1 - lng0) * metersPerDegreeLng;
    const dy = (lat1 - lat0) * METERS_PER_DEGREE;
    const length = Math.hypot(dx, dy);
    if (length === 0) continue;
    // Unit direction and its left-hand normal, in meters.
    const ux = dx / length;
    const uy = dy / length;
    const nx = -uy;
    const ny = ux;

    let t = carry;
    while (t < length) {
      const lng = lng0 + (ux * t + nx * offset * side) / metersPerDegreeLng;
      const lat = lat0 + (uy * t + ny * offset * side) / METERS_PER_DEGREE;
      out.push(
        light(lng, lat, { kind: rand() < 0.75 ? "lamp" : "warm", height: 0 }),
      );
      side = -side;
      t += spacing;
    }
    carry = t - length;
  }
};

/** Street lamps along every road and a red beacon on every tall roof. */
const roadLights = (
  network: RoadNetwork,
): FeatureCollection<Point, LightProperties> => {
  // Seeded per tile so a tile looks the same each time it streams in; the
  // generator is shared, but this runs to completion before anything else
  // touches it.
  MathUtils.seededRandom(7);
  const rand = () => MathUtils.seededRandom();
  const features: Feature<Point, LightProperties>[] = [];

  for (const road of network.roads) {
    const style = STREET_LAMPS[road.roadClass];
    if (style)
      lampsAlongLine(road.line, style.spacing, style.offset, rand, features);
  }
  for (const building of network.tallBuildings) {
    features.push(
      light(building.lng, building.lat, {
        kind: "beacon",
        height: building.height + 2,
      }),
    );
  }

  return { type: "FeatureCollection", features };
};

// --- Traffic placement -----------------------------------------------------

// Cars per direction: one every `spacing` meters, driving `lane` meters left
// of the centerline (left-hand traffic) at about `speed` m/s.
const TRAFFIC: Record<
  string,
  { spacing: number; lane: number; speed: number }
> = {
  motorway: { spacing: 25, lane: 6, speed: 22 },
  trunk: { spacing: 30, lane: 4.5, speed: 14 },
  primary: { spacing: 35, lane: 4.5, speed: 12 },
  secondary: { spacing: 50, lane: 3.5, speed: 11 },
  tertiary: { spacing: 70, lane: 3, speed: 9 },
  minor: { spacing: 120, lane: 2.5, speed: 7 },
  service: { spacing: 250, lane: 1.5, speed: 5 },
};

const CAR_HEIGHT = 0.6;

/** Scatters cars over the road segments; each car drives one segment and wraps. */
const buildTraffic = (roads: Road[], origin: Vector3): StreetTrafficData => {
  // Seeded per tile, like `roadLights`.
  MathUtils.seededRandom(11);
  const rand = () => MathUtils.seededRandom();
  const start: number[] = [];
  const end: number[] = [];
  const phase: number[] = [];
  const speed: number[] = [];

  const push = (target: number[], lng: number, lat: number) => {
    const p = geodeticToVector3({ lat, lng, height: CAR_HEIGHT }).sub(origin);
    target.push(p.x, p.y, p.z);
  };

  for (const road of roads) {
    const style = TRAFFIC[road.roadClass];
    if (!style) continue;

    for (let i = 1; i < road.line.length; i++) {
      const [lng0, lat0] = road.line[i - 1];
      const [lng1, lat1] = road.line[i];
      const metersPerDegreeLng =
        METERS_PER_DEGREE * Math.cos((lat0 * Math.PI) / 180);
      const dx = (lng1 - lng0) * metersPerDegreeLng;
      const dy = (lat1 - lat0) * METERS_PER_DEGREE;
      const length = Math.hypot(dx, dy);
      if (length < 1) continue;
      // Left-hand normal of the forward direction, in meters.
      const nx = -dy / length;
      const ny = dx / length;

      for (const direction of [1, -1]) {
        if (road.oneway === -direction) continue;
        // Expected car count, with the fraction decided by chance.
        const expected = length / style.spacing;
        const count = Math.floor(expected) + (rand() < expected % 1 ? 1 : 0);
        // Left of the direction of travel.
        const ox = nx * style.lane * direction;
        const oy = ny * style.lane * direction;
        const aLng = lng0 + ox / metersPerDegreeLng;
        const aLat = lat0 + oy / METERS_PER_DEGREE;
        const bLng = lng1 + ox / metersPerDegreeLng;
        const bLat = lat1 + oy / METERS_PER_DEGREE;

        for (let k = 0; k < count; k++) {
          if (direction === 1) {
            push(start, aLng, aLat);
            push(end, bLng, bLat);
          } else {
            push(start, bLng, bLat);
            push(end, aLng, aLat);
          }
          phase.push(rand());
          speed.push(style.speed * (0.7 + 0.6 * rand()));
        }
      }
    }
  }

  return {
    start: new Float32Array(start),
    end: new Float32Array(end),
    phase: new Float32Array(phase),
    speed: new Float32Array(speed),
  };
};

// --- Layers ----------------------------------------------------------------

const LIGHT_COLORS = {
  lamp: new Color().setStyle("#fff6e0"),
  warm: new Color().setStyle("#ffb347"),
  beacon: new Color().setStyle("#ff2a1a"),
};

// Widths in pixels per OpenMapTiles road class; other classes (rail, path,
// ferry, ...) and classes missing from a map stay hidden.
const SURFACE_WIDTH: Record<string, number> = {
  motorway: 6,
  trunk: 5,
  primary: 4.5,
  secondary: 4,
  tertiary: 3.5,
  minor: 2.5,
  service: 1.5,
};

/**
 * Evaluated values win over the material, so `show` cannot be toggled on a
 * layer: the evaluators read these flags instead, and `forceUpdate()` re-runs
 * them. `visible` is the street-level detail as a whole; `lightsOn` the
 * lamps, beacons and traffic within it.
 */
type Flags = { visible: boolean; lightsOn: boolean };

const lampEvaluator =
  (flags: Flags) =>
  ({ evaluator }: { evaluator: FeatureEvaluator }) => {
    evaluator.evaluate(
      ({ properties }) => {
        if (!flags.visible || !flags.lightsOn) return { show: false };
        switch (properties?.kind) {
          case "lamp":
            return { show: true, color: LIGHT_COLORS.lamp, size: 3 };
          case "warm":
            return { show: true, color: LIGHT_COLORS.warm, size: 2.5 };
        }
        return { show: false };
      },
      { filters: ["kind"] },
    );
  };

const beaconEvaluator =
  (flags: Flags) =>
  ({ evaluator }: { evaluator: FeatureEvaluator }) => {
    evaluator.evaluate(
      ({ properties }) => {
        if (
          !flags.visible ||
          !flags.lightsOn ||
          properties?.kind !== "beacon"
        ) {
          return { show: false };
        }
        const height = properties.height;
        return { show: true, height: typeof height === "number" ? height : 0 };
      },
      { filters: ["kind", "height"] },
    );
  };

const surfaceEvaluator =
  (flags: Flags) =>
  ({ evaluator }: { evaluator: FeatureEvaluator }) => {
    evaluator.evaluate(
      ({ properties }) => {
        if (!flags.visible) return { show: false };
        const roadClass = properties?.class;
        const width =
          typeof roadClass === "string" ? SURFACE_WIDTH[roadClass] : undefined;
        if (width === undefined) return { show: false };

        return { show: true, width };
      },
      { filters: ["class"] },
    );
  };

/** Everything one tile adds to the view. */
type StreetTile = {
  source: Source;
  lamps: Layer;
  beacons: Layer;
  traffic: MeshHandle<StreetTrafficMeshDesc>;
};

const removeTile = (lights: StreetTile) => {
  lights.lamps.delete();
  lights.beacons.delete();
  lights.source.delete();
  lights.traffic.delete();
};

// --- Plugin ----------------------------------------------------------------

export type StreetsOptions = {
  /**
   * Tiles of lights kept loaded around the camera, as a radius in zoom-14
   * tiles (2 = a 5 × 5 block, about 10 km across at Tokyo's latitude).
   */
  radius?: number;
  traffic?: StreetTrafficOptions;
};

/**
 * Street-level detail: dark road surfaces over a vector source, plus street
 * lamps, roof beacons and traffic generated from OpenMapTiles-schema tiles
 * that stream in around the camera. Add before `view.init()`.
 *
 * ```ts
 * const streets = new StreetsPlugin({ radius: 2 });
 * view.addPlugin(streets);
 * await view.init();
 * streets.addRoads(openfreemap);
 * streets.start(tileTemplate);
 * streets.follow(lng, lat); // as the camera moves
 * ```
 */
export class StreetsPlugin extends Plugin<
  ThreeView<StreetTrafficDescriptions>,
  ViewContext
> {
  private view?: ThreeView<StreetTrafficDescriptions>;
  private streamer?: TileStreamer<StreetTile>;
  private surface?: Layer;
  private readonly radius: number;
  private readonly traffic: StreetTrafficOptions;
  private readonly flags: Flags = { visible: true, lightsOn: true };

  constructor({ radius = 2, traffic = {} }: StreetsOptions = {}) {
    super();
    this.radius = radius;
    this.traffic = { ...traffic };
  }

  async init(view: ThreeView<StreetTrafficDescriptions>): Promise<void> {
    this.view = view;
    view.registerMesh(StreetTrafficMeshDesc.key, StreetTrafficMeshDesc);
  }

  private get ready(): ThreeView<StreetTrafficDescriptions> {
    if (!this.view) {
      throw new Error(
        "StreetsPlugin: call view.addPlugin() and view.init() first.",
      );
    }
    return this.view;
  }

  /** Dark road surfaces over the OpenMapTiles `transportation` layer. */
  addRoads(source: Source): Layer {
    const surface = this.ready.addLayer({
      type: "vector",
      source,
      sourceLayers: ["transportation"],
      polyline: {
        color: new Color().setStyle("#15171c"),
        width: 1,
        clampToGround: true,
      },
    });
    const apply = surfaceEvaluator(this.flags);
    surface.on("featureCreated", apply);
    surface.on("featureUpdated", apply);
    this.surface = surface;
    return surface;
  }

  /**
   * Starts streaming lamps, beacons and traffic from `{z}/{x}/{y}` tiles
   * (OpenMapTiles schema, as listed in a TileJSON document); `follow()` then
   * decides which tiles are loaded.
   */
  start(tileTemplate: string): void {
    const loader = new TileLoader(tileTemplate);
    this.streamer = createTileStreamer<StreetTile>(
      this.radius,
      async (tile) => this.addTile(tile, await loader.load(tile)),
      removeTile,
    );
  }

  /** Keeps the tiles around a position loaded; call as the camera moves. */
  follow(lng: number, lat: number): void {
    if (!this.streamer) {
      throw new Error("StreetsPlugin: call start() first.");
    }
    this.streamer.update(lng, lat);
  }

  /** Street-level detail on or off: road surfaces, lamps, beacons, traffic. */
  setVisible(visible: boolean): void {
    if (this.flags.visible === visible) return;
    this.flags.visible = visible;
    this.surface?.forceUpdate();
    this.refreshTiles();
  }

  /** Lamps, beacons and traffic on or off; the road surfaces stay. */
  setLightsOn(on: boolean): void {
    if (this.flags.lightsOn === on) return;
    this.flags.lightsOn = on;
    this.refreshTiles();
  }

  update({ traffic }: { traffic?: StreetTrafficOptions }): void {
    Object.assign(this.traffic, traffic);
    for (const { loaded } of this.loadedTiles()) {
      loaded.traffic.update({ streetTraffic: { ...this.traffic } });
    }
  }

  private loadedTiles() {
    return this.streamer?.tiles.values() ?? [];
  }

  private refreshTiles(): void {
    const lightsVisible = this.flags.visible && this.flags.lightsOn;
    for (const { loaded } of this.loadedTiles()) {
      loaded.lamps.forceUpdate();
      loaded.beacons.forceUpdate();
      loaded.traffic.update({ visible: lightsVisible });
    }
  }

  /** Street lamps, roof beacons and traffic for one tile's road network. */
  private addTile(tile: TileCoordinate, network: RoadNetwork): StreetTile {
    const view = this.ready;
    const source = view.addSource({
      type: "geojson",
      data: roadLights(network),
    });

    // Sized in meters so the far field thins out with distance instead of
    // piling fixed-size sprites into a sheet.
    const lamps = view.addLayer({
      type: "vector",
      source,
      point: {
        size: 3,
        sizeInMeters: true,
        pointFacing: "upright",
        clampToGround: true,
        height: 0,
        declutter: false,
        color: LIGHT_COLORS.lamp,
      },
    });
    const applyLamp = lampEvaluator(this.flags);
    lamps.on("featureCreated", applyLamp);
    lamps.on("featureUpdated", applyLamp);

    const beacons = view.addLayer({
      type: "vector",
      source,
      point: {
        size: 2,
        sizeInMeters: true,
        pointFacing: "upright",
        clampToGround: false,
        height: 0,
        declutter: false,
        color: LIGHT_COLORS.beacon,
      },
    });
    const applyBeacon = beaconEvaluator(this.flags);
    beacons.on("featureCreated", applyBeacon);
    beacons.on("featureUpdated", applyBeacon);

    // Car positions are stored relative to the tile center to keep float32
    // precise.
    const center = tileCenter(tile);
    const origin = geodeticToVector3({
      lat: center.lat,
      lng: center.lng,
      height: 0,
    });
    const traffic = view.addMesh<StreetTrafficMeshDesc>({
      streetTraffic: {
        data: buildTraffic(network.roads, origin),
        ...this.traffic,
      },
      position: { x: origin.x, y: origin.y, z: origin.z },
      visible: this.flags.visible && this.flags.lightsOn,
    });

    return { source, lamps, beacons, traffic };
  }
}
