/**
 * 超大图压缩：原图分辨率远超画布上实际需要时，缩小后再嵌进 .sqraft，原图交给调用方另存。
 *
 * 保留范围（同一张图在多处使用时取最大需求）：
 * - 需求倍率 = 节点在画布上的尺寸 ÷ 裁切区域在原图里的像素尺寸，宽高取大者；
 *   实例物化出的节点、隐藏节点都算（隐藏的随时可能被打开）。
 * - 保留倍率 = 需求倍率 × `scale`（默认 2，@2x 屏幕上仍清晰）；长边至少保留 `minEdge` 像素。
 * - 只有原图比保留尺寸大 `minRatio` 倍以上（默认 1.5）、且文件不小于 `minBytes`（默认 64 KB）才压缩；
 *   GIF（可能是动图）与其它格式不动；压缩后反而更大就保留原图。
 *
 * 这里只做决策与引用改写，像素缩放由调用方注入（CLI 用 sharp，桌面端可以用 canvas），
 * 所以本模块仍然不依赖 Node 或 DOM。
 */

import type { DocNode, DocState, ImageRef } from "@sqraft/core";
import type { AssetEntry, ProgressEvent } from "./convert";
import { assetIdFor, sniffImage } from "./image";

export interface ResizeRequest {
  bytes: Uint8Array;
  mime: string;
  width: number;
  height: number;
  targetWidth: number;
  targetHeight: number;
}

/** 把位图缩放到目标尺寸并按原格式编码；做不到返回 null（保留原图）。 */
export type ImageResizer = (request: ResizeRequest) => Promise<Uint8Array | null>;

export interface DownscaleOptions {
  resize: ImageResizer;
  /** 相对画布最大显示尺寸保留的倍数，默认 2 */
  scale?: number;
  /** 原图至少比保留尺寸大这么多倍才压缩，默认 1.5 */
  minRatio?: number;
  /** 小于这个字节数的图不压缩，默认 64 KB */
  minBytes?: number;
  /** 压缩后长边至少保留的像素，默认 64 */
  minEdge?: number;
  /** 并发缩放数，默认 4 */
  concurrency?: number;
}

export interface DownscaledImage {
  /** 原图（`name` 是它在 .sqraft 里原来的路径，已不再引用） */
  original: AssetEntry;
  originalWidth: number;
  originalHeight: number;
  /** 嵌进 .sqraft 的新资源路径 */
  name: string;
  width: number;
  height: number;
  bytes: number;
  /** 画布上实际需要的最大像素尺寸（未乘 `scale`） */
  displayWidth: number;
  displayHeight: number;
  /** 使用这张图的图层，形如「页面 / 图层」，最多 5 个 */
  usedBy: string[];
}

const RESIZABLE = new Set(["image/png", "image/jpeg", "image/webp"]);

interface Usage {
  need: number;
  usedBy: string[];
}

function pageNameOf(state: DocState, node: DocNode): string {
  let cur: DocNode | undefined = node;
  while (cur?.parentId) cur = state.nodes[cur.parentId];
  return cur && cur !== node ? cur.name : "";
}

/** 每个资源在画布上的最大需求倍率（相对原图像素）。 */
function collectUsage(state: DocState): Map<string, Usage> {
  const usage = new Map<string, Usage>();
  const add = (assetId: string, need: number, node: DocNode) => {
    const u = usage.get(assetId) ?? { need: 0, usedBy: [] };
    u.need = Math.max(u.need, need);
    if (u.usedBy.length < 5) {
      const page = pageNameOf(state, node);
      const label = page ? `${page} / ${node.name}` : node.name;
      if (!u.usedBy.includes(label)) u.usedBy.push(label);
    }
    usage.set(assetId, u);
  };
  for (const node of Object.values(state.nodes)) {
    const ref = node.image;
    if (ref?.assetId) {
      const crop = ref.crop ?? { x: 0, y: 0, width: ref.naturalWidth, height: ref.naturalHeight };
      const need = Math.max(node.width / Math.max(1e-6, crop.width), node.height / Math.max(1e-6, crop.height));
      add(ref.assetId, need, node);
    }
    // 页面背景图（平铺 / contain 等模式不好估）：一律按原图需要，不压缩
    const bg = (node as DocNode & { backgroundImage?: { assetId?: string } }).backgroundImage;
    if (bg?.assetId) add(bg.assetId, Number.POSITIVE_INFINITY, node);
  }
  return usage;
}

interface Replacement {
  id: string;
  fx: number;
  fy: number;
  width: number;
  height: number;
}

/** 深度改写所有引用：图片节点、实例覆盖表里的图片、页面背景。 */
function rewriteRefs(value: unknown, replaced: Map<string, Replacement>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const v of value) rewriteRefs(v, replaced);
    return;
  }
  const obj = value as Record<string, unknown>;
  const r = typeof obj.assetId === "string" ? replaced.get(obj.assetId) : undefined;
  if (r) {
    obj.assetId = r.id;
    if (typeof obj.naturalWidth === "number") {
      const ref = obj as unknown as ImageRef;
      ref.naturalWidth = r.width;
      ref.naturalHeight = r.height;
      if (ref.crop) {
        ref.crop = {
          x: ref.crop.x * r.fx,
          y: ref.crop.y * r.fy,
          width: ref.crop.width * r.fx,
          height: ref.crop.height * r.fy,
        };
      }
    }
  }
  for (const v of Object.values(obj)) if (v && typeof v === "object") rewriteRefs(v, replaced);
}

/**
 * 压缩超大图：就地改写 `state` 里的引用，返回新的资源表与被替换下来的原图。
 */
export async function downscaleImages(
  state: DocState,
  assets: readonly AssetEntry[],
  options: DownscaleOptions,
  progress: (event: ProgressEvent) => void = () => {},
): Promise<{ assets: AssetEntry[]; downscaled: DownscaledImage[] }> {
  const scale = options.scale ?? 2;
  const minRatio = options.minRatio ?? 1.5;
  const minBytes = options.minBytes ?? 64 * 1024;
  const minEdge = options.minEdge ?? 64;
  const usage = collectUsage(state);

  const plans: Array<{ asset: AssetEntry; id: string; mime: string; w: number; h: number; tw: number; th: number; u: Usage }> = [];
  for (const asset of assets) {
    const id = asset.name.slice("assets/".length).replace(/\.[^.]+$/, "");
    const u = usage.get(id);
    const info = sniffImage(asset.bytes);
    if (!u || !info || !RESIZABLE.has(info.mime) || asset.bytes.length < minBytes) continue;
    if (!info.width || !info.height || !Number.isFinite(u.need)) continue;
    let keep = u.need * scale;
    keep = Math.max(keep, Math.min(1, minEdge / Math.max(info.width, info.height)));
    if (keep * minRatio > 1) continue;
    plans.push({
      asset,
      id,
      mime: info.mime,
      w: info.width,
      h: info.height,
      tw: Math.max(1, Math.round(info.width * keep)),
      th: Math.max(1, Math.round(info.height * keep)),
      u,
    });
  }

  progress({ kind: "stage", stage: "downscale", total: plans.length });
  const replaced = new Map<string, Replacement>();
  const results: Array<{ plan: (typeof plans)[number]; entry: AssetEntry; width: number; height: number } | null> = [];
  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < plans.length) {
      const i = next++;
      const plan = plans[i];
      let out: Uint8Array | null = null;
      try {
        out = await options.resize({
          bytes: plan.asset.bytes,
          mime: plan.mime,
          width: plan.w,
          height: plan.h,
          targetWidth: plan.tw,
          targetHeight: plan.th,
        });
      } catch {
        out = null;
      }
      const info = out ? sniffImage(out) : null;
      if (out && info && out.length < plan.asset.bytes.length) {
        const id = await assetIdFor(out);
        results[i] = { plan, entry: { name: `assets/${id}.${info.ext}`, bytes: out }, width: info.width, height: info.height };
      } else results[i] = null;
      progress({ kind: "item", stage: "downscale", index: ++done, total: plans.length, name: plan.u.usedBy[0] ?? plan.id });
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 4, plans.length) }, worker));

  const byName = new Map(assets.map((a) => [a.name, a]));
  const downscaled: DownscaledImage[] = [];
  for (const r of results) {
    if (!r) continue;
    const { plan, entry, width, height } = r;
    const newId = entry.name.slice("assets/".length).replace(/\.[^.]+$/, "");
    replaced.set(plan.id, { id: newId, fx: width / plan.w, fy: height / plan.h, width, height });
    byName.delete(plan.asset.name);
    byName.set(entry.name, entry);
    downscaled.push({
      original: plan.asset,
      originalWidth: plan.w,
      originalHeight: plan.h,
      name: entry.name,
      width,
      height,
      bytes: entry.bytes.length,
      displayWidth: Math.ceil(plan.w * plan.u.need),
      displayHeight: Math.ceil(plan.h * plan.u.need),
      usedBy: plan.u.usedBy,
    });
  }
  if (replaced.size) for (const node of Object.values(state.nodes)) rewriteRefs(node, replaced);
  return { assets: [...byName.values()], downscaled };
}
