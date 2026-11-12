/**
 * Sketch → Sqraft 主转换。
 *
 * 分两段：
 * 1. **建中间树**（纯同步）：Sketch 图层 → `IrNode`（Sqraft 节点 + 子树 + 待物化的实例）；
 * 2. **回放命令**：在一个空 `DocStore` 上按"Token → 主组件（依赖拓扑序）→ 页面"的顺序
 *    `apply` 命令。实例物化、覆盖记录、组件同步都交给 core 的命令层，
 *    产物与 GUI / AI 编辑出来的文档走同一套不变量。
 *
 * 映射规则见 packages/sketch-import/README.md。
 */

import {
  DocStore,
  PAGE_GAP,
  createEmptyDoc,
  createNode,
  type DocNode,
  type DocState,
  type ImageRef,
  type NodeId,
  type NodeStyle,
  type NodeType,
  type Rect,
} from "@sqraft/core";
import {
  convertRotation,
  decodeConstraints,
  parseRectString,
  pointsToVector,
  rectCornerRadius,
  resizeByConstraints,
  round,
} from "./geometry";
import { assetIdFor, sniffImage } from "./image";
import type {
  SketchArchive,
  SketchDocument,
  SketchLayer,
  SketchOverrideValue,
  SketchPage,
  SketchStyle,
} from "./sketch";
import { colorToHex, convertBorder, convertEffects, convertFill, layerOpacity, patternFill, type Warn } from "./style";
import { convertText } from "./text";

export interface AssetEntry {
  /** zip 内路径，形如 `assets/<id>.png` */
  name: string;
  bytes: Uint8Array;
}

export interface WarningSummary {
  code: string;
  message: string;
  count: number;
  /** 最多 5 个出问题的图层名 */
  examples: string[];
}

export interface ConvertReport {
  pages: number;
  components: number;
  instances: number;
  nodes: number;
  images: number;
  tokens: number;
  warnings: WarningSummary[];
}

/** 页面分组：一个 Sketch 页面一组，按 Sketch 里的页面顺序；组内按画板顺序。写进 manifest.json，看稿时按组浏览。 */
export interface PageSection {
  name: string;
  pageIds: string[];
}

export interface ConvertResult {
  state: DocState;
  assets: AssetEntry[];
  report: ConvertReport;
  sections: PageSection[];
}

export interface ConvertOptions {
  /** 只转换这些 Sketch 页面（按名称）；缺省全部 */
  pages?: string[];
  /** 是否把共享色板转成颜色 Token；缺省 true */
  swatchTokens?: boolean;
  /** 进度回调：同步调用，回调里不要做耗时操作 */
  onProgress?: (event: ProgressEvent) => void;
}

/** 转换阶段，按发生顺序。`unzip` / `downscale` / `pack` 只由 `sketchToSqraft` 发出。 */
export type ProgressStage =
  | "unzip"
  | "read"
  | "images"
  | "layers"
  | "tokens"
  | "components"
  | "pages"
  | "finish"
  | "downscale"
  | "pack";

export type ProgressEvent =
  /** 进入某个阶段；`total` 是该阶段要处理的条目数（如有） */
  | { kind: "stage"; stage: ProgressStage; total?: number }
  /** 读到一个 Sketch 页面；`mastersOnly` = 未被 --page 选中、只取其中的组件母版 */
  | { kind: "sketchPage"; name: string; artboards: number; masters: number; layers: number; mastersOnly: boolean }
  /** 由共享色板建了一个颜色 Token */
  | { kind: "token"; path: string; value: string; swatch: string }
  /**
   * 处理完一个条目（`index` 从 1 开始）。`group` 是它所在的 Sketch 页面（外部库组件为「外部库」），
   * `nodes` 是它在 Sqraft 里生成的节点数（组件 / 页面才有）。
   */
  | {
      kind: "item";
      stage: "images" | "components" | "pages" | "downscale";
      index: number;
      total: number;
      name: string;
      group?: string;
      nodes?: number;
    };

/** 警告码 → 说明（CLI 与报告共用）。 */
export const WARNING_MESSAGES: Record<string, string> = {
  "fill.multiple": "多层填充只保留最上层",
  "fill.gradient": "渐变不支持，已取首个色标的纯色",
  "fill.pattern": "非矩形的图片填充已转为「蒙版 + 图片」",
  "border.multiple": "多层描边只保留最上层",
  "border.position": "内/外描边已按居中描边处理",
  "blur.kind": "运动/缩放模糊已按图层模糊处理",
  "text.mixed": "富文本混排已降级为单一样式（取占比最大的一段）",
  "flip.unsupported": "该类型图层的翻转不支持，已忽略",
  "boolean.approx": "布尔运算（减/交/差）不支持，已按并集处理",
  "mask.unsupported": "分组/图片/文本蒙版不支持，已按普通图层绘制（不裁切）",
  "image.missing": "图片资源缺失",
  "image.unsupported": "图片格式不支持（如 PDF），已保留占位",
  "symbol.missing": "找不到实例引用的组件，已转为空画板",
  "override.unresolved": "实例覆盖找不到目标图层，已跳过",
  "override.unsupported": "该类实例覆盖（共享样式等）不支持，已跳过",
  "layer.unsupported": "不支持的图层类型，已跳过",
  "layer.loose": "页面上画板之外的图层已收进一个新页面",
  "command.failed": "命令执行失败，已跳过该图层",
};

/** Sqraft 蒙版只认几何形状的轮廓 */
const MASK_SHAPES = new Set<NodeType>(["rect", "ellipse", "polygon", "path"]);
const SKIPPED_CLASSES = new Set(["slice", "MSImmutableHotspotLayer", "hotspot", "MSHotspotLayer"]);
const PAGE_STACK_GAP = PAGE_GAP * 4;

/** 中间树：已转换的 Sqraft 节点 + 子节点；实例只留壳，物化交给命令层。 */
interface IrNode {
  node: DocNode;
  children: IrNode[];
  instance?: {
    componentId: NodeId;
    overrides: SketchOverrideValue[];
  };
}

interface ImageAsset {
  id: string;
  name: string;
  width: number;
  height: number;
}

class Context {
  readonly warnings = new Map<string, WarningSummary>();
  readonly assets = new Map<string, AssetEntry>();
  /** `images/xxx.png` → 资源；null = 缺失或格式不支持 */
  readonly images = new Map<string, ImageAsset | null>();
  readonly tokens = new Map<string, { path: string; value: string; swatch: string }>();
  /** Sketch 图层 id → Sqraft 节点 id（首个分配） */
  readonly idMap = new Map<string, NodeId>();
  /** Sketch symbolID → 主组件节点 id */
  readonly symbols = new Map<string, NodeId>();
  /** Sqraft 节点 id → Sketch resizingConstraint（实例拉伸时用） */
  readonly constraints = new Map<NodeId, number>();
  readonly locked = new Set<NodeId>();
  private readonly usedIds = new Set<NodeId>();
  private currentLayer = "";

  warn: Warn = (code, detail) => {
    let entry = this.warnings.get(code);
    if (!entry) {
      entry = { code, message: WARNING_MESSAGES[code] ?? code, count: 0, examples: [] };
      this.warnings.set(code, entry);
    }
    entry.count += 1;
    const example = detail ?? this.currentLayer;
    if (example && entry.examples.length < 5 && !entry.examples.includes(example)) entry.examples.push(example);
  };

  at(layer: SketchLayer): void {
    this.currentLayer = layer.name ?? layer._class;
  }

  /** 分配节点 id：沿用 Sketch 的 objectID（便于对照），冲突时加后缀。`:` 留给实例派生 id。 */
  allocId(sketchId: string | undefined, suffix = ""): NodeId {
    const base = `${(sketchId || "node").replace(/:/g, "_")}${suffix}`;
    let id = base;
    let n = 1;
    while (this.usedIds.has(id)) id = `${base}~${n++}`;
    this.usedIds.add(id);
    if (sketchId && !suffix && !this.idMap.has(sketchId)) this.idMap.set(sketchId, id);
    return id;
  }

  swatch = (swatchId: string): string | undefined => this.tokens.get(swatchId)?.path;

  image(ref: string | undefined): ImageAsset | null {
    if (!ref) return null;
    const hit = this.images.get(ref);
    if (hit === undefined) return null;
    return hit;
  }
}

function readJson<T>(archive: SketchArchive, name: string): T | null {
  const bytes = archive[name];
  if (!bytes) return null;
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

function frameOf(layer: SketchLayer): Rect {
  const f = layer.frame;
  return {
    x: round(f?.x ?? 0),
    y: round(f?.y ?? 0),
    width: round(Math.max(0, f?.width ?? 0)),
    height: round(Math.max(0, f?.height ?? 0)),
  };
}

// ───────────────────────── 预处理：图片与色板 ─────────────────────────

/** 遍历任意 JSON，收集所有 `images/...` 引用（位图、图案填充、实例图片覆盖）。 */
function collectImageRefs(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) collectImageRefs(v, out);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [k, v] of Object.entries(value)) {
    if (k === "_ref" && typeof v === "string" && v.startsWith("images/")) out.add(v);
    else if (typeof v === "object") collectImageRefs(v, out);
  }
}

async function loadImages(
  ctx: Context,
  archive: SketchArchive,
  roots: unknown[],
  progress: (event: ProgressEvent) => void,
): Promise<void> {
  const refs = new Set<string>();
  for (const r of roots) collectImageRefs(r, refs);
  progress({ kind: "stage", stage: "images", total: refs.size });
  let index = 0;
  for (const ref of refs) {
    progress({ kind: "item", stage: "images", index: ++index, total: refs.size, name: ref });
    // 新版引用带扩展名，旧版常省略
    const bytes = archive[ref] ?? archive[`${ref}.png`] ?? archive[`${ref}.jpg`] ?? archive[`${ref}.pdf`];
    if (!bytes) {
      ctx.images.set(ref, null);
      ctx.warn("image.missing", ref);
      continue;
    }
    const info = sniffImage(bytes);
    if (!info) {
      ctx.images.set(ref, null);
      ctx.warn("image.unsupported", ref);
      continue;
    }
    const id = await assetIdFor(bytes);
    const name = `assets/${id}.${info.ext}`;
    if (!ctx.assets.has(name)) ctx.assets.set(name, { name, bytes });
    ctx.images.set(ref, { id, name, width: info.width, height: info.height });
  }
}

/** 色板名 → Token 路径：去掉空白、补足至少两段（`color/<name>`），重名加序号。 */
export function swatchTokenPath(name: string | undefined, used: Set<string>): string {
  const segments = (name ?? "")
    .split("/")
    .map((s) => s.trim().replace(/\s+/g, "-"))
    .filter(Boolean);
  const base = ["color", ...(segments.length ? segments : ["swatch"])].join("/");
  let path = base;
  let n = 2;
  while (used.has(path)) path = `${base}-${n++}`;
  used.add(path);
  return path;
}

function loadSwatches(ctx: Context, doc: SketchDocument): void {
  const used = new Set<string>();
  for (const s of doc.sharedSwatches?.objects ?? []) {
    if (!s.do_objectID || !s.value) continue;
    ctx.tokens.set(s.do_objectID, { path: swatchTokenPath(s.name, used), value: colorToHex(s.value), swatch: s.name ?? "" });
  }
}

function countLayers(layers: SketchLayer[] | undefined): number {
  let n = 0;
  for (const l of layers ?? []) n += 1 + countLayers(l.layers);
  return n;
}

// ───────────────────────── 图层 → 中间树 ─────────────────────────

function baseNode(ctx: Context, layer: SketchLayer, type: NodeType, rect = frameOf(layer)): DocNode {
  const id = ctx.allocId(layer.do_objectID);
  if (layer.resizingConstraint !== undefined) ctx.constraints.set(id, layer.resizingConstraint);
  if (layer.isLocked) ctx.locked.add(id);
  return createNode(type, {
    id,
    name: layer.name ?? type,
    x: rect.x,
    y: rect.y,
    width: Math.max(1, rect.width),
    height: Math.max(1, rect.height),
    rotation: convertRotation(layer.rotation),
    opacity: layerOpacity(layer.style),
    visible: layer.isVisible !== false,
    clip: false,
    style: {},
  });
}

function shapeStyle(ctx: Context, source: SketchStyle | undefined): NodeStyle {
  const style: NodeStyle = {};
  style.fill = convertFill(source, ctx.swatch, ctx.warn);
  const border = convertBorder(source, ctx.swatch, ctx.warn);
  if (border) {
    style.stroke = border.stroke;
    style.strokeWidth = border.strokeWidth;
  }
  const effects = convertEffects(source, ctx.swatch, ctx.warn);
  if (effects) style.effects = effects;
  return style;
}

/** 图案填充的可见区域：cover 居中裁切；其它模式用整图（拉伸到框）。 */
function patternCrop(img: ImageAsset, box: { width: number; height: number }, mode: number | undefined): Rect | undefined {
  if (mode !== 1 || !img.width || !img.height || box.width <= 0 || box.height <= 0) return undefined;
  const boxAspect = box.width / box.height;
  const imgAspect = img.width / img.height;
  if (Math.abs(boxAspect - imgAspect) < 1e-3) return undefined;
  if (imgAspect > boxAspect) {
    const w = img.height * boxAspect;
    return { x: round((img.width - w) / 2), y: 0, width: round(w), height: img.height };
  }
  const h = img.width / boxAspect;
  return { x: 0, y: round((img.height - h) / 2), width: img.width, height: round(h) };
}

function imageRef(img: ImageAsset | null, crop?: Rect): ImageRef | undefined {
  if (!img) return undefined;
  return { assetId: img.id, naturalWidth: img.width, naturalHeight: img.height, ...(crop ? { crop } : {}) };
}

/** 几何形状（矩形/椭圆/多边形/路径）。`styleSource` 允许组合形状把组样式下发给子形状。 */
function convertShape(ctx: Context, layer: SketchLayer, styleSource: SketchStyle | undefined): IrNode | null {
  const rect = frameOf(layer);
  const flipH = Boolean(layer.isFlippedHorizontal);
  const flipV = Boolean(layer.isFlippedVertical);
  let node: DocNode;
  switch (layer._class) {
    case "rectangle":
      node = baseNode(ctx, layer, "rect", rect);
      node.style = shapeStyle(ctx, styleSource);
      {
        const radius = rectCornerRadius(layer, rect.width, rect.height);
        if (radius) node.style.cornerRadius = radius;
      }
      break;
    case "oval":
      node = baseNode(ctx, layer, "ellipse", rect);
      node.style = shapeStyle(ctx, styleSource);
      break;
    case "polygon":
    case "triangle":
      // 参数化多边形顶点朝上；垂直翻转后就不是同一个形状了，退回路径
      if (!flipV) {
        node = baseNode(ctx, layer, "polygon", rect);
        node.sides = layer._class === "triangle" ? 3 : (layer.numberOfPoints ?? layer.points?.length ?? 5);
        node.style = shapeStyle(ctx, styleSource);
        break;
      }
    // falls through
    default: {
      const vector = layer.points
        ? pointsToVector(layer.points, layer.isClosed !== false, rect.width, rect.height, flipH, flipV)
        : null;
      if (!vector) {
        ctx.warn("layer.unsupported", `${layer.name ?? ""} (${layer._class})`);
        return null;
      }
      node = baseNode(ctx, layer, "path", rect);
      node.vector = vector;
      node.style = shapeStyle(ctx, styleSource);
      if (!node.style.stroke && !vector.closed) {
        // 开放路径没有描边就什么都看不见；Sketch 里也是这样，保持原样
      }
    }
  }

  const pattern = patternFill(styleSource);
  if (!pattern) return { node, children: [] };
  return withPatternFill(ctx, node, pattern.image?._ref, pattern.patternFillType);
}

/** 图片填充：矩形直接变图片节点（保留圆角），其它形状做「形状蒙版 + 图片」。 */
function withPatternFill(ctx: Context, shape: DocNode, ref: string | undefined, mode: number | undefined): IrNode {
  const img = ctx.image(ref);
  const box = { width: shape.width, height: shape.height };
  if (shape.type === "rect") {
    const image = createNode("image", {
      ...shape,
      type: "image",
      image: imageRef(img, img ? patternCrop(img, box, mode) : undefined),
      style: { cornerRadius: shape.style.cornerRadius, effects: shape.style.effects },
    });
    return { node: image, children: [] };
  }
  ctx.warn("fill.pattern");
  const group = createNode("group", {
    id: ctx.allocId(shape.id, "~fill"),
    name: shape.name,
    x: shape.x,
    y: shape.y,
    width: shape.width,
    height: shape.height,
    rotation: shape.rotation,
    opacity: shape.opacity,
    visible: shape.visible,
    clip: false,
    style: {},
  });
  const mask: DocNode = { ...shape, x: 0, y: 0, rotation: 0, opacity: 1, isMask: true };
  const image = createNode("image", {
    id: ctx.allocId(shape.id, "~image"),
    name: "Image",
    width: shape.width,
    height: shape.height,
    clip: false,
    image: imageRef(img, img ? patternCrop(img, box, mode) : undefined),
    style: {},
  });
  return { node: group, children: [{ node: mask, children: [] }, { node: image, children: [] }] };
}

/** 组合形状：一个子形状直接展平；多个子形状变成分组，每个子形状继承组样式。 */
function convertShapeGroup(ctx: Context, layer: SketchLayer): IrNode | null {
  const shapes = (layer.layers ?? []).filter((l) => !SKIPPED_CLASSES.has(l._class));
  const rect = frameOf(layer);
  const simple = !layer.rotation && !layer.isFlippedHorizontal && !layer.isFlippedVertical;
  if (shapes.length === 1 && simple) {
    const child = convertLayer(ctx, shapes[0], layer.style);
    if (!child) return null;
    child.node.x = round(child.node.x + rect.x);
    child.node.y = round(child.node.y + rect.y);
    child.node.name = layer.name ?? child.node.name;
    child.node.opacity = layerOpacity(layer.style) * child.node.opacity;
    child.node.visible = layer.isVisible !== false && child.node.visible;
    if (layer.isLocked) ctx.locked.add(child.node.id);
    if (layer.resizingConstraint !== undefined) ctx.constraints.set(child.node.id, layer.resizingConstraint);
    // 覆盖与对照都按组的 id 找：让它指向展平后的节点
    if (!ctx.idMap.has(layer.do_objectID)) ctx.idMap.set(layer.do_objectID, child.node.id);
    return child;
  }
  if (shapes.slice(1).some((s) => s.booleanOperation !== undefined && s.booleanOperation > 0)) {
    ctx.warn("boolean.approx");
  }
  if (!simple && (layer.isFlippedHorizontal || layer.isFlippedVertical)) ctx.warn("flip.unsupported");
  const node = baseNode(ctx, layer, "group", rect);
  const effects = convertEffects(layer.style, ctx.swatch, ctx.warn);
  if (effects) node.style.effects = effects;
  // 效果挂在组上：子形状只拿填充与描边，避免阴影叠多遍
  const childStyle: SketchStyle = { ...layer.style, shadows: [], innerShadows: [], blur: undefined };
  const children: IrNode[] = [];
  for (const s of shapes) {
    ctx.at(s);
    const child = convertLayer(ctx, s, childStyle);
    if (child) children.push(child);
  }
  return { node, children };
}

function convertImageLayer(ctx: Context, layer: SketchLayer): IrNode {
  const node = baseNode(ctx, layer, "image");
  const img = ctx.image(layer.image?._ref);
  let crop: Rect | undefined;
  const mask = parseRectString(layer.clippingMask);
  if (img && mask && (mask.x !== 0 || mask.y !== 0 || mask.width !== 1 || mask.height !== 1)) {
    crop = {
      x: round(mask.x * img.width),
      y: round(mask.y * img.height),
      width: round(mask.width * img.width),
      height: round(mask.height * img.height),
    };
  }
  node.image = imageRef(img, crop);
  const effects = convertEffects(layer.style, ctx.swatch, ctx.warn);
  if (effects) node.style.effects = effects;
  if (layer.isFlippedHorizontal || layer.isFlippedVertical) ctx.warn("flip.unsupported");
  return { node, children: [] };
}

function convertInstance(ctx: Context, layer: SketchLayer): IrNode {
  const componentId = layer.symbolID ? ctx.symbols.get(layer.symbolID) : undefined;
  if (!componentId) {
    ctx.warn("symbol.missing");
    const node = baseNode(ctx, layer, "frame");
    node.name = `${node.name} (missing symbol)`;
    return { node, children: [] };
  }
  const node = baseNode(ctx, layer, "instance");
  if (layer.isFlippedHorizontal || layer.isFlippedVertical) ctx.warn("flip.unsupported");
  return { node, children: [], instance: { componentId, overrides: layer.overrideValues ?? [] } };
}

/** 画板/母版的背景色（只有勾选了背景色才算）。 */
function backgroundFill(layer: SketchLayer): NodeStyle["fill"] {
  return layer.hasBackgroundColor && layer.backgroundColor ? { value: colorToHex(layer.backgroundColor) } : undefined;
}

/**
 * 画板类图层：旧版的 `artboard`，以及 Sketch 2025+ 取代画板的 Frame（`group` + `groupBehavior: 1`）。
 * 顶层的画板类图层转成页面，嵌套的转成画板（frame）。
 */
function isArtboardLike(layer: SketchLayer): boolean {
  return layer._class === "artboard" || (layer._class === "group" && layer.groupBehavior === 1);
}

/** 画板类图层的底色：旧版画板用 `backgroundColor`，新版 Frame 用普通填充。 */
function artboardFill(ctx: Context, layer: SketchLayer): NodeStyle["fill"] {
  return layer._class === "artboard" ? backgroundFill(layer) : convertFill(layer.style, ctx.swatch, ctx.warn);
}

function clipsContent(layer: SketchLayer): boolean {
  if (layer.clippingBehavior === 1) return true;
  if (layer.clippingBehavior === 2) return false;
  return isArtboardLike(layer);
}

function convertLayer(ctx: Context, layer: SketchLayer, styleOverride?: SketchStyle): IrNode | null {
  ctx.at(layer);
  if (SKIPPED_CLASSES.has(layer._class)) return null;
  switch (layer._class) {
    case "rectangle":
    case "oval":
    case "polygon":
    case "triangle":
    case "star":
    case "shapePath":
      return convertShape(ctx, layer, styleOverride ?? layer.style);
    case "shapeGroup":
      return convertShapeGroup(ctx, layer);
    case "text": {
      const node = baseNode(ctx, layer, "text");
      const { patch, style } = convertText(layer, ctx.swatch, ctx.warn);
      Object.assign(node, patch);
      node.style = style;
      const effects = convertEffects(layer.style, ctx.swatch, ctx.warn);
      if (effects) node.style.effects = effects;
      if (layer.isFlippedHorizontal || layer.isFlippedVertical) ctx.warn("flip.unsupported");
      return { node, children: [] };
    }
    case "bitmap":
      return convertImageLayer(ctx, layer);
    case "symbolInstance":
      return convertInstance(ctx, layer);
    case "artboard":
    case "symbolMaster": {
      // 嵌套画板（Sketch 新版 Frame）→ 裁剪画板
      const node = baseNode(ctx, layer, "frame");
      node.clip = true;
      const fill = backgroundFill(layer);
      if (fill) node.style.fill = fill;
      return { node, children: convertChildren(ctx, layer.layers) };
    }
    case "group":
    default: {
      if (isArtboardLike(layer)) {
        // Sketch 2025+ 的 Frame：带填充 / 描边 / 阴影的容器，默认裁剪内容
        const node = baseNode(ctx, layer, "frame");
        node.clip = clipsContent(layer);
        node.style = shapeStyle(ctx, layer.style);
        return { node, children: convertChildren(ctx, layer.layers) };
      }
      if (layer._class !== "group" && !layer.layers) {
        ctx.warn("layer.unsupported", `${layer.name ?? ""} (${layer._class})`);
        return null;
      }
      const node = baseNode(ctx, layer, clipsContent(layer) ? "frame" : "group");
      if (node.type === "frame") node.clip = true;
      if (layer.isFlippedHorizontal || layer.isFlippedVertical) ctx.warn("flip.unsupported");
      const effects = convertEffects(layer.style, ctx.swatch, ctx.warn);
      if (effects) node.style.effects = effects;
      return { node, children: convertChildren(ctx, layer.layers) };
    }
  }
}

/**
 * 子图层列表 + 蒙版改写。
 *
 * Sketch 的蒙版遮住它之上的**所有**兄弟（直到 `shouldBreakMaskChain`）；
 * Sqraft 的蒙版只遮住上方相邻的**一个**兄弟。被遮的不止一个时，把它们包进一个分组。
 */
function convertChildren(ctx: Context, layers: SketchLayer[] | undefined): IrNode[] {
  const items: Array<{ layer: SketchLayer; ir: IrNode }> = [];
  for (const layer of layers ?? []) {
    const ir = convertLayer(ctx, layer);
    if (ir) items.push({ layer, ir });
  }
  const out: IrNode[] = [];
  for (let i = 0; i < items.length; i++) {
    const { layer, ir } = items[i];
    if (!layer.hasClippingMask) {
      out.push(ir);
      continue;
    }
    if (!MASK_SHAPES.has(ir.node.type)) {
      // Sketch 允许分组/图片/文本做 alpha 蒙版；Sqraft 的蒙版只取形状轮廓，
      // 硬转会把整块内容裁没。退化为普通图层，宁可多画也不丢内容。
      ctx.warn("mask.unsupported", layer.name);
      out.push(ir);
      continue;
    }
    ir.node.isMask = true;
    out.push(ir);
    const masked: IrNode[] = [];
    let j = i + 1;
    while (j < items.length && !items[j].layer.shouldBreakMaskChain && !items[j].layer.hasClippingMask) {
      masked.push(items[j].ir);
      j++;
    }
    if (masked.length === 1) out.push(masked[0]);
    else if (masked.length > 1) out.push(wrapGroup(ctx, ir.node, masked));
    i = j - 1;
  }
  return out;
}

function wrapGroup(ctx: Context, mask: DocNode, children: IrNode[]): IrNode {
  const x1 = Math.min(...children.map((c) => c.node.x));
  const y1 = Math.min(...children.map((c) => c.node.y));
  const x2 = Math.max(...children.map((c) => c.node.x + c.node.width));
  const y2 = Math.max(...children.map((c) => c.node.y + c.node.height));
  for (const c of children) {
    c.node.x = round(c.node.x - x1);
    c.node.y = round(c.node.y - y1);
  }
  const group = createNode("group", {
    id: ctx.allocId(mask.id, "~masked"),
    name: `${mask.name} (masked)`,
    x: round(x1),
    y: round(y1),
    width: Math.max(1, round(x2 - x1)),
    height: Math.max(1, round(y2 - y1)),
    clip: false,
    style: {},
  });
  return { node: group, children };
}

// ───────────────────────── 顶层：页面与主组件 ─────────────────────────

interface TopLevel {
  /** source：来自哪个 Sketch 页面（按对象区分，Sketch 允许页面重名） */
  pages: Array<{ ir: IrNode; group: string; source?: object }>;
  components: Array<{ ir: IrNode; deps: Set<string>; symbolId: string; group: string }>;
}

function instanceDeps(layers: SketchLayer[] | undefined, out: Set<string>): Set<string> {
  for (const l of layers ?? []) {
    if (l._class === "symbolInstance" && l.symbolID) out.add(l.symbolID);
    instanceDeps(l.layers, out);
  }
  return out;
}

function convertMaster(ctx: Context, master: SketchLayer, x: number, y: number): IrNode {
  ctx.at(master);
  const id = ctx.symbols.get(master.symbolID ?? "") ?? ctx.allocId(master.do_objectID);
  if (master.isLocked) ctx.locked.add(id);
  const rect = frameOf(master);
  const fill = master.includeBackgroundColorInInstance ? backgroundFill(master) : undefined;
  const node = createNode("component", {
    id,
    name: master.name ?? "Component",
    x,
    y,
    width: Math.max(1, rect.width),
    height: Math.max(1, rect.height),
    opacity: layerOpacity(master.style),
    visible: master.isVisible !== false,
    clip: true,
    style: fill ? { fill } : {},
  });
  return { node, children: convertChildren(ctx, master.layers) };
}

function layerBounds(layers: SketchLayer[]): Rect | null {
  if (layers.length === 0) return null;
  const rects = layers.map(frameOf);
  const x1 = Math.min(...rects.map((r) => r.x));
  const y1 = Math.min(...rects.map((r) => r.y));
  const x2 = Math.max(...rects.map((r) => r.x + r.width));
  const y2 = Math.max(...rects.map((r) => r.y + r.height));
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/** 散图层分簇的间距：包围盒相距不超过这么多（px）的归入同一簇 */
const LOOSE_GAP = 200;

/** 按包围盒就近分簇（并查集），簇内保持原图层顺序，簇按首个图层的顺序排列。 */
function clusterLayers(layers: SketchLayer[], gap: number): SketchLayer[][] {
  const rects = layers.map(frameOf);
  const parent = layers.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const order = rects.map((_, i) => i).sort((a, b) => rects[a].x - rects[b].x);
  // 按 x 扫描：只和左边界落在 [x, right + gap] 内的图层比较
  for (let a = 0; a < order.length; a++) {
    const i = order[a];
    const ri = rects[i];
    for (let b = a + 1; b < order.length; b++) {
      const j = order[b];
      const rj = rects[j];
      if (rj.x > ri.x + ri.width + gap) break;
      if (rj.y <= ri.y + ri.height + gap && ri.y <= rj.y + rj.height + gap) parent[find(j)] = find(i);
    }
  }
  const groups = new Map<number, SketchLayer[]>();
  layers.forEach((l, i) => {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(l);
    else groups.set(r, [l]);
  });
  return [...groups.values()];
}

/**
 * Sketch 有多张页面，每张一块独立画布；Sqraft 只有一块无限画布。
 * 把各页内容纵向排开（保持页内相对位置），画板 → 页面，母版 → 根上的主组件。
 */
const FOREIGN_GROUP = "外部库";

function convertPages(ctx: Context, pages: SketchPage[], foreign: SketchLayer[]): TopLevel {
  const top: TopLevel = { pages: [], components: [] };

  // 先给所有母版分配 id：实例可能出现在母版之前（跨页引用）
  const masters: Array<
    { layer: SketchLayer; dx: number; dy: number; group: string } | { layer: SketchLayer; foreign: true; group: string }
  > = [];
  let cursorY = 0;
  const placements: Array<{ page: SketchPage; dx: number; dy: number }> = [];
  for (const page of pages) {
    const layers = (page.layers ?? []).filter((l) => !SKIPPED_CLASSES.has(l._class));
    const bounds = layerBounds(layers);
    if (!bounds) continue;
    const dx = -bounds.x;
    const dy = cursorY - bounds.y;
    placements.push({ page, dx, dy });
    cursorY += bounds.height + PAGE_STACK_GAP;
    for (const l of layers) if (l._class === "symbolMaster") masters.push({ layer: l, dx, dy, group: page.name ?? "" });
  }
  for (const f of foreign) masters.push({ layer: f, foreign: true, group: FOREIGN_GROUP });
  for (const m of masters) {
    const symbolId = m.layer.symbolID;
    if (!symbolId || ctx.symbols.has(symbolId)) continue;
    ctx.symbols.set(symbolId, ctx.allocId(m.layer.do_objectID));
  }

  // 主组件
  let foreignX = 0;
  for (const m of masters) {
    const symbolId = m.layer.symbolID ?? "";
    if (top.components.some((c) => c.symbolId === symbolId)) continue;
    const rect = frameOf(m.layer);
    let x: number;
    let y: number;
    if ("foreign" in m) {
      x = foreignX;
      y = cursorY;
      foreignX += rect.width + PAGE_GAP;
    } else {
      x = round(rect.x + m.dx);
      y = round(rect.y + m.dy);
    }
    top.components.push({
      ir: convertMaster(ctx, m.layer, x, y),
      deps: instanceDeps(m.layer.layers, new Set()),
      symbolId,
      group: m.group,
    });
  }

  // 页面
  for (const { page, dx, dy } of placements) {
    const pageStart = top.pages.length;
    const loose: SketchLayer[] = [];
    for (const layer of page.layers ?? []) {
      if (SKIPPED_CLASSES.has(layer._class) || layer._class === "symbolMaster") continue;
      if (!isArtboardLike(layer)) {
        loose.push(layer);
        continue;
      }
      ctx.at(layer);
      const rect = frameOf(layer);
      const node = createNode("page", {
        id: ctx.allocId(layer.do_objectID),
        name: layer.name ?? "Page",
        x: round(rect.x + dx),
        y: round(rect.y + dy),
        width: Math.max(1, rect.width),
        height: Math.max(1, rect.height),
        visible: layer.isVisible !== false,
        style: {},
      });
      if (layer.isLocked) ctx.locked.add(node.id);
      const fill = artboardFill(ctx, layer);
      if (fill) node.style.fill = fill;
      top.pages.push({ ir: { node, children: convertChildren(ctx, layer.layers) }, group: page.name ?? "", source: page });
    }
    if (loose.length) {
      ctx.warn("layer.loose", page.name);
      // 散图层（多是画板旁的标注文字）按空间就近分簇，每簇一个贴身的透明页面。
      // 不能整页一个大包围盒：页面缺省白底，散在画板四周的图层会撑出一张盖住画板的大白板。
      const clusters = clusterLayers(loose, LOOSE_GAP);
      const loosePages: TopLevel["pages"] = [];
      clusters.forEach((cluster, i) => {
        const bounds = layerBounds(cluster)!;
        const node = createNode("page", {
          id: ctx.allocId(page.do_objectID, i === 0 ? "~loose" : `~loose${i + 1}`),
          name: clusters.length === 1 ? (page.name ?? "Page") : `${page.name ?? "Page"} / 散图层 ${i + 1}`,
          x: round(bounds.x + dx),
          y: round(bounds.y + dy),
          width: Math.max(1, round(bounds.width)),
          height: Math.max(1, round(bounds.height)),
          style: { fill: { value: "#ffffff00" } },
        });
        const children = convertChildren(ctx, cluster);
        for (const c of children) {
          c.node.x = round(c.node.x - bounds.x);
          c.node.y = round(c.node.y - bounds.y);
        }
        loosePages.push({ ir: { node, children }, group: page.name ?? "", source: page });
      });
      // 排在本页画板之前：根节点按顺序绘制，散图层页面即使与画板重叠也不会盖住画板
      top.pages.splice(pageStart, 0, ...loosePages);
    }
  }
  return top;
}

/** 主组件按依赖拓扑排序：被嵌套的组件先建，实例物化时母版已完整。环直接断开。 */
function sortComponents(list: TopLevel["components"]): TopLevel["components"] {
  const bySymbol = new Map(list.map((c) => [c.symbolId, c]));
  const out: TopLevel["components"] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (c: TopLevel["components"][number]): void => {
    const s = state.get(c.symbolId);
    if (s) return;
    state.set(c.symbolId, "visiting");
    for (const dep of c.deps) {
      const d = bySymbol.get(dep);
      if (d && d !== c) visit(d);
    }
    state.set(c.symbolId, "done");
    out.push(c);
  };
  for (const c of list) visit(c);
  return out;
}

// ───────────────────────── 回放命令 ─────────────────────────

function containsInstance(ir: IrNode): boolean {
  return Boolean(ir.instance) || ir.children.some(containsInstance);
}

function flatten(ir: IrNode, parentId: NodeId | null, out: DocNode[] = []): DocNode[] {
  const node: DocNode = { ...ir.node, parentId, children: ir.children.map((c) => c.node.id) };
  out.push(node);
  for (const c of ir.children) flatten(c, node.id, out);
  return out;
}

class Emitter {
  /** 当前回放目标：每个顶层节点各自一个临时 store（见 `buildTopLevel`）。 */
  store = new DocStore(createEmptyDoc());

  constructor(private readonly ctx: Context) {}

  lock(ids: NodeId[]): void {
    this.run("锁定", () =>
      this.store.apply(ids.map((id) => ({ type: "node.update" as const, params: { nodeId: id, patch: { locked: true } } }))),
    );
  }

  private run(label: string, fn: () => void): boolean {
    try {
      fn();
      return true;
    } catch (error) {
      this.ctx.warn("command.failed", `${label}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  emit(ir: IrNode, parentId: NodeId | null): void {
    if (ir.instance) {
      this.emitInstance(ir, parentId!);
      return;
    }
    if (!containsInstance(ir)) {
      this.run(ir.node.name, () =>
        this.store.apply({ type: "node.create", params: { nodes: flatten(ir, parentId), parentId } }),
      );
      return;
    }
    const ok = this.run(ir.node.name, () =>
      this.store.apply({
        type: "node.create",
        params: { nodes: [{ ...ir.node, parentId, children: [] }], parentId },
      }),
    );
    if (!ok) return;
    for (const c of ir.children) this.emit(c, ir.node.id);
  }

  private emitInstance(ir: IrNode, parentId: NodeId): void {
    const { node, instance } = ir;
    const ok = this.run(node.name, () =>
      this.store.apply({
        type: "instance.create",
        params: { componentId: instance!.componentId, parentId, nodeId: node.id, x: node.x, y: node.y, name: node.name },
      }),
    );
    if (!ok) return;
    this.ctx.at({ _class: "symbolInstance", do_objectID: node.id, name: node.name });

    const doc = this.store.doc;
    const created = doc.nodes[node.id];
    const patch: Partial<DocNode> = {};
    if (node.rotation !== created.rotation) patch.rotation = node.rotation;
    if (node.opacity !== created.opacity) patch.opacity = node.opacity;
    if (node.visible !== created.visible) patch.visible = node.visible;
    const resized = Math.abs(node.width - created.width) > 0.01 || Math.abs(node.height - created.height) > 0.01;
    const cmds: Array<{ type: "node.update"; params: { nodeId: NodeId; patch: Partial<DocNode> } }> = [];
    if (resized) {
      patch.width = node.width;
      patch.height = node.height;
      this.collectResize(created, { width: created.width, height: created.height }, node, cmds);
    }
    if (Object.keys(patch).length) cmds.unshift({ type: "node.update", params: { nodeId: node.id, patch } });
    if (cmds.length) this.run(node.name, () => this.store.apply(cmds));
    this.applyOverrides(node.id, instance!.overrides);
  }

  /** 实例被拉伸：按母版图层的 Sketch 约束，递归换算子图层框。 */
  private collectResize(
    parent: DocNode,
    oldSize: { width: number; height: number },
    newSize: { width: number; height: number },
    out: Array<{ type: "node.update"; params: { nodeId: NodeId; patch: Partial<DocNode> } }>,
  ): void {
    const doc = this.store.doc;
    for (const childId of parent.children) {
      const child = doc.nodes[childId];
      if (!child) continue;
      const constraint = this.ctx.constraints.get(child.mainId ?? child.id);
      const next = resizeByConstraints(
        { x: child.x, y: child.y, width: child.width, height: child.height },
        decodeConstraints(constraint),
        oldSize,
        newSize,
      );
      const patch: Partial<DocNode> = {};
      if (Math.abs(next.x - child.x) > 0.01) patch.x = round(next.x);
      if (Math.abs(next.y - child.y) > 0.01) patch.y = round(next.y);
      if (Math.abs(next.width - child.width) > 0.01) patch.width = round(next.width);
      if (Math.abs(next.height - child.height) > 0.01) patch.height = round(next.height);
      if (Object.keys(patch).length) out.push({ type: "node.update", params: { nodeId: child.id, patch } });
      if (child.children.length && (patch.width !== undefined || patch.height !== undefined)) {
        this.collectResize(child, { width: child.width, height: child.height }, next, out);
      }
    }
  }

  /** 在 `root` 的子树里找母版身份为 `mainId` 的节点（实例物化后每个克隆都带 mainId）。 */
  private findByMainId(rootId: NodeId, mainId: NodeId): DocNode | null {
    const doc = this.store.doc;
    const queue = [...(doc.nodes[rootId]?.children ?? [])];
    while (queue.length) {
      const node = doc.nodes[queue.shift()!];
      if (!node) continue;
      if (node.mainId === mainId) return node;
      queue.push(...node.children);
    }
    return null;
  }

  private resolvePath(instanceId: NodeId, path: string[]): DocNode | null {
    let cur: NodeId = instanceId;
    let found: DocNode | null = null;
    for (const seg of path) {
      const mainId = this.ctx.idMap.get(seg) ?? seg;
      found = this.findByMainId(cur, mainId);
      if (!found) return null;
      cur = found.id;
    }
    return found;
  }

  /**
   * Sketch 实例覆盖：`<layerId>/<layerId>_<属性>`。
   * 替换实例（symbolID）先做、浅的先做，后面更深的覆盖才能在新的子树里找到目标。
   */
  private applyOverrides(instanceId: NodeId, overrides: SketchOverrideValue[]): void {
    const parsed = overrides
      .map((o) => {
        const cut = o.overrideName.lastIndexOf("_");
        if (cut <= 0) return null;
        return { path: o.overrideName.slice(0, cut).split("/"), prop: o.overrideName.slice(cut + 1), value: o.value };
      })
      .filter((o): o is { path: string[]; prop: string; value: unknown } => o !== null)
      .sort((a, b) => a.path.length - b.path.length || Number(b.prop === "symbolID") - Number(a.prop === "symbolID"));

    for (const o of parsed) {
      if (!["stringValue", "symbolID", "image"].includes(o.prop)) {
        this.ctx.warn("override.unsupported", o.prop);
        continue;
      }
      const target = this.resolvePath(instanceId, o.path);
      if (!target) {
        this.ctx.warn("override.unresolved", o.path.join("/"));
        continue;
      }
      if (o.prop === "stringValue" && target.type === "text") {
        const text = String(o.value ?? "");
        if (text !== target.text) {
          this.run(target.name, () => this.store.apply({ type: "node.update", params: { nodeId: target.id, patch: { text } } }));
        }
      } else if (o.prop === "symbolID") {
        const symbolId = String(o.value ?? "");
        if (!symbolId) {
          this.run(target.name, () =>
            this.store.apply({ type: "node.update", params: { nodeId: target.id, patch: { visible: false } } }),
          );
          continue;
        }
        const componentId = this.ctx.symbols.get(symbolId);
        if (!componentId) {
          this.ctx.warn("symbol.missing", symbolId);
          continue;
        }
        if (target.type === "instance" && target.componentId !== componentId) {
          this.run(target.name, () =>
            this.store.apply({ type: "instance.swap", params: { instanceId: target.id, componentId } }),
          );
        }
      } else if (o.prop === "image" && target.type === "image") {
        const ref = (o.value as { _ref?: string } | null)?._ref;
        const img = this.ctx.image(ref);
        if (img) {
          const image = imageRef(img)!;
          this.run(target.name, () =>
            this.store.apply({ type: "node.update", params: { nodeId: target.id, patch: { image } } }),
          );
        }
      }
    }
  }
}

/** IR 子树直接引用的主组件：实例本身 + 覆盖里替换成的组件。 */
function directDeps(ctx: Context, ir: IrNode, out: Set<NodeId>): Set<NodeId> {
  if (ir.instance) {
    out.add(ir.instance.componentId);
    for (const o of ir.instance.overrides) {
      if (!o.overrideName.endsWith("_symbolID")) continue;
      const id = ctx.symbols.get(String(o.value ?? ""));
      if (id) out.add(id);
    }
  }
  for (const c of ir.children) directDeps(ctx, c, out);
  return out;
}

function subtreeIds(state: DocState, rootId: NodeId): NodeId[] {
  const out: NodeId[] = [];
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    const node = state.nodes[id];
    if (!node) continue;
    out.push(id);
    for (const c of node.children) stack.push(c);
  }
  return out;
}

/**
 * 逐个顶层节点（主组件 / 页面）回放命令，再并入总文档。
 *
 * `DocStore.apply` 每条命令都会扫一遍整张节点表（展开、组件同步），交互编辑没问题，
 * 但导入大稿要回放几万条命令，整表扫描会变成平方级（几十万节点的稿子能跑上几十分钟）。
 * 所以每个顶层节点在一个只装着「它传递依赖的主组件」的临时 store 里回放，
 * 单条命令只扫这一小块。页面之间、组件与页面之间互不修改，合并只是把新节点并进来。
 */
class TopLevelBuilder {
  /** 已建好的主组件：子树节点 id + 子树里实例引用的组件（含嵌套物化出的实例）。 */
  private readonly components = new Map<NodeId, { subtree: NodeId[]; uses: Set<NodeId> }>();

  constructor(
    private readonly ctx: Context,
    private readonly emitter: Emitter,
    readonly state: DocState,
  ) {}

  /**
   * 回放一个顶层节点并入总文档，返回它生成的节点数（失败为 0）。
   *
   * 页面按「页面外壳 + 逐个顶层子节点」分块回放：一个页面可能装着上万节点（例如 Sketch 新版把
   * 整页内容放在一个页面上），整页一次回放又会回到平方级。分块后单条命令只扫当前这块子树。
   */
  build(ir: IrNode): number {
    if (ir.node.type !== "page" || ir.children.length <= 1) return this.emitInto(ir, null);
    let total = this.emitInto({ node: ir.node, children: [] }, null);
    if (!total) return 0;
    for (const child of ir.children) total += this.emitInto(child, ir.node.id);
    return total;
  }

  /**
   * 在一个只装着「传递依赖的主组件」（以及父页面外壳）的临时 store 里回放 `ir`，再把新节点并入总文档。
   * 页面里的锁定回放完就地施加；页面自身与主组件的锁定留到最后统一施加
   * （页面先锁会拒绝后续子块，主组件的锁定要同步到所有实例）。
   */
  private emitInto(ir: IrNode, parentId: NodeId | null): number {
    const need = new Set<NodeId>();
    const queue = [...directDeps(this.ctx, ir, new Set())];
    while (queue.length) {
      const id = queue.pop()!;
      const info = this.components.get(id);
      if (!info || need.has(id)) continue;
      need.add(id);
      queue.push(...info.uses);
    }
    const nodes: DocState["nodes"] = {};
    for (const id of need) for (const n of this.components.get(id)!.subtree) nodes[n] = this.state.nodes[n];
    const rootIds = this.state.rootIds.filter((id) => need.has(id));
    if (parentId) {
      nodes[parentId] = { ...this.state.nodes[parentId], children: [] };
      rootIds.push(parentId);
    }
    this.emitter.store = new DocStore({ ...this.state, rootIds, nodes });
    this.emitter.emit(ir, parentId);
    const out = this.emitter.store.doc;
    const rootId = ir.node.id;
    if (!out.nodes[rootId]) return 0;

    let subtree = subtreeIds(out, rootId);
    if (out.nodes[rootId].type !== "component" && parentId) {
      const locks = subtree.filter((id) => this.ctx.locked.delete(id));
      if (locks.length) {
        this.emitter.lock(locks);
        subtree = subtreeIds(out, rootId);
      }
    } else if (out.nodes[rootId].type !== "component" && ir.children.length) {
      // 整页一次回放（只有一个子节点）：页面以外的锁定就地施加，页面自身留到最后
      const locks = subtree.filter((id) => id !== rootId && this.ctx.locked.delete(id));
      if (locks.length) {
        this.emitter.lock(locks);
        subtree = subtreeIds(out, rootId);
      }
    }
    for (const id of subtree) this.state.nodes[id] = out.nodes[id];
    if (parentId) {
      const parent = this.state.nodes[parentId];
      this.state.nodes[parentId] = { ...parent, children: [...parent.children, rootId] };
    } else this.state.rootIds.push(rootId);
    if (out.nodes[rootId].type === "component") {
      const uses = new Set<NodeId>();
      for (const id of subtree) {
        const n = out.nodes[id];
        if (n.type === "instance" && n.componentId) uses.add(n.componentId);
      }
      this.components.set(rootId, { subtree, uses });
    }
    return subtree.length;
  }
}

function countNodes(state: DocState): Pick<ConvertReport, "pages" | "components" | "instances" | "nodes" | "images"> {
  const nodes = Object.values(state.nodes);
  return {
    pages: nodes.filter((n) => n.type === "page").length,
    components: nodes.filter((n) => n.type === "component").length,
    instances: nodes.filter((n) => n.type === "instance").length,
    nodes: nodes.length,
    images: nodes.filter((n) => n.type === "image").length,
  };
}

/** 主入口：解压后的 .sketch 条目 → Sqraft 文档 + 资源 + 转换报告。 */
export async function convertSketch(archive: SketchArchive, options: ConvertOptions = {}): Promise<ConvertResult> {
  const doc = readJson<SketchDocument>(archive, "document.json");
  if (!doc) throw new Error("不是有效的 .sketch 文件：缺少 document.json");

  const pageRefs = doc.pages?.map((p) => p._ref) ?? Object.keys(archive).filter((k) => /^pages\/.+\.json$/.test(k));
  let pages: SketchPage[] = [];
  for (const ref of pageRefs) {
    const page = readJson<SketchPage>(archive, ref.endsWith(".json") ? ref : `${ref}.json`);
    if (page) pages.push(page);
  }
  const progress = options.onProgress ?? (() => {});
  progress({ kind: "stage", stage: "read" });
  const mastersOnly = new Set<SketchPage>();
  if (options.pages?.length) {
    const wanted = new Set(options.pages);
    // 被选页面里的实例可能引用其它页面的母版：母版照常转换，只是不生成那些页面
    const masterPages = pages.filter((p) => !wanted.has(p.name ?? ""));
    pages = pages.filter((p) => wanted.has(p.name ?? ""));
    for (const p of masterPages) {
      const masters = (p.layers ?? []).filter((l) => l._class === "symbolMaster");
      if (masters.length) {
        const only = { ...p, layers: masters };
        mastersOnly.add(only);
        pages.push(only);
      }
    }
  }
  for (const p of pages) {
    const layers = p.layers ?? [];
    progress({
      kind: "sketchPage",
      name: p.name ?? "",
      artboards: layers.filter(isArtboardLike).length,
      masters: layers.filter((l) => l._class === "symbolMaster").length,
      layers: countLayers(layers),
      mastersOnly: mastersOnly.has(p),
    });
  }
  const foreign = (doc.foreignSymbols ?? []).map((f) => f.symbolMaster).filter((m): m is SketchLayer => Boolean(m));

  const ctx = new Context();
  if (options.swatchTokens !== false) loadSwatches(ctx, doc);
  await loadImages(ctx, archive, [pages, foreign], progress);

  progress({ kind: "stage", stage: "layers" });
  const top = convertPages(ctx, pages, foreign);
  const store = new DocStore(createEmptyDoc());

  progress({ kind: "stage", stage: "tokens", total: ctx.tokens.size });
  const tokenCmds = [...ctx.tokens.values()].map((t) => ({
    type: "token.define" as const,
    params: { path: t.path, tokenType: "color" as const, value: t.value },
  }));
  if (tokenCmds.length) store.apply(tokenCmds);
  for (const t of ctx.tokens.values()) progress({ kind: "token", path: t.path, value: t.value, swatch: t.swatch });

  const builder = new TopLevelBuilder(ctx, new Emitter(ctx), store.doc);
  const components = sortComponents(top.components);
  progress({ kind: "stage", stage: "components", total: components.length });
  components.forEach((c, i) => {
    const nodes = builder.build(c.ir);
    progress({ kind: "item", stage: "components", index: i + 1, total: components.length, name: c.ir.node.name, group: c.group, nodes });
  });
  progress({ kind: "stage", stage: "pages", total: top.pages.length });
  top.pages.forEach((p, i) => {
    const nodes = builder.build(p.ir);
    progress({ kind: "item", stage: "pages", index: i + 1, total: top.pages.length, name: p.ir.node.name, group: p.group, nodes });
  });

  progress({ kind: "stage", stage: "finish" });
  // 锁定放最后：锁定链上的节点拒绝后续编辑（覆盖、拉伸都是编辑）
  const lockCmds = [...ctx.locked]
    .filter((id) => store.doc.nodes[id])
    .map((id) => ({ type: "node.update" as const, params: { nodeId: id, patch: { locked: true } } }));
  if (lockCmds.length) store.apply(lockCmds);

  // 不做 `snapshot()` 深拷贝：这份状态只属于本次转换，大稿深拷贝要好几秒
  const state = store.doc;
  // 一个 Sketch 页面一组：按页面对象区分，同名的不同页面不会被并成一组（组名重复由使用方处理）
  const sections: PageSection[] = [];
  let lastSource: object | undefined;
  for (const p of top.pages) {
    const id = p.ir.node.id;
    if (state.nodes[id]?.type !== "page") continue;
    const last = sections[sections.length - 1];
    if (last && p.source === lastSource) last.pageIds.push(id);
    else sections.push({ name: p.group, pageIds: [id] });
    lastSource = p.source;
  }
  return {
    state,
    sections,
    assets: [...ctx.assets.values()],
    report: {
      ...countNodes(state),
      tokens: Object.keys(state.tokens).length,
      warnings: [...ctx.warnings.values()].sort((a, b) => b.count - a.count),
    },
  };
}
