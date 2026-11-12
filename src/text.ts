/**
 * Sketch 文本 → Sqraft 文本：字体名推导、富文本降级为单一样式。
 *
 * Sqraft 的文本节点只有一套样式；Sketch 的富文本按"覆盖字符最多的那一段"取样式，
 * 混排时上报 `text.mixed`。
 */

import type { DocNode, NodeStyle, TextAlign, TextAutoResize, TextVerticalAlign } from "@sqraft/core";
import type { SketchLayer, SketchTextAttributes } from "./sketch";
import { colorToPaint, convertFill, type SwatchLookup, type Warn } from "./style";

/** 常见 PostScript 家族名 → CSS 家族名。未命中时按驼峰拆分。 */
const KNOWN_FAMILIES: Record<string, string> = {
  PingFangSC: "PingFang SC",
  PingFangTC: "PingFang TC",
  PingFangHK: "PingFang HK",
  HelveticaNeue: "Helvetica Neue",
  Helvetica: "Helvetica",
  ArialMT: "Arial",
  Arial: "Arial",
  "Arial-BoldMT": "Arial",
  SFProText: "SF Pro Text",
  SFProDisplay: "SF Pro Display",
  SFProRounded: "SF Pro Rounded",
  SFCompactText: "SF Compact Text",
  SFCompactDisplay: "SF Compact Display",
  SFMono: "SF Mono",
  ".SFNSText": "SF Pro Text",
  ".SFNSDisplay": "SF Pro Display",
  ".SFUIText": "SF Pro Text",
  ".SFUIDisplay": "SF Pro Display",
  HiraginoSans: "Hiragino Sans",
  "HiraginoSans-W3": "Hiragino Sans",
  AppleSDGothicNeo: "Apple SD Gothic Neo",
  MicrosoftYaHei: "Microsoft YaHei",
  NotoSansSC: "Noto Sans SC",
  NotoSansCJKsc: "Noto Sans CJK SC",
  SourceHanSansSC: "Source Han Sans SC",
  TimesNewRomanPSMT: "Times New Roman",
  CourierNewPSMT: "Courier New",
  Menlo: "Menlo",
  Roboto: "Roboto",
  Inter: "Inter",
  OpenSans: "Open Sans",
};

/** 字重关键字 → 数值（从长到短匹配，避免 "Bold" 先吃掉 "ExtraBold"）。 */
const WEIGHTS: Array<[string, number]> = [
  ["ultralight", 200],
  ["extralight", 200],
  ["semibold", 600],
  ["demibold", 600],
  ["extrabold", 800],
  ["ultrabold", 800],
  ["hairline", 100],
  ["regular", 400],
  ["medium", 500],
  ["heavy", 800],
  ["black", 900],
  ["thin", 100],
  ["light", 300],
  ["book", 400],
  ["bold", 700],
  ["w3", 300],
  ["w6", 600],
];

export interface ParsedFont {
  family: string;
  weight: number;
  italic: boolean;
}

/** PostScript 名（如 "PingFangSC-Semibold"）→ 家族 / 字重 / 斜体。 */
export function parseFontName(postscript: string | undefined): ParsedFont | null {
  if (!postscript) return null;
  const name = postscript.trim();
  if (!name) return null;
  if (KNOWN_FAMILIES[name]) return { family: KNOWN_FAMILIES[name], weight: 400, italic: false };
  const dash = name.indexOf("-");
  const base = dash > 0 ? name.slice(0, dash) : name;
  const suffix = dash > 0 ? name.slice(dash + 1) : "";
  const lower = suffix.toLowerCase();
  const italic = /italic|oblique/.test(lower) || /italic|oblique/i.test(base);
  let weight = 400;
  for (const [key, value] of WEIGHTS) {
    if (lower.includes(key)) {
      weight = value;
      break;
    }
  }
  const cleanBase = base.replace(/(MT|PSMT|PS)$/, "");
  const family =
    KNOWN_FAMILIES[base] ??
    KNOWN_FAMILIES[cleanBase] ??
    cleanBase
      .replace(/^\./, "")
      // 驼峰拆词，但保留连续大写缩写（如 "SC"、"UI"）
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return { family, weight, italic };
}

/** 生成 CSS 字体栈：原字体在前，CJK 与无衬线兜底。 */
export function fontStack(family: string): string {
  const quoted = `'${family.replace(/'/g, "")}'`;
  return family === "PingFang SC" ? `${quoted}, sans-serif` : `${quoted}, 'PingFang SC', sans-serif`;
}

function dominantAttributes(layer: SketchLayer, warn: Warn): SketchTextAttributes | undefined {
  const runs = layer.attributedString?.attributes ?? [];
  if (runs.length === 0) return layer.style?.textStyle?.encodedAttributes;
  if (runs.length > 1) {
    const sig = (a: SketchTextAttributes | undefined): string =>
      JSON.stringify([
        a?.MSAttributedStringFontAttribute?.attributes,
        a?.MSAttributedStringColorAttribute && [
          a.MSAttributedStringColorAttribute.red,
          a.MSAttributedStringColorAttribute.green,
          a.MSAttributedStringColorAttribute.blue,
          a.MSAttributedStringColorAttribute.alpha,
        ],
        a?.kerning,
      ]);
    if (new Set(runs.map((r) => sig(r.attributes))).size > 1) warn("text.mixed", layer.name);
  }
  return [...runs].sort((a, b) => b.length - a.length)[0].attributes;
}

/** 统一换行：Sketch 用 U+2028 / U+2029 表示软换行与段落 */
const LINE_BREAKS = new RegExp(`[${String.fromCharCode(0x2028, 0x2029)}]|\\r\\n?`, "g");

const ALIGN: Record<number, TextAlign> = { 0: "left", 1: "right", 2: "center", 3: "justify", 4: "left" };
const VALIGN: Record<number, TextVerticalAlign> = { 0: "top", 1: "middle", 2: "bottom" };
const AUTO_RESIZE: Record<number, TextAutoResize> = { 0: "auto-width", 1: "auto-height", 2: "fixed" };

export interface TextConversion {
  patch: Partial<DocNode>;
  style: NodeStyle;
}

export function convertText(layer: SketchLayer, swatch: SwatchLookup, warn: Warn): TextConversion {
  const attrs = dominantAttributes(layer, warn);
  const style: NodeStyle = {};
  const font = attrs?.MSAttributedStringFontAttribute?.attributes;
  if (font?.size) style.fontSize = font.size;
  const parsed = parseFontName(font?.name);
  if (parsed) {
    style.fontFamily = fontStack(parsed.family);
    style.fontWeight = parsed.weight;
    if (parsed.italic) style.fontStyle = "italic";
  }

  // 图层样式里的填充会给文字着色，优先于富文本颜色
  const layerFill = convertFill(layer.style, swatch, () => {});
  if (layerFill) style.fill = layerFill;
  else if (attrs?.MSAttributedStringColorAttribute) {
    style.fill = colorToPaint(attrs.MSAttributedStringColorAttribute, 1, swatch);
  } else style.fill = { value: "#000000" };

  const para = attrs?.paragraphStyle;
  if (para?.alignment !== undefined) style.textAlign = ALIGN[para.alignment] ?? "left";
  if (para?.maximumLineHeight && para.maximumLineHeight > 0) {
    style.lineHeight = para.maximumLineHeight;
    style.lineHeightUnit = "px";
  }
  if (para?.paragraphSpacing) style.paragraphSpacing = para.paragraphSpacing;
  if (attrs?.kerning) {
    style.letterSpacing = attrs.kerning;
    style.letterSpacingUnit = "px";
  }
  const transform = attrs?.MSAttributedStringTextTransformAttribute;
  if (transform === 1) style.textCase = "upper";
  else if (transform === 2) style.textCase = "lower";
  if (attrs?.underlineStyle) style.textDecoration = "underline";
  else if (attrs?.strikethroughStyle) style.textDecoration = "strikethrough";
  const va = layer.style?.textStyle?.verticalAlignment;
  if (va !== undefined && VALIGN[va]) style.textVerticalAlign = VALIGN[va];

  return {
    patch: {
      text: (layer.attributedString?.string ?? "").replace(LINE_BREAKS, "\n"),
      textAutoResize: AUTO_RESIZE[layer.textBehaviour ?? 0] ?? "auto-width",
    },
    style,
  };
}
