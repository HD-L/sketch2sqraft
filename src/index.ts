export { convertSketch, swatchTokenPath, WARNING_MESSAGES } from "./convert";
export type {
  AssetEntry,
  ConvertOptions,
  ConvertReport,
  ConvertResult,
  PageSection,
  ProgressEvent,
  ProgressStage,
  WarningSummary,
} from "./convert";
export { readSketchArchive, writeSqraft } from "./archive";
export { downscaleImages } from "./downscale";
export type { DownscaledImage, DownscaleOptions, ImageResizer, ResizeRequest } from "./downscale";
export { parseFontName } from "./text";
export type * from "./sketch";

import { readSketchArchive, writeSqraft } from "./archive";
import { convertSketch, type ConvertOptions, type ConvertReport } from "./convert";
import { downscaleImages, type DownscaledImage, type DownscaleOptions } from "./downscale";

export interface SketchToSqraftOptions extends ConvertOptions {
  /** 传了就压缩超大图（原图在返回值的 `downscaled` 里，由调用方另存） */
  downscale?: DownscaleOptions;
}

/** 一步到位：.sketch 字节 → .sqraft 字节 + 报告（+ 被压缩的超大图原图）。 */
export async function sketchToSqraft(
  bytes: Uint8Array,
  options: SketchToSqraftOptions = {},
): Promise<{ bytes: Uint8Array; report: ConvertReport; downscaled: DownscaledImage[] }> {
  options.onProgress?.({ kind: "stage", stage: "unzip" });
  const result = await convertSketch(readSketchArchive(bytes), options);
  let assets = result.assets;
  let downscaled: DownscaledImage[] = [];
  if (options.downscale) {
    ({ assets, downscaled } = await downscaleImages(result.state, assets, options.downscale, options.onProgress));
  }
  options.onProgress?.({ kind: "stage", stage: "pack" });
  return { bytes: writeSqraft(result.state, assets, undefined, result.sections), report: result.report, downscaled };
}
