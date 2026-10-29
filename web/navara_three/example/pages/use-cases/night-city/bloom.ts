import type ThreeView from "@navaramap/three";
import {
  Effect,
  EffectDesc,
  type EffectConfig,
  type EffectUpdate,
  type ViewContext,
} from "@navaramap/three";
import { BloomEffect } from "postprocessing";
import type { Camera } from "three";

export type BloomOptions = {
  enabled?: boolean;
  /** Strength of the glow added back onto the scene. */
  intensity?: number;
  /** Luminance below which pixels do not bloom. */
  threshold?: number;
  /** Softness of the threshold. */
  smoothing?: number;
  /** Blur radius, 0–1. */
  radius?: number;
};

const DEFAULTS: Required<Omit<BloomOptions, "enabled">> = {
  intensity: 1.2,
  threshold: 0.5,
  smoothing: 0.2,
  radius: 0.75,
};

class Bloom extends Effect<BloomEffect, BloomOptions> {
  constructor(camera: Camera, options?: BloomOptions) {
    super(
      camera,
      new BloomEffect({
        mipmapBlur: true,
        intensity: options?.intensity ?? DEFAULTS.intensity,
        luminanceThreshold: options?.threshold ?? DEFAULTS.threshold,
        luminanceSmoothing: options?.smoothing ?? DEFAULTS.smoothing,
        radius: options?.radius ?? DEFAULTS.radius,
      }),
      options,
    );
  }

  set intensity(v: number) {
    this.options.intensity = v;
    this.rawEffect.intensity = v;
    this.emit("needsUpdate");
  }

  set threshold(v: number) {
    this.options.threshold = v;
    this.rawEffect.luminanceMaterial.threshold = v;
    this.emit("needsUpdate");
  }

  set smoothing(v: number) {
    this.options.smoothing = v;
    this.rawEffect.luminanceMaterial.smoothing = v;
    this.emit("needsUpdate");
  }

  set radius(v: number) {
    this.options.radius = v;
    this.rawEffect.mipmapBlurPass.radius = v;
    this.emit("needsUpdate");
  }
}

type BloomDescription = {
  bloom?: Omit<BloomOptions, "enabled">;
};

export type BloomEffectConfig = BloomDescription & EffectConfig;

export type BloomEffectUpdate = BloomDescription & EffectUpdate;

export type BloomDescriptions = { effect: BloomEffectConfig };

/**
 * Whole-scene bloom on everything brighter than the threshold: windows, car
 * lights and any other light source, without per-layer opt-in. The built-in
 * `selectiveBloom` reads the emissive G-buffer, which the windows pass and the
 * additive traffic points never write.
 */
export class BloomEffectDesc extends EffectDesc<
  BloomEffectConfig,
  BloomEffectUpdate,
  Bloom
> {
  static key = "bloom";
  static insertAfter = ["transparent"];
  static insertBefore = ["toneMapping", "smaa", "fxaa", "final"];

  private config: BloomEffectConfig;

  constructor(view: ThreeView, ctx: ViewContext, config: BloomEffectConfig) {
    super(view, ctx, config);
    this.config = config;
  }

  createPass() {
    return new Bloom(this.view.camera.raw, {
      ...this.config.bloom,
      enabled: this.config.visible ?? true,
    });
  }

  onUpdateConfig(updates: BloomEffectUpdate): void {
    super.onUpdateConfig(updates);
    if (!this._instance) return;
    Object.assign(this.config, updates);

    const bloom = updates.bloom;
    if (!bloom) return;
    if (bloom.intensity !== undefined)
      this._instance.intensity = bloom.intensity;
    if (bloom.threshold !== undefined)
      this._instance.threshold = bloom.threshold;
    if (bloom.smoothing !== undefined)
      this._instance.smoothing = bloom.smoothing;
    if (bloom.radius !== undefined) this._instance.radius = bloom.radius;
  }
}
