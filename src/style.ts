/**
 * Sketch 样式 → Sqraft 样式：颜色、填充、描边、效果、不透明度。
 * 纯函数；不支持的部分通过 `warn` 上报，由调用方汇总成报告。
 */

import type { Effect, Paint } from "@sqraft/core";
import type { SketchBorder, SketchColor, SketchFill, SketchShadow, SketchStyle } from "./sketch";

export type Warn = (code: string, detail?: string) => void;

function clamp01(v: unknown, fallback = 1): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return Math.max(0, Math.min(1, n));
}

function hex2(v: number): string {
  return Math.round(clamp01(v, 0) * 255)
    .toString(16)
    .padStart(2, "0");
}

/** Sketch 颜色（0–1 浮点）→ `#rrggbb` / `#rrggbbaa`；alpha 可再乘一个系数。 */
export function colorToHex(color: SketchColor | undefined, alphaScale = 1): string {
  if (!color) return "#000000";
  const alpha = clamp01(color.alpha) * clamp01(alphaScale);
  const rgb = `#${hex2(color.red)}${hex2(color.green)}${hex2(color.blue)}`;
  return alpha >= 0.999 ? rgb : `${rgb}${hex2(alpha)}`;
}

/** 色板 id → Token 路径（转换上下文提供）。 */
export type SwatchLookup = (swatchId: string) => string | undefined;

/** 颜色 → Paint：引用了色板且没有额外透明度时用 Token，否则用字面量。 */
export function colorToPaint(color: SketchColor | undefined, alphaScale: number, swatch: SwatchLookup): Paint {
  if (color?.swatchID && clamp01(alphaScale) >= 0.999) {
    const token = swatch(color.swatchID);
    if (token) return { token };
  }
  return { value: colorToHex(color, alphaScale) };
}

function fillOpacity(fill: SketchFill): number {
  return clamp01(fill.contextSettings?.opacity);
}

export function enabledFills(style: SketchStyle | undefined): SketchFill[] {
  return (style?.fills ?? []).filter((f) => f.isEnabled !== false);
}

/** 图案填充（图片）：Sqraft 用图片节点承载，这里只负责把它挑出来。 */
export function patternFill(style: SketchStyle | undefined): SketchFill | undefined {
  return enabledFills(style)
    .filter((f) => f.fillType === 4 && f.image?._ref)
    .at(-1);
}

/**
 * Sqraft 一个节点只有一份填充：取最上层（数组末尾）的可用填充。
 * 渐变退化为首个色标，图案填充交给图片节点，噪点忽略。
 */
export function convertFill(style: SketchStyle | undefined, swatch: SwatchLookup, warn: Warn): Paint | null {
  const fills = enabledFills(style).filter((f) => f.fillType !== 4 && f.fillType !== 5);
  if (fills.length === 0) return null;
  if (fills.length > 1) warn("fill.multiple");
  const top = fills[fills.length - 1];
  if (top.fillType === 1) {
    warn("fill.gradient");
    const stops = [...(top.gradient?.stops ?? [])].sort((a, b) => a.position - b.position);
    if (stops.length === 0) return null;
    return { value: colorToHex(stops[0].color, fillOpacity(top)) };
  }
  return colorToPaint(top.color, fillOpacity(top), swatch);
}

export interface StrokeResult {
  stroke: Paint;
  strokeWidth: number;
}

export function convertBorder(style: SketchStyle | undefined, swatch: SwatchLookup, warn: Warn): StrokeResult | null {
  const borders = (style?.borders ?? []).filter((b: SketchBorder) => b.isEnabled !== false && (b.thickness ?? 1) > 0);
  if (borders.length === 0) return null;
  if (borders.length > 1) warn("border.multiple");
  const top = borders[borders.length - 1];
  if (top.position !== undefined && top.position !== 0) warn("border.position");
  let paint: Paint;
  if (top.fillType === 1) {
    warn("fill.gradient");
    const stop = top.gradient?.stops?.[0];
    paint = { value: colorToHex(stop?.color, fillOpacity(top)) };
  } else {
    paint = colorToPaint(top.color, fillOpacity(top), swatch);
  }
  return { stroke: paint, strokeWidth: top.thickness ?? 1 };
}

function shadowEffect(type: "drop-shadow" | "inner-shadow", s: SketchShadow, swatch: SwatchLookup): Effect {
  return {
    type,
    visible: true,
    x: s.offsetX ?? 0,
    y: s.offsetY ?? 0,
    blur: Math.max(0, s.blurRadius ?? 0),
    spread: s.spread ?? 0,
    color: colorToPaint(s.color, 1, swatch),
  };
}

export function convertEffects(style: SketchStyle | undefined, swatch: SwatchLookup, warn: Warn): Effect[] | undefined {
  const out: Effect[] = [];
  for (const s of style?.shadows ?? []) {
    if (s.isEnabled === false) continue;
    out.push(shadowEffect("drop-shadow", s, swatch));
  }
  for (const s of style?.innerShadows ?? []) {
    if (s.isEnabled === false) continue;
    out.push(shadowEffect("inner-shadow", s, swatch));
  }
  const blur = style?.blur;
  if (blur && blur.isEnabled && (blur.radius ?? 0) > 0) {
    if (blur.type === 3) out.push({ type: "backdrop-blur", visible: true, radius: blur.radius ?? 0 });
    else {
      if (blur.type === 1 || blur.type === 2) warn("blur.kind");
      out.push({ type: "layer-blur", visible: true, radius: blur.radius ?? 0 });
    }
  }
  return out.length ? out : undefined;
}

export function layerOpacity(style: SketchStyle | undefined): number {
  return clamp01(style?.contextSettings?.opacity);
}
