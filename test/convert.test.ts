import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { CURRENT_FORMAT_VERSION, migrateDoc, type DocNode, type DocState } from "@sqraft/core";
import { convertSketch, readSketchArchive, sketchToSqraft, swatchTokenPath, type ProgressEvent } from "../src/index";
import {
  buildSketch,
  color,
  fakePng,
  layer,
  rectPoints,
  solid,
  textLayer,
  uid,
  zipSketch,
} from "./fixture";

function byName(state: DocState, name: string): DocNode {
  const n = Object.values(state.nodes).find((x) => x.name === name);
  if (!n) throw new Error(`no node named ${name}`);
  return n;
}

function childrenOf(state: DocState, id: string): DocNode[] {
  return state.nodes[id].children.map((c) => state.nodes[c]);
}

describe("基础图层", () => {
  it("画板 → 页面，形状 / 文本 / 路径 / 分组按类型映射", async () => {
    const swatchId = uid("S");
    const rect = layer("rectangle", [10, 20, 100, 40], {
      name: "Card",
      points: rectPoints(8),
      style: {
        fills: [solid(color(1, 0, 0, 1, swatchId))],
        borders: [{ isEnabled: true, fillType: 0, color: color(0, 0, 0, 0.5), thickness: 2, position: 0 }],
        shadows: [{ isEnabled: true, offsetX: 0, offsetY: 4, blurRadius: 12, spread: 0, color: color(0, 0, 0, 0.25) }],
        contextSettings: { opacity: 0.8 },
      },
    });
    const oval = layer("oval", [0, 0, 30, 30], { name: "Dot", rotation: 45, style: { fills: [solid(color(0, 0, 1))] } });
    const line = layer("shapePath", [0, 0, 50, 0], {
      name: "Divider",
      isClosed: false,
      points: [
        { point: "{0, 0}", curveFrom: "{0, 0}", curveTo: "{0, 0}", hasCurveFrom: false, hasCurveTo: false },
        { point: "{1, 0}", curveFrom: "{1, 0}", curveTo: "{1, 0}", hasCurveFrom: false, hasCurveTo: false },
      ],
      style: { borders: [{ isEnabled: true, fillType: 0, color: color(0, 0, 0), thickness: 1 }] },
    });
    const group = layer("group", [200, 200, 60, 60], { name: "Bundle", layers: [oval, line] });
    const title = textLayer([10, 80, 120, 24], "标题");
    const artboard = layer("artboard", [500, 300, 375, 812], {
      name: "Home",
      hasBackgroundColor: true,
      backgroundColor: color(0.95, 0.95, 0.95),
      layers: [rect, group, title],
    });
    const { state, report } = await convertSketch(
      buildSketch([{ name: "Page 1", layers: [artboard] }], {
        swatches: [{ id: swatchId, name: "Brand / Primary Red", value: color(1, 0, 0) }],
      }),
    );

    expect(report.pages).toBe(1);
    const page = byName(state, "Home");
    expect(page.type).toBe("page");
    expect(state.rootIds).toEqual([page.id]);
    // 单页内容平移到原点
    expect([page.x, page.y, page.width, page.height]).toEqual([0, 0, 375, 812]);
    expect(page.style.fill).toEqual({ value: "#f2f2f2" });

    const card = byName(state, "Card");
    expect(card.type).toBe("rect");
    expect(card.parentId).toBe(page.id);
    expect([card.x, card.y, card.width, card.height]).toEqual([10, 20, 100, 40]);
    expect(card.opacity).toBeCloseTo(0.8);
    expect(card.style.fill).toEqual({ token: "color/Brand/Primary-Red" });
    expect(state.tokens["color/Brand/Primary-Red"]).toEqual({ type: "color", value: "#ff0000" });
    expect(card.style.stroke).toEqual({ value: "#00000080" });
    expect(card.style.strokeWidth).toBe(2);
    expect(card.style.cornerRadius).toEqual({ topLeft: 8, topRight: 8, bottomRight: 8, bottomLeft: 8 });
    expect(card.style.effects?.[0]).toMatchObject({ type: "drop-shadow", y: 4, blur: 12, color: { value: "#00000040" } });

    const bundle = byName(state, "Bundle");
    expect(bundle.type).toBe("group");
    expect(childrenOf(state, bundle.id).map((n) => n.type)).toEqual(["ellipse", "path"]);
    // Sketch 逆时针为正，Sqraft 顺时针为正
    expect(byName(state, "Dot").rotation).toBe(-45);
    const divider = byName(state, "Divider");
    expect(divider.vector?.closed).toBe(false);
    expect(divider.vector?.anchors.map((a) => [a.x, a.y])).toEqual([
      [0, 0],
      [50, 0],
    ]);

    const text = byName(state, "标题");
    expect(text.type).toBe("text");
    expect(text.text).toBe("标题");
    expect(text.textAutoResize).toBe("auto-width");
    expect(text.style).toMatchObject({
      fontSize: 16,
      fontWeight: 600,
      fontFamily: "'PingFang SC', sans-serif",
      textAlign: "center",
      lineHeight: 24,
      lineHeightUnit: "px",
      letterSpacing: 0.5,
      fill: { value: "#333333" },
    });
    // 子节点顺序（从下到上）与 Sketch 一致
    expect(childrenOf(state, page.id).map((n) => n.name)).toEqual(["Card", "Bundle", "标题"]);
  });

  it("组合形状：单子形状展平并继承组样式；多子形状变分组", async () => {
    const single = layer("shapeGroup", [10, 10, 20, 20], {
      name: "Single",
      style: { fills: [solid(color(0, 1, 0))] },
      layers: [layer("oval", [2, 3, 16, 14], { style: {} })],
    });
    const multi = layer("shapeGroup", [50, 50, 40, 40], {
      name: "Multi",
      style: { fills: [solid(color(0, 0, 1))] },
      layers: [
        layer("rectangle", [0, 0, 20, 20], { points: rectPoints() }),
        layer("rectangle", [10, 10, 20, 20], { points: rectPoints(), booleanOperation: 1 }),
      ],
    });
    const { state, report } = await convertSketch(
      buildSketch([{ name: "P", layers: [layer("artboard", [0, 0, 200, 200], { name: "A", layers: [single, multi] })] }]),
    );
    const s = byName(state, "Single");
    expect(s.type).toBe("ellipse");
    expect([s.x, s.y, s.width, s.height]).toEqual([12, 13, 16, 14]);
    expect(s.style.fill).toEqual({ value: "#00ff00" });
    const m = byName(state, "Multi");
    expect(m.type).toBe("group");
    expect(childrenOf(state, m.id).every((c) => c.style.fill?.value === "#0000ff")).toBe(true);
    expect(report.warnings.map((w) => w.code)).toContain("boolean.approx");
  });

  it("蒙版遮住多个兄弟时包一层分组", async () => {
    const mask = layer("oval", [0, 0, 100, 100], { name: "Mask", hasClippingMask: true, style: { fills: [solid(color(0, 0, 0))] } });
    const a = layer("rectangle", [10, 10, 30, 30], { name: "A", points: rectPoints() });
    const b = layer("rectangle", [50, 50, 30, 30], { name: "B", points: rectPoints() });
    const c = layer("rectangle", [0, 0, 10, 10], { name: "C", points: rectPoints(), shouldBreakMaskChain: true });
    const { state } = await convertSketch(
      buildSketch([{ name: "P", layers: [layer("artboard", [0, 0, 200, 200], { name: "Art", layers: [mask, a, b, c] })] }]),
    );
    const art = byName(state, "Art");
    const kids = childrenOf(state, art.id);
    expect(kids.map((k) => k.name)).toEqual(["Mask", "Mask (masked)", "C"]);
    expect(kids[0].isMask).toBe(true);
    const wrap = kids[1];
    expect([wrap.x, wrap.y, wrap.width, wrap.height]).toEqual([10, 10, 70, 70]);
    expect(childrenOf(state, wrap.id).map((k) => [k.name, k.x, k.y])).toEqual([
      ["A", 0, 0],
      ["B", 40, 40],
    ]);
  });

  it("分组蒙版不支持：退化为普通图层，不裁掉内容", async () => {
    const maskGroup = layer("group", [0, 0, 50, 50], {
      name: "GroupMask",
      hasClippingMask: true,
      layers: [layer("rectangle", [0, 0, 50, 50], { name: "Inner", points: rectPoints() })],
    });
    const after = layer("rectangle", [10, 10, 10, 10], { name: "After", points: rectPoints() });
    const { state, report } = await convertSketch(
      buildSketch([{ name: "P", layers: [layer("artboard", [0, 0, 100, 100], { name: "Art", layers: [maskGroup, after] })] }]),
    );
    expect(byName(state, "GroupMask").isMask).toBeUndefined();
    expect(childrenOf(state, byName(state, "Art").id).map((n) => n.name)).toEqual(["GroupMask", "After"]);
    expect(report.warnings.map((w) => w.code)).toContain("mask.unsupported");
  });

  it("位图与图片填充写成资源，cover 模式计算裁切", async () => {
    const png = fakePng(40, 20);
    const bitmap = layer("bitmap", [0, 0, 40, 20], { name: "Photo", image: { _ref: "images/abc.png", _ref_class: "MSImageData" } });
    const filled = layer("rectangle", [0, 50, 20, 20], {
      name: "Avatar",
      points: rectPoints(10),
      style: { fills: [{ isEnabled: true, fillType: 4, patternFillType: 1, image: { _ref: "images/abc.png" } }] },
    });
    const pdf = layer("bitmap", [0, 100, 10, 10], { name: "Vector", image: { _ref: "images/v.pdf" } });
    const { state, assets, report } = await convertSketch(
      buildSketch([{ name: "P", layers: [layer("artboard", [0, 0, 100, 200], { name: "A", layers: [bitmap, filled, pdf] })] }], {
        images: { "images/abc.png": png, "images/v.pdf": new TextEncoder().encode("%PDF-1.4") },
      }),
    );
    expect(assets).toHaveLength(1);
    expect(assets[0].name).toMatch(/^assets\/[0-9a-f]{16}\.png$/);
    const photo = byName(state, "Photo");
    expect(photo.type).toBe("image");
    expect(photo.image).toMatchObject({ naturalWidth: 40, naturalHeight: 20 });
    expect(`assets/${photo.image!.assetId}.png`).toBe(assets[0].name);
    const avatar = byName(state, "Avatar");
    expect(avatar.type).toBe("image");
    expect(avatar.image?.crop).toEqual({ x: 10, y: 0, width: 20, height: 20 });
    expect(avatar.style.cornerRadius?.topLeft).toBe(10);
    expect(byName(state, "Vector").image).toBeUndefined();
    expect(report.warnings.map((w) => w.code)).toContain("image.unsupported");
  });
});

describe("组件与实例", () => {
  function buttonMaster() {
    const label = textLayer([10, 8, 80, 24], "Button", { name: "Label", resizingConstraint: 63 - 32 - 4 - 2 - 16 /* 左上固定 + 固定宽高 */ });
    const bg = layer("rectangle", [0, 0, 100, 40], {
      name: "Bg",
      points: rectPoints(4),
      resizingConstraint: 63 - 32 - 4 - 1 - 8, // 四边固定 → 跟随拉伸
      style: { fills: [solid(color(0, 0.5, 1))] },
    });
    const symbolID = uid("SYM");
    return { symbolID, master: layer("symbolMaster", [0, 0, 100, 40], { name: "Button/Primary", symbolID, layers: [bg, label] }), label, bg };
  }

  it("母版 → 根上主组件；实例物化并带文本覆盖与约束拉伸", async () => {
    const { symbolID, master, label, bg } = buttonMaster();
    const instance = layer("symbolInstance", [20, 30, 160, 40], {
      name: "Submit",
      symbolID,
      overrideValues: [{ overrideName: `${label.do_objectID}_stringValue`, value: "提交" }],
    });
    const { state, report } = await convertSketch(
      buildSketch([
        { name: "Symbols", layers: [master] },
        { name: "Screens", layers: [layer("artboard", [0, 0, 375, 600], { name: "Form", layers: [instance] })] },
      ]),
    );
    expect(report.components).toBe(1);
    expect(report.instances).toBe(1);
    const component = byName(state, "Button/Primary");
    expect(component.type).toBe("component");
    expect(component.parentId).toBeNull();
    expect(state.rootIds).toContain(component.id);

    const inst = byName(state, "Submit");
    expect(inst.type).toBe("instance");
    expect(inst.componentId).toBe(component.id);
    expect([inst.x, inst.y, inst.width, inst.height]).toEqual([20, 30, 160, 40]);
    const [bgClone, labelClone] = childrenOf(state, inst.id);
    expect(bgClone.mainId).toBe(bg.do_objectID);
    expect(labelClone.text).toBe("提交");
    // 背景四边固定 → 跟随实例拉宽；文字左上固定 + 固定宽 → 不动
    expect(bgClone.width).toBe(160);
    expect([labelClone.x, labelClone.width]).toEqual([10, 80]);
    // 覆盖写进实例的覆盖表（与编辑器里手改一致）
    expect(inst.overrides?.[label.do_objectID]).toMatchObject({ text: "提交" });
    expect(report.warnings).toEqual([]);
  });

  it("嵌套组件按依赖顺序建立，并支持嵌套替换与嵌套文本覆盖", async () => {
    const primary = buttonMaster();
    const secondary = buttonMaster();
    secondary.master.name = "Button/Secondary";
    const nested = layer("symbolInstance", [0, 0, 100, 40], { name: "Action", symbolID: primary.symbolID });
    const dialogSymbol = uid("SYM");
    const dialog = layer("symbolMaster", [300, 0, 200, 120], {
      name: "Dialog",
      symbolID: dialogSymbol,
      layers: [nested],
    });
    const use = layer("symbolInstance", [0, 0, 200, 120], {
      name: "Confirm",
      symbolID: dialogSymbol,
      overrideValues: [
        { overrideName: `${nested.do_objectID}_symbolID`, value: secondary.symbolID },
        { overrideName: `${nested.do_objectID}/${secondary.label.do_objectID}_stringValue`, value: "取消" },
        { overrideName: `${nested.do_objectID}_layerStyle`, value: "x" },
      ],
    });
    // 依赖方（Dialog）放在被依赖方之前，验证拓扑排序
    const { state, report } = await convertSketch(
      buildSketch([
        { name: "Symbols", layers: [dialog, primary.master, secondary.master] },
        { name: "Screens", layers: [layer("artboard", [0, 0, 400, 400], { name: "S", layers: [use] })] },
      ]),
    );
    expect(report.components).toBe(3);
    const confirm = byName(state, "Confirm");
    const [action] = childrenOf(state, confirm.id);
    expect(action.type).toBe("instance");
    expect(action.componentId).toBe(byName(state, "Button/Secondary").id);
    const texts = Object.values(state.nodes).filter((n) => n.parentId === action.id && n.type === "text");
    expect(texts.map((t) => t.text)).toEqual(["取消"]);
    expect(report.warnings.map((w) => w.code)).toEqual(["override.unsupported"]);
  });

  it("引用不到的组件转成占位画板并给出提示", async () => {
    const orphan = layer("symbolInstance", [0, 0, 50, 50], { name: "Ghost", symbolID: "nope" });
    const { state, report } = await convertSketch(
      buildSketch([{ name: "P", layers: [layer("artboard", [0, 0, 100, 100], { name: "A", layers: [orphan] })] }]),
    );
    expect(byName(state, "Ghost (missing symbol)").type).toBe("frame");
    expect(report.warnings[0].code).toBe("symbol.missing");
  });
});

describe("页面排布与文件", () => {
  it("多张 Sketch 页面纵向排开；画板外的散图层收进新页面", async () => {
    const p1 = { name: "One", layers: [layer("artboard", [100, 100, 300, 200], { name: "A1" })] };
    const p2 = {
      name: "Two",
      layers: [layer("artboard", [-50, -50, 100, 100], { name: "B1" }), layer("rectangle", [200, 0, 10, 10], { name: "Loose", points: rectPoints() })],
    };
    const { state, report } = await convertSketch(buildSketch([p1, p2]));
    const a1 = byName(state, "A1");
    const b1 = byName(state, "B1");
    expect([a1.x, a1.y]).toEqual([0, 0]);
    expect(b1.y).toBeGreaterThan(a1.y + a1.height);
    const loosePage = byName(state, "Two");
    expect(loosePage.type).toBe("page");
    expect(childrenOf(state, loosePage.id).map((n) => [n.name, n.x, n.y])).toEqual([["Loose", 0, 0]]);
    expect(report.pages).toBe(3);
    expect(report.warnings.map((w) => w.code)).toContain("layer.loose");
  });

  it("散图层就近分簇成透明小页面，排在画板之前，不会撑出盖住画板的大白板", async () => {
    const t = (name: string, x: number, y: number) => layer("text", [x, y, 80, 20], { name, attributedString: { string: name, attributes: [] } });
    const { state } = await convertSketch(
      buildSketch([
        {
          name: "P",
          layers: [
            t("NoteA1", -300, 0),
            layer("artboard", [0, 0, 375, 812], { name: "Screen" }),
            t("NoteA2", -300, 40),
            t("NoteFar", 20000, 30000),
          ],
        },
      ]),
    );
    const pages = state.rootIds.map((id) => state.nodes[id]).filter((n) => n.type === "page");
    expect(pages.map((n) => n.name)).toEqual(["P / 散图层 1", "P / 散图层 2", "Screen"]);
    const [near, far] = pages;
    expect([near.width, near.height]).toEqual([80, 60]);
    expect([far.width, far.height]).toEqual([80, 20]);
    expect(near.style.fill).toEqual({ value: "#ffffff00" });
    expect(childrenOf(state, near.id).map((n) => n.name)).toEqual(["NoteA1", "NoteA2"]);
  });

  it("--page 只转换指定页面，但仍保留其它页面上的母版", async () => {
    const symbolID = uid("SYM");
    const master = layer("symbolMaster", [0, 0, 10, 10], { name: "Icon", symbolID });
    const { state } = await convertSketch(
      buildSketch([
        { name: "Symbols", layers: [master] },
        { name: "Keep", layers: [layer("artboard", [0, 0, 50, 50], { name: "K", layers: [layer("symbolInstance", [0, 0, 10, 10], { name: "I", symbolID })] })] },
        { name: "Drop", layers: [layer("artboard", [0, 0, 50, 50], { name: "D" })] },
      ]),
      { pages: ["Keep"] },
    );
    const names = Object.values(state.nodes).map((n) => n.name);
    expect(names).toContain("K");
    expect(names).not.toContain("D");
    expect(byName(state, "I").type).toBe("instance");
  });

  it("锁定图层在转换末尾才锁定，不影响覆盖", async () => {
    const art = layer("artboard", [0, 0, 50, 50], { name: "Locked", isLocked: true, layers: [layer("oval", [0, 0, 5, 5], { name: "O" })] });
    const { state } = await convertSketch(buildSketch([{ name: "P", layers: [art] }]));
    expect(byName(state, "Locked").locked).toBe(true);
  });

  it(".sketch → .sqraft 往返：zip 结构与桌面端一致，可被 migrateDoc 读回", async () => {
    const art = layer("artboard", [0, 0, 50, 50], {
      name: "A",
      layers: [layer("bitmap", [0, 0, 40, 20], { name: "Img", image: { _ref: "images/x.png" } })],
    });
    const sketch = zipSketch(buildSketch([{ name: "P", layers: [art] }], { images: { "images/x.png": fakePng() } }));
    const { bytes } = await sketchToSqraft(sketch);
    const files = unzipSync(bytes);
    expect(Object.keys(files).sort()).toEqual(
      ["doc.json", "manifest.json", "ops.ndjson", expect.stringMatching(/^assets\/[0-9a-f]{16}\.png$/)].sort(),
    );
    const manifest = JSON.parse(strFromU8(files["manifest.json"]));
    expect(manifest).toMatchObject({ app: "sqraft", formatVersion: CURRENT_FORMAT_VERSION });
    const doc = migrateDoc(JSON.parse(strFromU8(files["doc.json"])), manifest.formatVersion);
    expect(byName(doc, "Img").type).toBe("image");
  });

  it("进度回调：按阶段报告页面、Token、组件与页面条目", async () => {
    const symbolID = uid("SYM");
    const master = layer("symbolMaster", [0, 0, 100, 40], {
      name: "Button/Primary",
      symbolID,
      layers: [layer("rectangle", [0, 0, 100, 40], { name: "bg", points: rectPoints(0) }), textLayer([10, 10, 80, 20], "OK")],
    });
    const swatchId = uid("S");
    const events: ProgressEvent[] = [];
    await sketchToSqraft(
      zipSketch(
        buildSketch(
          [
            { name: "Symbols", layers: [master] },
            {
              name: "Screens",
              layers: [
                layer("artboard", [0, 0, 375, 600], { name: "Home", layers: [layer("symbolInstance", [0, 0, 100, 40], { name: "Btn", symbolID })] }),
                layer("artboard", [400, 0, 375, 600], { name: "Me" }),
              ],
            },
          ],
          { swatches: [{ id: swatchId, name: "Brand", value: color(1, 0, 0) }] },
        ),
      ),
      { onProgress: (e) => events.push(e) },
    );
    const stages = events.filter((e) => e.kind === "stage").map((e) => e.stage);
    expect(stages).toEqual(["unzip", "read", "images", "layers", "tokens", "components", "pages", "finish", "pack"]);
    expect(events.filter((e) => e.kind === "sketchPage")).toEqual([
      { kind: "sketchPage", name: "Symbols", artboards: 0, masters: 1, layers: 3, mastersOnly: false },
      { kind: "sketchPage", name: "Screens", artboards: 2, masters: 0, layers: 3, mastersOnly: false },
    ]);
    expect(events.find((e) => e.kind === "token")).toEqual({ kind: "token", path: "color/Brand", value: "#ff0000", swatch: "Brand" });
    const items = events.filter((e) => e.kind === "item");
    expect(items.map((e) => [e.stage, e.index, e.total, e.group, e.name])).toEqual([
      ["components", 1, 1, "Symbols", "Button/Primary"],
      ["pages", 1, 2, "Screens", "Home"],
      ["pages", 2, 2, "Screens", "Me"],
    ]);
    expect(items.every((e) => (e.nodes ?? 0) > 0)).toBe(true);
  });

  it("Sketch 2025+ 的 Frame：顶层 → 页面（填充作底色），嵌套 → 裁剪画板", async () => {
    const inner = layer("group", [10, 10, 100, 100], {
      name: "Card",
      groupBehavior: 1,
      clippingBehavior: 0,
      style: { fills: [solid(color(0, 0, 1))] },
      layers: [layer("rectangle", [0, 0, 300, 30], { name: "Bar", points: rectPoints(0) })],
    });
    const clipped = layer("group", [0, 200, 50, 50], { name: "Clipped", groupBehavior: 0, clippingBehavior: 1, layers: [] });
    const plain = layer("group", [0, 300, 50, 50], { name: "Plain", groupBehavior: 0, clippingBehavior: 0, layers: [] });
    const frame = layer("group", [0, 0, 375, 812], {
      name: "Home",
      groupBehavior: 1,
      clippingBehavior: 0,
      style: { fills: [solid(color(1, 1, 1))] },
      layers: [inner, clipped, plain],
    });
    const { state, report } = await convertSketch(buildSketch([{ name: "P", layers: [frame] }]));
    expect(report.pages).toBe(1);
    const page = byName(state, "Home");
    expect(page.type).toBe("page");
    expect(page.style.fill).toEqual({ value: "#ffffff" });
    expect(byName(state, "Card")).toMatchObject({ type: "frame", clip: true, style: { fill: { value: "#0000ff" } } });
    expect(byName(state, "Clipped")).toMatchObject({ type: "frame", clip: true });
    expect(byName(state, "Plain").type).toBe("group");
    expect(report.warnings.map((w) => w.code)).not.toContain("layer.loose");
  });

  it("锁定的页面分块回放：子节点全部建好后才锁页面", async () => {
    const artboard = layer("artboard", [0, 0, 200, 200], {
      name: "Locked",
      isLocked: true,
      layers: [
        layer("rectangle", [0, 0, 10, 10], { name: "A", points: rectPoints(0) }),
        layer("rectangle", [20, 0, 10, 10], { name: "B", points: rectPoints(0), isLocked: true }),
        layer("rectangle", [40, 0, 10, 10], { name: "C", points: rectPoints(0) }),
      ],
    });
    const { state, report } = await convertSketch(buildSketch([{ name: "P", layers: [artboard] }]));
    const page = byName(state, "Locked");
    expect(page.locked).toBe(true);
    expect(page.children.map((id) => state.nodes[id].name)).toEqual(["A", "B", "C"]);
    expect(byName(state, "B").locked).toBe(true);
    expect(report.warnings).toEqual([]);
  });

  it("拒绝非 zip 的旧版 Sketch 文件", () => {
    expect(() => readSketchArchive(new TextEncoder().encode("SQLite format 3"))).toThrow(/Sketch 43/);
  });

  it("色板名规范成合法 Token 路径", () => {
    const used = new Set<string>();
    expect(swatchTokenPath("Primary", used)).toBe("color/Primary");
    expect(swatchTokenPath("Primary", used)).toBe("color/Primary-2");
    expect(swatchTokenPath(" Text / Body Strong ", used)).toBe("color/Text/Body-Strong");
    expect(swatchTokenPath("", used)).toBe("color/swatch");
  });
});
