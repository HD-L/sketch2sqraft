import { describe, expect, it } from "vitest";
import { convertRotation, decodeConstraints, parsePoint, parseRectString, pointsToVector, resizeByConstraints } from "../src/geometry";
import { colorToHex } from "../src/style";
import { parseFontName } from "../src/text";
import { sniffImage } from "../src/image";
import { fakePng } from "./fixture";

describe("geometry", () => {
  it("解析点串与矩形串", () => {
    expect(parsePoint("{0.5, 1e-3}")).toEqual([0.5, 0.001]);
    expect(parsePoint("bad")).toBeNull();
    expect(parseRectString("{{0.1, 0}, {0.5, 1}}")).toEqual({ x: 0.1, y: 0, width: 0.5, height: 1 });
  });

  it("曲线点 → 相对手柄；水平翻转镜像坐标与手柄", () => {
    const pts = [
      { point: "{0, 0.5}", curveFrom: "{0, 0}", curveTo: "{0, 1}", hasCurveFrom: true, hasCurveTo: true, curveMode: 2 },
      { point: "{1, 0.5}", curveFrom: "{1, 1}", curveTo: "{1, 0}", hasCurveFrom: true, hasCurveTo: true, curveMode: 2 },
    ];
    const v = pointsToVector(pts, true, 100, 50)!;
    expect(v.closed).toBe(false); // 少于 3 个点不能闭合
    expect(v.anchors[0]).toEqual({ x: 0, y: 25, inX: 0, inY: 25, outX: 0, outY: -25 });
    const flipped = pointsToVector(pts, false, 100, 50, true)!;
    expect(flipped.anchors[0].x).toBe(100);
    expect(flipped.anchors[1].x).toBe(0);
  });

  it("旋转方向取反并规范到 (-180, 180]", () => {
    expect(convertRotation(90)).toBe(-90);
    expect(convertRotation(-270)).toBe(-90);
    expect(convertRotation(undefined)).toBe(0);
  });

  it("约束换算", () => {
    const parent = { width: 100, height: 100 };
    const next = { width: 200, height: 100 };
    const rect = { x: 10, y: 10, width: 20, height: 20 };
    // 63 = 无约束 → 等比
    expect(resizeByConstraints(rect, decodeConstraints(63), parent, next)).toEqual({ x: 20, y: 10, width: 40, height: 20 });
    // 右固定 + 固定宽
    const right = decodeConstraints(63 - 1 - 2);
    expect(resizeByConstraints(rect, right, parent, next).x).toBe(110);
    // 左右都固定 → 拉伸
    expect(resizeByConstraints(rect, decodeConstraints(63 - 1 - 4), parent, next).width).toBe(120);
  });
});

describe("style / text / image", () => {
  it("颜色转十六进制，带透明度时 8 位", () => {
    expect(colorToHex({ red: 1, green: 0.5, blue: 0, alpha: 1 })).toBe("#ff8000");
    expect(colorToHex({ red: 0, green: 0, blue: 0, alpha: 1 }, 0.5)).toBe("#00000080");
  });

  it("PostScript 字体名推导家族与字重", () => {
    expect(parseFontName("PingFangSC-Medium")).toEqual({ family: "PingFang SC", weight: 500, italic: false });
    expect(parseFontName("HelveticaNeue-BoldItalic")).toEqual({ family: "Helvetica Neue", weight: 700, italic: true });
    expect(parseFontName("SFProText-Semibold")?.family).toBe("SF Pro Text");
    expect(parseFontName("Roboto-ExtraBold")?.weight).toBe(800);
    expect(parseFontName("MyCustomFont-Light")).toEqual({ family: "My Custom Font", weight: 300, italic: false });
  });

  it("嗅探 PNG 尺寸", () => {
    expect(sniffImage(fakePng(12, 34))).toMatchObject({ mime: "image/png", width: 12, height: 34 });
    expect(sniffImage(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});
