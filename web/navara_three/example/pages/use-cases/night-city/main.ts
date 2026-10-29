import ThreeView from "@navaramap/three";

import { run, type NightDescriptions } from "./run";

// `useNormal` gives the globe surface normals, so the sun lights the map
// itself: dark at night, bright by day. Traffic is animated, so render
// every frame.
const view = new ThreeView<NightDescriptions>({
  useNormal: true,
  animation: true,
});
run(view);
