/**
 * 容器读写：.sketch（zip）解压、.sqraft（zip）打包。
 *
 * .sqraft 的布局必须与 Sqraft 桌面端（wfdx165/sqraft 的 `apps/desktop/src/renderer/fileio.ts`）`serializeDoc` 一致：
 * manifest.json + doc.json + ops.ndjson + assets/<id>.<ext>。
 */

import { strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { CURRENT_FORMAT_VERSION, type DocState } from "@sqraft/core";
import type { AssetEntry } from "./convert";
import type { SketchArchive } from "./sketch";

export function readSketchArchive(bytes: Uint8Array): SketchArchive {
  let files: SketchArchive;
  try {
    files = unzipSync(bytes);
  } catch {
    // Sketch 43 之前是 SQLite 格式，没有公开结构可读
    throw new Error("无法解压：只支持 Sketch 43 及以后的 .sketch（zip）格式");
  }
  if (!files["document.json"]) throw new Error("不是有效的 .sketch 文件：缺少 document.json");
  return files;
}

export function writeSqraft(state: DocState, assets: readonly AssetEntry[], appVersion = "sketch-import"): Uint8Array {
  const files: Zippable = {
    "manifest.json": strToU8(
      JSON.stringify({ formatVersion: state.formatVersion ?? CURRENT_FORMAT_VERSION, app: "sqraft", version: appVersion }),
    ),
    // 大稿的 doc.json 能到几百 MB：level 1 比默认 level 6 快一倍，体积只大约一成
    "doc.json": [strToU8(JSON.stringify(state)), { level: 1 }],
    "ops.ndjson": new Uint8Array(0),
  };
  // PNG/JPEG 已经是压缩格式，不再 deflate
  for (const asset of assets) files[asset.name] = [asset.bytes, { level: 0 }];
  return zipSync(files);
}
