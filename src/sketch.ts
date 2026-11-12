/**
 * Sketch 文件格式（.sketch = zip：document.json / meta.json / pages/*.json / images/*）的最小类型。
 *
 * 只声明转换用到的字段，且全部可选：不同版本的 Sketch 写出的字段差异很大，
 * 读取方一律按"可能缺失"处理，不在这里做校验。
 */

export interface SketchColor {
  _class?: "color";
  red: number;
  green: number;
  blue: number;
  alpha: number;
  /** 引用共享色板（Color Variables） */
  swatchID?: string;
}

export interface SketchGradientStop {
  color: SketchColor;
  position: number;
}

export interface SketchGraphicsContext {
  opacity?: number;
  blendMode?: number;
}

export interface SketchImageRef {
  _ref?: string;
  _ref_class?: string;
}

/** fillType: 0 纯色、1 渐变、4 图案（图片）、5 噪点 */
export interface SketchFill {
  isEnabled?: boolean;
  fillType?: number;
  color?: SketchColor;
  gradient?: { stops?: SketchGradientStop[] };
  image?: SketchImageRef;
  /** 0 平铺、1 填充（cover）、2 拉伸、3 适应（contain） */
  patternFillType?: number;
  contextSettings?: SketchGraphicsContext;
}

/** position: 0 居中、1 内侧、2 外侧 */
export interface SketchBorder extends SketchFill {
  thickness?: number;
  position?: number;
}

export interface SketchShadow {
  isEnabled?: boolean;
  offsetX?: number;
  offsetY?: number;
  blurRadius?: number;
  spread?: number;
  color?: SketchColor;
}

/** type: 0 高斯、1 运动、2 缩放、3 背景 */
export interface SketchBlur {
  isEnabled?: boolean;
  radius?: number;
  type?: number;
}

export interface SketchTextStyle {
  encodedAttributes?: SketchTextAttributes;
  /** 0 顶、1 中、2 底 */
  verticalAlignment?: number;
}

export interface SketchStyle {
  fills?: SketchFill[];
  borders?: SketchBorder[];
  shadows?: SketchShadow[];
  innerShadows?: SketchShadow[];
  blur?: SketchBlur;
  contextSettings?: SketchGraphicsContext;
  textStyle?: SketchTextStyle;
}

export interface SketchRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SketchCurvePoint {
  /** 归一化坐标串，形如 "{0.5, 0}"（相对图层框） */
  point: string;
  curveFrom?: string;
  curveTo?: string;
  hasCurveFrom?: boolean;
  hasCurveTo?: boolean;
  curveMode?: number;
  cornerRadius?: number;
}

export interface SketchTextAttributes {
  MSAttributedStringFontAttribute?: { attributes?: { name?: string; size?: number } };
  MSAttributedStringColorAttribute?: SketchColor;
  /** 1 大写、2 小写 */
  MSAttributedStringTextTransformAttribute?: number;
  kerning?: number;
  underlineStyle?: number;
  strikethroughStyle?: number;
  paragraphStyle?: {
    /** NSTextAlignment：0 左、1 右、2 居中、3 两端、4 自然 */
    alignment?: number;
    maximumLineHeight?: number;
    minimumLineHeight?: number;
    paragraphSpacing?: number;
  };
}

export interface SketchAttributedString {
  string?: string;
  attributes?: Array<{ location: number; length: number; attributes?: SketchTextAttributes }>;
}

export interface SketchOverrideValue {
  /** 形如 "<layerId>/<layerId>_stringValue" */
  overrideName: string;
  value: unknown;
}

export interface SketchLayer {
  _class: string;
  do_objectID: string;
  name?: string;
  frame?: SketchRect;
  rotation?: number;
  isVisible?: boolean;
  isLocked?: boolean;
  isFlippedHorizontal?: boolean;
  isFlippedVertical?: boolean;
  hasClippingMask?: boolean;
  shouldBreakMaskChain?: boolean;
  /** Sketch 2025+：分组的角色。0 = 普通分组，1 = Frame（取代旧版画板），2 = Graphic */
  groupBehavior?: number;
  /** Sketch 2025+：0 = 默认（Frame 裁剪、分组不裁剪），1 = 裁剪，2 = 不裁剪 */
  clippingBehavior?: number;
  /** -1 无、0 并、1 减、2 交、3 差 */
  booleanOperation?: number;
  /** Sketch 的反向位掩码：位为 0 表示该边/尺寸被固定 */
  resizingConstraint?: number;
  style?: SketchStyle;
  layers?: SketchLayer[];

  // 画板 / 母版
  hasBackgroundColor?: boolean;
  backgroundColor?: SketchColor;
  includeBackgroundColorInInstance?: boolean;
  symbolID?: string;

  // 实例
  overrideValues?: SketchOverrideValue[];

  // 形状
  points?: SketchCurvePoint[];
  isClosed?: boolean;
  fixedRadius?: number;
  numberOfPoints?: number;

  // 文本
  attributedString?: SketchAttributedString;
  /** 0 自动宽度、1 固定宽度、2 固定尺寸 */
  textBehaviour?: number;

  // 位图
  image?: SketchImageRef;
  /** 形如 "{{0, 0}, {1, 1}}"（归一化裁切区） */
  clippingMask?: string;
}

export interface SketchSwatch {
  do_objectID: string;
  name?: string;
  value?: SketchColor;
}

export interface SketchDocument {
  pages?: Array<{ _ref: string }>;
  sharedSwatches?: { objects?: SketchSwatch[] };
  foreignSymbols?: Array<{ symbolMaster?: SketchLayer; originalMaster?: SketchLayer }>;
}

export interface SketchPage extends SketchLayer {
  _class: "page";
}

/** 解压后的 .sketch：条目名 → 字节。 */
export type SketchArchive = Record<string, Uint8Array>;
