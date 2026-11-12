/**
 * 基于 sharp 的位图缩放（只给命令行用）。sharp 是可选依赖：装不上时返回 null，转换照常进行、只是不压缩。
 */

import type { ImageResizer } from "./downscale";

export async function loadSharpResizer(): Promise<ImageResizer | null> {
  let sharp: typeof import("sharp");
  try {
    sharp = (await import("sharp")).default;
  } catch {
    return null;
  }
  return async ({ bytes, mime, targetWidth, targetHeight }) => {
    // 保留 ICC 与 EXIF 方向：与原图在画布上的呈现一致
    let pipeline = sharp(bytes, { limitInputPixels: false, failOn: "none" })
      .resize(targetWidth, targetHeight, { fit: "fill", kernel: "lanczos3" })
      .withMetadata();
    if (mime === "image/png") pipeline = pipeline.png({ compressionLevel: 9 });
    else if (mime === "image/jpeg") pipeline = pipeline.jpeg({ quality: 88, mozjpeg: true });
    else if (mime === "image/webp") pipeline = pipeline.webp({ quality: 88 });
    else return null;
    return new Uint8Array(await pipeline.toBuffer());
  };
}
