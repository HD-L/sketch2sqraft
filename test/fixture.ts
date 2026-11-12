/** 测试夹具：用代码拼一份最小 .sketch，避免把二进制样稿放进仓库。 */

import { strToU8, zipSync } from "fflate";
import type { SketchColor, SketchLayer } from "../src/sketch";

let seq = 0;
export function uid(prefix = "L"): string {
  seq += 1;
  return `${prefix}-${String(seq).padStart(4, "0")}-0000-0000-000000000000`;
}

export const color = (r: number, g: number, b: number, a = 1, swatchID?: string): SketchColor => ({
  _class: "color",
  red: r,
  green: g,
  blue: b,
  alpha: a,
  ...(swatchID ? { swatchID } : {}),
});

export const solid = (c: SketchColor) => ({ isEnabled: true, fillType: 0, color: c, contextSettings: { opacity: 1 } });

export function layer(cls: string, frame: [number, number, number, number], patch: Partial<SketchLayer> = {}): SketchLayer {
  return {
    _class: cls,
    do_objectID: uid(),
    name: cls,
    frame: { x: frame[0], y: frame[1], width: frame[2], height: frame[3] },
    isVisible: true,
    rotation: 0,
    style: { fills: [], borders: [], shadows: [], innerShadows: [], contextSettings: { opacity: 1 } },
    ...patch,
  };
}

export function rectPoints(radius = 0) {
  return ["{0, 0}", "{1, 0}", "{1, 1}", "{0, 1}"].map((point) => ({
    point,
    curveFrom: point,
    curveTo: point,
    hasCurveFrom: false,
    hasCurveTo: false,
    curveMode: 1,
    cornerRadius: radius,
  }));
}

export function textLayer(frame: [number, number, number, number], text: string, patch: Partial<SketchLayer> = {}): SketchLayer {
  return layer("text", frame, {
    name: text,
    textBehaviour: 0,
    attributedString: {
      string: text,
      attributes: [
        {
          location: 0,
          length: text.length,
          attributes: {
            MSAttributedStringFontAttribute: { attributes: { name: "PingFangSC-Semibold", size: 16 } },
            MSAttributedStringColorAttribute: color(0.2, 0.2, 0.2),
            kerning: 0.5,
            paragraphStyle: { alignment: 2, maximumLineHeight: 24, minimumLineHeight: 24 },
          },
        },
      ],
    },
    ...patch,
  });
}

/** 1×1 PNG 文件头足以让尺寸嗅探工作；这里给 40×20。 */
export function fakePng(width = 40, height = 20): Uint8Array {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const dv = new DataView(b.buffer);
  dv.setUint32(16, width);
  dv.setUint32(20, height);
  return b;
}

export interface FixturePage {
  id?: string;
  name: string;
  layers: SketchLayer[];
}

export function buildSketch(
  pages: FixturePage[],
  extra: { swatches?: Array<{ id: string; name: string; value: SketchColor }>; images?: Record<string, Uint8Array> } = {},
): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  const refs: Array<{ _class: string; _ref_class: string; _ref: string }> = [];
  for (const p of pages) {
    const id = p.id ?? uid("P");
    refs.push({ _class: "MSJSONFileReference", _ref_class: "MSImmutablePage", _ref: `pages/${id}` });
    files[`pages/${id}.json`] = strToU8(JSON.stringify({ _class: "page", do_objectID: id, name: p.name, layers: p.layers }));
  }
  files["document.json"] = strToU8(
    JSON.stringify({
      _class: "document",
      pages: refs,
      sharedSwatches: {
        objects: (extra.swatches ?? []).map((s) => ({ _class: "swatch", do_objectID: s.id, name: s.name, value: s.value })),
      },
      foreignSymbols: [],
    }),
  );
  files["meta.json"] = strToU8(JSON.stringify({ appVersion: "99.1" }));
  for (const [name, bytes] of Object.entries(extra.images ?? {})) files[name] = bytes;
  return files;
}

export function zipSketch(files: Record<string, Uint8Array>): Uint8Array {
  return zipSync(files);
}
