/**
 * 命令行：sketch2sqraft <input.sketch> [-o output.sqraft] [--page 名称]... [--no-tokens] [--json] [-v] [-q]
 *
 * 进度与日志写 stderr，结果报告写 stdout（`--json` 时是纯 JSON，可直接管道给别的程序）。
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { sketchToSqraft } from "./index";
import type { DownscaledImage } from "./downscale";
import { loadSharpResizer } from "./resize-sharp";
import type { ConvertReport } from "./convert";
import { ProgressPrinter } from "./progress";

const HELP = `用法：sketch2sqraft <input.sketch> [选项]

选项：
  -o, --out <file>     输出路径（默认与输入同名的 .sqraft）
  -p, --page <name>    只转换指定 Sketch 页面（可重复）
      --no-tokens      不把共享色板转成颜色 Token
      --image-scale <n>  超大图保留到画布显示尺寸的几倍（默认 2）
      --no-downscale   不压缩超大图，原图全部嵌进 .sqraft
      --originals <dir>  超大图原图的存放目录（默认输出旁的「<文件名>-素材原图」）
      --json           以 JSON 输出转换报告（进度仍写到 stderr）
  -v, --verbose        逐条列出每张图片、每个组件、每个页面
  -q, --quiet          不显示进度，只输出最终报告
  -h, --help           显示帮助`;

interface Args {
  input?: string;
  out?: string;
  pages: string[];
  tokens: boolean;
  downscale: boolean;
  imageScale: number;
  originals?: string;
  json: boolean;
  verbose: boolean;
  quiet: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { pages: [], tokens: true, downscale: true, imageScale: 2, json: false, verbose: false, quiet: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") args.help = true;
    else if (a === "-o" || a === "--out") args.out = argv[++i];
    else if (a === "-p" || a === "--page") args.pages.push(argv[++i]);
    else if (a === "--no-tokens") args.tokens = false;
    else if (a === "--no-downscale") args.downscale = false;
    else if (a === "--originals") args.originals = argv[++i];
    else if (a === "--image-scale") {
      args.imageScale = Number(argv[++i]);
      if (!(args.imageScale >= 1 && args.imageScale <= 8)) throw new Error("--image-scale 需要 1 到 8 之间的数字");
    }
    else if (a === "--json") args.json = true;
    else if (a === "-v" || a === "--verbose") args.verbose = true;
    else if (a === "-q" || a === "--quiet") args.quiet = true;
    else if (a.startsWith("-")) throw new Error(`未知选项：${a}`);
    else if (!args.input) args.input = a;
    else throw new Error(`多余的参数：${a}`);
  }
  return args;
}

function size(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/** 文件名里不能用 / \\ : * ? " < > | 与控制字符 */
function safeName(s: string): string {
  const cleaned = s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim().slice(0, 40);
  return cleaned || "image";
}

function csvCell(s: string | number): string {
  const v = String(s);
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** 原图拷进素材目录，并写一份清单（带 BOM，Excel 直接打开不乱码）。 */
async function writeOriginals(dir: string, list: DownscaledImage[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  const used = new Set<string>();
  const rows = [["原图文件", "原图尺寸", "原图大小", "画布最大显示尺寸", "嵌入尺寸", "嵌入大小", ".sqraft 内资源", "使用位置"]];
  for (const d of list) {
    const oldId = d.original.name.slice("assets/".length).replace(/\.[^.]+$/, "");
    const ext = extname(d.original.name);
    const layer = d.usedBy[0]?.split(" / ").pop() ?? "image";
    let file = `${safeName(layer)}_${oldId.slice(0, 8)}${ext}`;
    for (let n = 2; used.has(file); n++) file = `${safeName(layer)}_${oldId.slice(0, 8)}-${n}${ext}`;
    used.add(file);
    await writeFile(join(dir, file), d.original.bytes);
    rows.push([
      file,
      `${d.originalWidth}×${d.originalHeight}`,
      size(d.original.bytes.length),
      `${d.displayWidth}×${d.displayHeight}`,
      `${d.width}×${d.height}`,
      size(d.bytes),
      d.name,
      d.usedBy.join("；"),
    ]);
  }
  await writeFile(join(dir, "清单.csv"), "\ufeff" + rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n");
}

function printReport(
  report: ConvertReport,
  out: string,
  bytes: number,
  ms: number,
  downscaled: DownscaledImage[],
  originalsDir: string,
): void {
  console.log(`✔ 已写出 ${out}（${size(bytes)}，总用时 ${(ms / 1000).toFixed(1)}s）`);
  console.log(
    `  页面 ${report.pages} · 组件 ${report.components} · 实例 ${report.instances} · 图片 ${report.images} · Token ${report.tokens} · 节点共 ${report.nodes}`,
  );
  if (downscaled.length) {
    const before = downscaled.reduce((s, d) => s + d.original.bytes.length, 0);
    const after = downscaled.reduce((s, d) => s + d.bytes, 0);
    console.log(`  超大图 ${downscaled.length} 张已缩小：${size(before)} → ${size(after)}，原图与清单在 ${originalsDir}`);
  }
  if (report.warnings.length === 0) return;
  console.log("\n转换提示：");
  for (const w of report.warnings) {
    const examples = w.examples.length ? `  例：${w.examples.join("、")}` : "";
    console.log(`  · ${w.message} ×${w.count}${examples}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.input) {
    console.log(HELP);
    process.exitCode = args.help ? 0 : 1;
    return;
  }
  const input = resolve(args.input);
  const out = resolve(args.out ?? `${input.slice(0, input.length - extname(input).length)}.sqraft`);
  const started = Date.now();
  const printer = args.quiet ? null : new ProgressPrinter(process.stderr, args.verbose);
  if (printer) process.stderr.write(`sketch2sqraft  ${basename(input)}（${size((await stat(input)).size)}）\n\n`);
  let resize = args.downscale ? await loadSharpResizer() : null;
  if (args.downscale && !resize) {
    process.stderr.write("⚠ 没有可用的 sharp，跳过超大图压缩（原图全部嵌入）。在仓库里执行 pnpm install 即可装上。\n\n");
  }
  const originalsDir = resolve(args.originals ?? join(dirname(out), `${basename(out, extname(out))}-素材原图`));
  const { bytes, report, downscaled } = await sketchToSqraft(new Uint8Array(await readFile(input)), {
    pages: args.pages,
    swatchTokens: args.tokens,
    onProgress: printer?.handle,
    downscale: resize ? { resize, scale: args.imageScale } : undefined,
  });
  resize = null;
  await writeFile(out, bytes);
  if (downscaled.length) await writeOriginals(originalsDir, downscaled);
  if (printer) {
    printer.done();
    process.stderr.write("\n");
  }
  if (args.json) {
    const images = downscaled.map((d) => ({
      original: d.original.name,
      originalWidth: d.originalWidth,
      originalHeight: d.originalHeight,
      originalBytes: d.original.bytes.length,
      asset: d.name,
      width: d.width,
      height: d.height,
      bytes: d.bytes,
      displayWidth: d.displayWidth,
      displayHeight: d.displayHeight,
      usedBy: d.usedBy,
    }));
    const extra = downscaled.length ? { originalsDir, downscaled: images } : {};
    console.log(JSON.stringify({ input: basename(input), output: out, ...report, ...extra }, null, 2));
  } else printReport(report, out, bytes.length, Date.now() - started, downscaled, originalsDir);
}

main().catch((error: unknown) => {
  console.error(`✘ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
