import { describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import sharp from "sharp";
import type { DocNode, DocState } from "@sqraft/core";
import { convertSketch, downscaleImages, sketchToSqraft, type ImageResizer } from "../src/index";
import { sniffImage } from "../src/image";
import { loadSharpResizer } from "../src/resize-sharp";
import { buildSketch, fakePng, layer, rectPoints, uid, zipSketch } from "./fixture";

function byName(state: DocState, name: string): DocNode[] {
  return Object.values(state.nodes).filter((x) => x.name === name);
}

/** 带填充字节的假 PNG：头里是声明的尺寸，长度足够让「压缩后更小」成立。 */
function bigPng(width: number, height: number): Uint8Array {
  const b = new Uint8Array(4096);
  b.set(fakePng(width, height));
  return b;
}

function fakeGif(width: number, height: number): Uint8Array {
  const b = new Uint8Array(4096);
  b.set(new TextEncoder().encode("GIF89a"));
  b[6] = width & 0xff;
  b[7] = width >> 8;
  b[8] = height & 0xff;
  b[9] = height >> 8;
  return b;
}

/** 假缩放器：返回目标尺寸的假 PNG，并记录调用。 */
function fakeResizer(calls: string[]): ImageResizer {
  return async (r) => {
    calls.push(`${r.width}x${r.height}->${r.targetWidth}x${r.targetHeight}`);
    return fakePng(r.targetWidth, r.targetHeight);
  };
}

describe("超大图压缩", () => {
  it("按画布最大需求 × 2 缩小，并同步改写裁切、实例覆盖里的引用", async () => {
    const picId = uid("PIC");
    const symbolID = uid("SYM");
    const master = layer("symbolMaster", [0, 0, 100, 100], {
      name: "Card",
      symbolID,
      layers: [{ ...layer("bitmap", [0, 0, 100, 100], { name: "Pic", image: { _ref: "images/small.png" } }), do_objectID: picId }],
    });
    const instance = layer("symbolInstance", [0, 300, 100, 100], {
      name: "CardInst",
      symbolID,
      overrideValues: [{ overrideName: `${picId}_image`, value: { _ref: "images/big.png" } }],
    });
    const artboard = layer("artboard", [0, 0, 400, 600], {
      name: "Home",
      layers: [
        layer("bitmap", [0, 0, 100, 100], { name: "Hero", image: { _ref: "images/big.png" } }),
        layer("rectangle", [200, 0, 40, 20], {
          name: "Avatar",
          points: rectPoints(0),
          style: { fills: [{ isEnabled: true, fillType: 4, patternFillType: 1, image: { _ref: "images/big.png" } }] },
        }),
        layer("bitmap", [0, 150, 50, 50], { name: "Thumb", image: { _ref: "images/ok.png" } }),
        layer("bitmap", [100, 150, 10, 10], { name: "Anim", image: { _ref: "images/anim.gif" } }),
        instance,
      ],
    });
    const { state, assets } = await convertSketch(
      buildSketch([{ name: "Symbols", layers: [master] }, { name: "Screens", layers: [artboard] }], {
        images: {
          "images/big.png": bigPng(2000, 2000),
          "images/small.png": bigPng(250, 250),
          "images/ok.png": bigPng(120, 120),
          "images/anim.gif": fakeGif(2000, 2000),
        },
      }),
    );
    const before = byName(state, "Hero")[0].image!.assetId!;

    const calls: string[] = [];
    const result = await downscaleImages(state, assets, { resize: fakeResizer(calls), minBytes: 0 });

    // big.png：最大需求 100/2000 → ×2 → 200×200。small.png 在母版里 100/250 → ×2 = 0.8，原图不到保留尺寸的 1.5 倍，不动；
    // ok.png 50/120 ×2 不需要压；GIF 不动
    expect(calls).toEqual(["2000x2000->200x200"]);
    expect(result.downscaled).toHaveLength(1);
    const d = result.downscaled[0];
    expect(d.original.name).toBe(`assets/${before}.png`);
    expect([d.width, d.height, d.displayWidth, d.displayHeight]).toEqual([200, 200, 100, 100]);
    expect(d.usedBy).toContain("Home / Hero");

    const hero = byName(state, "Hero")[0];
    const newId = hero.image!.assetId!;
    expect(newId).not.toBe(before);
    expect(hero.image).toMatchObject({ naturalWidth: 200, naturalHeight: 200 });
    // cover 裁切 2000×2000 → 40×20：原裁切 {0, 500, 2000, 1000}，按 1/10 缩放
    expect(byName(state, "Avatar")[0].image!.crop).toEqual({ x: 0, y: 50, width: 200, height: 100 });

    // 实例里被覆盖成 big.png 的 Pic 换成新资源
    const inst = byName(state, "CardInst")[0];
    const pic = Object.values(state.nodes).find((n) => n.parentId === inst.id && n.name === "Pic")!;
    expect(pic.image).toMatchObject({ assetId: newId, naturalWidth: 200 });

    // 旧资源在文档任何位置（含覆盖表）都不再被引用，也不再出现在资源表里
    expect(JSON.stringify(state)).not.toContain(before);
    expect(result.assets.map((a) => a.name)).toContain(`assets/${newId}.png`);
    expect(result.assets.map((a) => a.name)).not.toContain(d.original.name);
    expect(result.assets).toHaveLength(assets.length);
  });

  it("缩放失败或结果更大时保留原图", async () => {
    const { state, assets } = await convertSketch(
      buildSketch(
        [{ name: "P", layers: [layer("artboard", [0, 0, 100, 100], { name: "A", layers: [layer("bitmap", [0, 0, 10, 10], { name: "X", image: { _ref: "images/x.png" } })] })] }],
        { images: { "images/x.png": bigPng(1000, 1000) } },
      ),
    );
    const id = byName(state, "X")[0].image!.assetId;
    const bigger: ImageResizer = async () => new Uint8Array(10_000);
    const result = await downscaleImages(state, assets, { resize: bigger, minBytes: 0 });
    expect(result.downscaled).toEqual([]);
    expect(byName(state, "X")[0].image!.assetId).toBe(id);
  });

  it("用 sharp 真实缩放：2000×2000 的图在 100×100 的位置上嵌入 200×200", async () => {
    const source = new Uint8Array(
      await sharp({ create: { width: 2000, height: 2000, channels: 4, background: { r: 200, g: 40, b: 40, alpha: 1 } } })
        .png()
        .toBuffer(),
    );
    const resize = await loadSharpResizer();
    expect(resize).not.toBeNull();
    const sketch = zipSketch(
      buildSketch(
        [{ name: "P", layers: [layer("artboard", [0, 0, 200, 200], { name: "A", layers: [layer("bitmap", [0, 0, 100, 100], { name: "Hero", image: { _ref: "images/hero.png" } })] })] }],
        { images: { "images/hero.png": source } },
      ),
    );
    const { bytes, downscaled } = await sketchToSqraft(sketch, { downscale: { resize: resize!, minBytes: 0 } });
    expect(downscaled).toHaveLength(1);
    expect(downscaled[0].original.bytes).toEqual(source);
    const files = unzipSync(bytes);
    const embedded = Object.keys(files).filter((k) => k.startsWith("assets/"));
    expect(embedded).toEqual([downscaled[0].name]);
    expect(sniffImage(files[embedded[0]])).toMatchObject({ mime: "image/png", width: 200, height: 200 });
  });
});
