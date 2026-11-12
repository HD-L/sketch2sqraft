/**
 * 命令行进度显示：把 `ProgressEvent` 渲染到 stderr（stdout 留给 `--json` 报告）。
 *
 * - 终端（TTY）：每个阶段一行，耗时阶段带原地刷新的进度条 + 当前条目名；
 *   阶段结束时打印按 Sketch 页面汇总的结果。
 * - 非终端（重定向到文件 / 管道）：不画进度条，只输出阶段与汇总行。
 * - `verbose`：额外逐条列出每张图片、每个组件、每个页面。
 */

import type { ProgressEvent, ProgressStage } from "./convert";

const STAGE_LABEL: Record<ProgressStage, string> = {
  unzip: "解压 .sketch",
  read: "读取 Sketch 页面",
  images: "加载图片",
  layers: "解析图层",
  tokens: "创建颜色 Token",
  components: "封装组件",
  pages: "转换页面",
  finish: "收尾（锁定图层）",
  downscale: "压缩超大图",
  pack: "打包 .sqraft",
};

const ITEM_LABEL = { images: "图片", components: "组件", pages: "页面", downscale: "超大图" } as const;
const BAR_WIDTH = 24;
const REDRAW_MS = 50;

/** 终端显示宽度：CJK / 全角字符占两格。 */
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return w;
}

function truncate(s: string, max: number): string {
  if (max <= 1) return "";
  if (displayWidth(s) <= max) return s;
  let out = "";
  let w = 0;
  for (const ch of s) {
    const cw = displayWidth(ch);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
}

function padEnd(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - displayWidth(s)));
}

function seconds(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

interface GroupStat {
  count: number;
  nodes: number;
}

export class ProgressPrinter {
  private readonly tty: boolean;
  /** `detailed` = 该阶段已经在标题下输出过明细行（或进度条） */
  private stage: { name: ProgressStage; total?: number; started: number; detailed: boolean } | null = null;
  /** 终端上，无明细阶段的标题先不换行，结束时原地补上耗时 */
  private pendingTitle = false;
  private barShown = false;
  private lastDraw = 0;
  private groups = new Map<string, GroupStat>();
  private failed = 0;

  constructor(
    private readonly out: NodeJS.WriteStream,
    private readonly verbose: boolean,
  ) {
    this.tty = Boolean(out.isTTY);
  }

  handle = (event: ProgressEvent): void => {
    switch (event.kind) {
      case "stage":
        this.endStage();
        this.groups = new Map();
        this.failed = 0;
        if (event.total === 0) {
          this.line(`▸ ${STAGE_LABEL[event.stage]}：无`);
          break;
        }
        this.stage = { name: event.stage, total: event.total, started: Date.now(), detailed: false };
        if (event.total !== undefined) {
          this.line(this.title());
          this.stage.detailed = true;
        } else if (this.tty) {
          this.out.write(this.title());
          this.pendingTitle = true;
        }
        break;
      case "sketchPage": {
        const parts = [`${event.artboards} 个画板`];
        if (event.masters) parts.push(`${event.masters} 个组件母版`);
        parts.push(`${fmt(event.layers)} 个图层`);
        const note = event.mastersOnly ? "  （未选中，只取组件母版）" : "";
        this.detail(`    ${padEnd(truncate(event.name || "（未命名）", 28), 30)}${parts.join(" · ")}${note}`);
        break;
      }
      case "token":
        this.detail(`    ${padEnd(event.path, 30)}${event.value}${event.swatch ? `  ← 色板「${event.swatch}」` : ""}`);
        break;
      case "item":
        this.item(event);
        break;
    }
  };

  /** 全部结束：收掉最后一个阶段。 */
  done(): void {
    this.endStage();
  }

  private item(event: Extract<ProgressEvent, { kind: "item" }>): void {
    if (event.group !== undefined) {
      const g = this.groups.get(event.group) ?? { count: 0, nodes: 0 };
      g.count += 1;
      g.nodes += event.nodes ?? 0;
      this.groups.set(event.group, g);
    }
    if (event.nodes === 0) this.failed += 1;

    const where = event.group ? `${event.group} / ${event.name}` : event.name;
    if (this.verbose) {
      const nodes = event.nodes !== undefined ? `（${fmt(event.nodes)} 节点）` : "";
      this.detail(`    ${ITEM_LABEL[event.stage]} ${event.index}/${event.total}  ${where}${nodes}`);
      return;
    }
    if (!this.tty) return;
    const now = Date.now();
    if (event.index !== event.total && now - this.lastDraw < REDRAW_MS) return;
    this.lastDraw = now;
    const ratio = event.total ? event.index / event.total : 1;
    const filled = Math.round(ratio * BAR_WIDTH);
    const head = `    [${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}] ${event.index}/${event.total}  `;
    const columns = this.out.columns || 80;
    this.out.write(`\r\x1b[2K${head}${truncate(where, columns - displayWidth(head) - 1)}`);
    this.barShown = true;
  }

  private endStage(): void {
    if (!this.stage) return;
    this.clearBar();
    const { name, started } = this.stage;
    if ((name === "components" || name === "pages") && this.groups.size) {
      for (const [group, g] of this.groups) {
        const label = group || "（未命名）";
        this.line(`    ✔ ${padEnd(truncate(label, 28), 30)}${fmt(g.count)} 个${ITEM_LABEL[name]} · ${fmt(g.nodes)} 个节点`);
      }
    }
    if (this.failed) this.line(`    ✘ ${this.failed} 个${name === "components" ? "组件" : "页面"}创建失败，见下方转换提示`);
    const took = seconds(Date.now() - started);
    if (this.stage.detailed) this.line(`    用时 ${took}`);
    else this.line(`${this.title()}  ${took}`);
    this.stage = null;
  }

  private title(): string {
    const s = this.stage!;
    return `▸ ${STAGE_LABEL[s.name]}${s.total !== undefined ? `（${fmt(s.total)}）` : ""}`;
  }

  /** 阶段标题下的明细行：先把挂起的标题落成独立一行。 */
  private detail(text: string): void {
    if (this.stage && !this.stage.detailed) {
      this.stage.detailed = true;
      if (this.pendingTitle) {
        this.out.write("\n");
        this.pendingTitle = false;
      } else this.line(this.title());
    }
    this.line(text);
  }

  private clearBar(): void {
    if (this.pendingTitle) {
      this.out.write("\r\x1b[2K");
      this.pendingTitle = false;
    }
    if (!this.barShown) return;
    this.out.write("\r\x1b[2K");
    this.barShown = false;
  }

  private line(text: string): void {
    this.clearBar();
    this.out.write(`${text}\n`);
  }
}
