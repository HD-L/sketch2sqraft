/**
 * 几何换算：Sketch 归一化点串 → Sqraft 锚点、圆角、翻转、约束缩放。
 */

import type { CornerRadius, Rect, VectorAnchor, VectorPath } from "@sqraft/core";
import type { SketchCurvePoint, SketchLayer } from "./sketch";

/** "{0.5, 0.25}" → [0.5, 0.25]；解析失败返回 null。 */
export function parsePoint(value: string | undefined): [number, number] | null {
  if (!value) return null;
  const m = /\{\s*([-+\deE.]+)\s*,\s*([-+\deE.]+)\s*\}/.exec(value);
  if (!m) return null;
  const x = Number(m[1]);
  const y = Number(m[2]);
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

/** "{{0, 0}, {1, 1}}" → 归一化矩形；解析失败返回 null。 */
export function parseRectString(value: string | undefined): Rect | null {
  if (!value) return null;
  const nums = value.match(/[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/g)?.map(Number);
  if (!nums || nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) return null;
  return { x: nums[0], y: nums[1], width: nums[2], height: nums[3] };
}

/**
 * Sketch 曲线点 → Sqraft 锚点（节点本地坐标，手柄为相对偏移）。
 *
 * Sketch 语义：`curveTo` 是"进入该点"的控制点、`curveFrom` 是"离开该点"的控制点，
 * 两者都是绝对的归一化坐标；`hasCurveTo/From` 为假时该侧没有手柄。
 */
export function pointsToVector(
  points: readonly SketchCurvePoint[],
  closed: boolean,
  width: number,
  height: number,
  flipH = false,
  flipV = false,
): VectorPath | null {
  const fx = (nx: number): number => (flipH ? 1 - nx : nx) * width;
  const fy = (ny: number): number => (flipV ? 1 - ny : ny) * height;
  const anchors: VectorAnchor[] = [];
  for (const cp of points) {
    const p = parsePoint(cp.point);
    if (!p) continue;
    const x = fx(p[0]);
    const y = fy(p[1]);
    const anchor: VectorAnchor = { x, y, inX: 0, inY: 0, outX: 0, outY: 0 };
    // 旧版本不写 hasCurve*：以控制点是否与锚点重合判断
    const to = parsePoint(cp.curveTo);
    const from = parsePoint(cp.curveFrom);
    if (to && cp.hasCurveTo !== false) {
      anchor.inX = fx(to[0]) - x;
      anchor.inY = fy(to[1]) - y;
    }
    if (from && cp.hasCurveFrom !== false) {
      anchor.outX = fx(from[0]) - x;
      anchor.outY = fy(from[1]) - y;
    }
    // curveMode 1 = 直线点：即使写了控制点也不弯
    if (cp.curveMode === 1) {
      anchor.inX = anchor.inY = anchor.outX = anchor.outY = 0;
    }
    for (const k of ["inX", "inY", "outX", "outY"] as const) {
      if (Math.abs(anchor[k]) < 1e-6) anchor[k] = 0;
    }
    anchors.push(anchor);
  }
  if (anchors.length < 2) return null;
  if (closed && anchors.length < 3) return { closed: false, anchors };
  return { closed, anchors };
}

/**
 * 矩形圆角：新版写在四个点的 `cornerRadius`（顺序：左上、右上、右下、左下），
 * 旧版只有 `fixedRadius`。半径夹到短边一半，与渲染一致。
 */
export function rectCornerRadius(layer: SketchLayer, width: number, height: number): CornerRadius | undefined {
  const max = Math.max(0, Math.min(width, height) / 2);
  const clamp = (r: number | undefined): number => Math.max(0, Math.min(max, r ?? 0));
  const pts = layer.points;
  let radius: CornerRadius;
  if (pts && pts.length === 4 && pts.some((p) => (p.cornerRadius ?? 0) > 0)) {
    radius = {
      topLeft: clamp(pts[0].cornerRadius),
      topRight: clamp(pts[1].cornerRadius),
      bottomRight: clamp(pts[2].cornerRadius),
      bottomLeft: clamp(pts[3].cornerRadius),
    };
  } else if ((layer.fixedRadius ?? 0) > 0) {
    const r = clamp(layer.fixedRadius);
    radius = { topLeft: r, topRight: r, bottomRight: r, bottomLeft: r };
  } else {
    return undefined;
  }
  if (layer.isFlippedHorizontal) {
    radius = { topLeft: radius.topRight, topRight: radius.topLeft, bottomRight: radius.bottomLeft, bottomLeft: radius.bottomRight };
  }
  if (layer.isFlippedVertical) {
    radius = { topLeft: radius.bottomLeft, topRight: radius.bottomRight, bottomRight: radius.topRight, bottomLeft: radius.topLeft };
  }
  return radius;
}

/**
 * Sketch 的旋转：正值逆时针，绕图层框中心；`frame` 是未旋转的框。
 * Sqraft 同样绕中心旋转，但正值顺时针（Canvas 坐标系）。
 */
export function convertRotation(rotation: number | undefined): number {
  const r = -(rotation ?? 0);
  if (!Number.isFinite(r) || Math.abs(r) < 1e-6) return 0;
  // 规范到 (-180, 180]
  let n = r % 360;
  if (n > 180) n -= 360;
  if (n <= -180) n += 360;
  return Number(n.toFixed(4));
}

/** 解码 Sketch 的 resizingConstraint（位为 0 表示固定）。缺省 63 = 无约束（等比缩放）。 */
export interface Constraints {
  left: boolean;
  right: boolean;
  fixedWidth: boolean;
  top: boolean;
  bottom: boolean;
  fixedHeight: boolean;
}

export function decodeConstraints(mask: number | undefined): Constraints {
  const m = typeof mask === "number" ? mask : 63;
  return {
    right: (m & 1) === 0,
    fixedWidth: (m & 2) === 0,
    left: (m & 4) === 0,
    bottom: (m & 8) === 0,
    fixedHeight: (m & 16) === 0,
    top: (m & 32) === 0,
  };
}

function resizeAxis(
  pos: number,
  size: number,
  oldParent: number,
  newParent: number,
  pinStart: boolean,
  pinEnd: boolean,
  fixedSize: boolean,
): [number, number] {
  if (oldParent <= 0) return [pos, size];
  const ratio = newParent / oldParent;
  if (pinStart && pinEnd) return [pos, Math.max(1, size + (newParent - oldParent))];
  if (pinStart) return [pos, fixedSize ? size : Math.max(1, size * ratio)];
  if (pinEnd) {
    const nextSize = fixedSize ? size : Math.max(1, size * ratio);
    const endGap = oldParent - pos - size;
    return [newParent - endGap - nextSize, nextSize];
  }
  if (fixedSize) {
    const center = (pos + size / 2) * ratio;
    return [center - size / 2, size];
  }
  return [pos * ratio, Math.max(1, size * ratio)];
}

/** 按约束把子图层框从旧父尺寸换算到新父尺寸（实例被拉伸时使用）。 */
export function resizeByConstraints(
  rect: Rect,
  constraints: Constraints,
  oldParent: { width: number; height: number },
  newParent: { width: number; height: number },
): Rect {
  const [x, width] = resizeAxis(
    rect.x,
    rect.width,
    oldParent.width,
    newParent.width,
    constraints.left,
    constraints.right,
    constraints.fixedWidth,
  );
  const [y, height] = resizeAxis(
    rect.y,
    rect.height,
    oldParent.height,
    newParent.height,
    constraints.top,
    constraints.bottom,
    constraints.fixedHeight,
  );
  return { x, y, width, height };
}

export function round(n: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
