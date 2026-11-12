# sketch2sqraft

把 Sketch 设计稿（`.sketch`，Sketch 43 及以后的 zip 格式，含 Sketch 2025+ 的 Frame）转换成
[Sqraft](https://github.com/wfdx165/sqraft) 文档（`.sqraft`）的命令行工具。

转换产物不是"拼出来的 JSON"，而是在一个空 `DocStore` 上**回放命令**得到的——实例物化、覆盖记录、
组件同步全部走 Sqraft 的 `@sqraft/core` 命令层，与在 Sqraft 里手工编辑出来的文档守同一套规则，可以直接打开。

> 本工具是独立项目，不是 Sqraft 官方出品；"Sqraft" 只用来说明它转换到的文件格式。

## 安装

需要 Node 22.12+ 与 pnpm 10。

```bash
git clone https://github.com/HD-L/sketch2sqraft.git
cd sketch2sqraft
pnpm install
pnpm run bundle          # 生成 dist/sketch2sqraft.mjs（单文件，已打包 @sqraft/core）
```

注册成全局命令（任意目录直接敲 `sketch2sqraft`）：

```bash
chmod +x dist/sketch2sqraft.mjs
ln -sfn "$PWD/dist/sketch2sqraft.mjs" "$(dirname "$(command -v node)")/sketch2sqraft"
```

改了代码后重新 `pnpm run bundle` 即可，全局命令指向的就是这个文件。

`@sqraft/core` 以 git 依赖的方式从 Sqraft 仓库取（固定在某个提交，见 `package.json`）。

## 命令行

纯命令行工具，没有界面：

```bash
sketch2sqraft design.sketch -o design.sqraft
```

| 选项 | 说明 |
|---|---|
| `-o, --out <file>` | 输出路径，默认与输入同名的 `.sqraft` |
| `-p, --page <name>` | 只转换指定 Sketch 页面（可重复）；其它页面上的母版仍会保留 |
| `--no-tokens` | 不把共享色板（Color Variables）转成颜色 Token |
| `--image-scale <n>` | 超大图保留到画布显示尺寸的几倍，默认 2 |
| `--no-downscale` | 不压缩超大图，原图全部嵌进 `.sqraft` |
| `--originals <dir>` | 超大图原图的存放目录，默认输出文件旁的 `<文件名>-素材原图/` |
| `--json` | 以 JSON 输出转换报告（进度仍写到 stderr，stdout 是纯 JSON） |
| `-v, --verbose` | 逐条列出每张图片、每个组件、每个页面 |
| `-q, --quiet` | 不显示进度，只输出最终报告 |

大稿也能跑：1.4 GB、约 7 万图层 / 1200 个组件的稿子，转出约 19.5 万节点、并压缩 300 多张超大图，耗时 40 秒左右（峰值内存约 6 GB，主要是图片字节）。

转换过程中会在 stderr 显示进度：读到的每个 Sketch 页面（画板 / 组件母版 / 图层数）、建出的每个颜色 Token（附来源色板）、
图片 / 组件 / 页面的进度条，以及按 Sketch 页面汇总的组件数、页面数和节点数，每个阶段附耗时。
输出重定向到文件或管道时不画进度条，只保留这些日志行。

转换结束会打印报告：页面 / 组件 / 实例 / 图片 / Token 数量，以及按类别汇总的"有损转换"提示（附出问题的图层名）。

## 超大图压缩

设计稿里常有「画布上只显示 100×100、原图却是 2000×2000」的图。转换时会把这类图缩小后再嵌进 `.sqraft`，
原图原样拷进输出文件旁的 `<文件名>-素材原图/`，并附一份 `清单.csv`（原图 / 嵌入尺寸与大小、画布显示尺寸、
`.sqraft` 内的资源名、用到它的图层）。

保留范围：

- **需求尺寸**：同一张图所有用到的地方（含实例里、隐藏的图层）取最大的「节点尺寸 ÷ 裁切区域」；
- **保留尺寸** = 需求尺寸 × 2（`--image-scale`），@2x 屏幕上依然清晰；长边至少 64 px；
- 原图**至少比保留尺寸大 1.5 倍、且不小于 64 KB** 才压缩；GIF（可能是动图）与其它格式不动；
- 保持原格式（PNG 保留透明），保留色彩配置与 EXIF 方向；压缩后反而更大的保留原图。

缩放用 [sharp](https://sharp.pixelplumbing.com/)（可选依赖，`pnpm install` 时自动装上）。没有 sharp 时会提示并跳过压缩，
转换照常完成。

## 代码调用

```ts
import { sketchToSqraft, convertSketch, readSketchArchive } from "sketch2sqraft";

const { bytes, report } = await sketchToSqraft(sketchBytes);       // .sketch → .sqraft 字节
const { state, assets } = await convertSketch(readSketchArchive(sketchBytes)); // 拿到 DocState 自己处理

// 进度：阶段开始、读到的 Sketch 页面、建出的 Token、每张图片 / 每个组件 / 每个页面完成
await sketchToSqraft(sketchBytes, { onProgress: (e) => console.log(e) });

// 超大图压缩：缩放函数由调用方提供（命令行用 sharp，桌面端可以用 canvas），原图在 downscaled 里
const { downscaled } = await sketchToSqraft(sketchBytes, { downscale: { resize: myResizer, scale: 2 } });
```

## 映射规则

| Sketch | Sqraft | 说明 |
|---|---|---|
| 页面 | （无） | Sqraft 只有一块无限画布：各 Sketch 页面的内容按原相对位置**纵向排开** |
| 画板 Artboard / Frame（Sketch 2025+） | 页面 Page | 背景色（Frame 为填充）→ 页面填充 |
| 画板外的散图层 | 透明小页面 | 按相距 200 px 以内就近分簇，每簇一个贴身的透明页面，排在画板之前绘制（提示 `layer.loose`） |
| 嵌套画板 / Frame | 画板 Frame | 裁剪内容；带填充 / 描边 / 阴影；`clippingBehavior` 设为裁剪的分组同样转成画板 |
| 组件母版 Symbol Master | 主组件（文档根） | 含外部库组件（`foreignSymbols`）；按依赖拓扑序建立 |
| 实例 Symbol Instance | 实例 | 物化子树；尺寸不同时按 Sketch 的 `resizingConstraint` 换算子图层 |
| 实例覆盖 | 实例覆盖 | 支持文本、嵌套实例替换（含"无"→ 隐藏）、图片；共享样式覆盖跳过 |
| 分组 | 分组 | |
| 矩形 | 矩形 | 四角圆角 |
| 椭圆 | 椭圆 | |
| 多边形 / 三角形 | 多边形 | 垂直翻转时退回路径 |
| 星形 / 矢量路径 | 路径 | 贝塞尔手柄换算为相对偏移；翻转直接烘焙进锚点 |
| 组合形状 Shape Group | 单子形状直接展平；多子形状 → 分组 | 布尔运算按并集近似 |
| 文本 | 文本 | 字体 PostScript 名 → 家族 + 字重；行高 / 字距 / 对齐 / 大小写 / 装饰线 |
| 位图 | 图片 | 字节按内容哈希写进 `assets/`，与桌面端算法一致；保留裁切 |
| 图片填充 | 矩形 → 图片节点；其它形状 → 「形状蒙版 + 图片」 | cover 模式自动居中裁切 |
| 共享色板 | 颜色 Token `color/<色板名>` | 填充 / 描边 / 文字 / 阴影引用色板时写 Token 引用 |
| 蒙版 | 蒙版 | Sketch 蒙版遮住其上**所有**兄弟，转换时把它们包进一个分组 |
| 填充 / 描边 / 阴影 / 内阴影 / 模糊 / 不透明度 / 隐藏 / 锁定 / 旋转 | 对应字段 | 旋转方向取反（Sketch 逆时针为正） |
| 切片、热区 | 跳过 | |

## 已知的有损转换

转换报告会逐类列出，常见的有：

- **多层填充 / 描边**只保留最上层；**渐变**取首个色标的纯色。
- **内 / 外描边**按居中描边处理（Sketch 形状默认内描边，所以这条提示通常很多）。
- **富文本混排**降级为单一样式（取字符数最多的一段）。
- **分组 / 图片 / 文本作蒙版**（alpha 蒙版）不支持，按普通图层绘制，不裁切。
- **Smart Layout / Stack** 不转成自动布局：保留 Sketch 计算好的绝对位置。
- 分组、文本、图片的**翻转**忽略；共享图层样式 / 文本样式不建立关联。
- Sketch 43 之前的 SQLite 格式不支持。

## 开发

```bash
pnpm test            # vitest
pnpm run typecheck   # tsc
pnpm run build       # 类型检查 + 打包
```

## 许可

Apache-2.0，见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
