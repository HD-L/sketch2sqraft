/**
 * 位图工具：嗅探格式、读取原始尺寸、按内容哈希生成资源 id。
 * 只读文件头，不解码像素；不依赖 DOM（Node 与浏览器都有 WebCrypto）。
 */

export interface ImageInfo {
  mime: string;
  ext: string;
  width: number;
  height: number;
}

function u16be(b: Uint8Array, o: number): number {
  return (b[o] << 8) | b[o + 1];
}
function u32be(b: Uint8Array, o: number): number {
  return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
}
function u16le(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}
function u24le(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
}

function jpegSize(b: Uint8Array): [number, number] {
  let o = 2;
  while (o + 9 < b.length) {
    if (b[o] !== 0xff) {
      o += 1;
      continue;
    }
    const marker = b[o + 1];
    // SOF0–SOF15（排除 DHT/JPG/DAC）
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return [u16be(b, o + 7), u16be(b, o + 5)];
    }
    o += 2 + u16be(b, o + 2);
  }
  return [0, 0];
}

function webpSize(b: Uint8Array): [number, number] {
  const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
  if (chunk === "VP8 ") return [u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff];
  if (chunk === "VP8L") {
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1];
  }
  if (chunk === "VP8X") return [u24le(b, 24) + 1, u24le(b, 27) + 1];
  return [0, 0];
}

/** 识别 PNG / JPEG / GIF / WebP；其它格式（PDF、TIFF…）返回 null。 */
export function sniffImage(b: Uint8Array): ImageInfo | null {
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { mime: "image/png", ext: "png", width: u32be(b, 16), height: u32be(b, 20) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    const [width, height] = jpegSize(b);
    return { mime: "image/jpeg", ext: "jpg", width, height };
  }
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { mime: "image/gif", ext: "gif", width: u16le(b, 6), height: u16le(b, 8) };
  }
  if (b.length >= 30 && String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WEBP") {
    const [width, height] = webpSize(b);
    return { mime: "image/webp", ext: "webp", width, height };
  }
  return null;
}

/** 与桌面端 `assetIdFor` 同一算法：SHA-256 前 16 个十六进制字符。 */
export async function assetIdFor(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}
