// pi-hud v8 布局验收：Line1=ctx+ttft+tokens/s（模型不重复，pi footer 已有），
// 之后是额度窗口，全部走 setWidget("pi-hud", [...], {placement:"belowEditor"})，
// 且不再往 pi footer 追加状态行（省一行终端高度）。
// 用法：node test/layout.test.mjs
//
// 注意：renderStatus 每次会发多个 ui 调用（主渲染 + 清理旧 key），
// 所以断言必须按 key 挑选，不能用 calls.widget.at(-1)。
import { stripTypeScriptTypes } from "node:module";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert";

const file = fileURLToPath(new URL('../extensions/pi-hud.ts', import.meta.url));
const raw = readFileSync(file, "utf8");

let js = stripTypeScriptTypes(raw, { mode: "strip" })
  .replace(/^import .*;$/gm, "")
  .replace(/export default function\s*\(/, "function __factory(");
js += "\nreturn { renderStatus, cache, pushSpeedSample, speedLine };\n";

// 关键：扩展在模块顶层装了 process.on("uncaughtException") 兜底处理器，
// 它会把测试里失败的断言静默吃掉（退出码 0，无输出）。先占位跳过安装。
globalThis.__quotaHudHandlersInstalled = true;

const hud = new Function("homedir", "appendFileSync", "readFileSync", "writeFileSync", "path", js)(
  homedir,
  () => {},
  () => "{}",
  () => {},
  path,
);
assert.ok(hud?.renderStatus, "未能取到 renderStatus");

function mkCtx(model) {
  const calls = { status: [], widget: [] };
  return {
    calls,
    ctx: {
      model,
      getContextUsage: () => ({ tokens: 13_300, contextWindow: 128_000 }),
      ui: {
        theme: undefined,
        setStatus: (k, v) => calls.status.push([k, v]),
        setWidget: (k, v, o) => calls.widget.push([k, v === undefined ? null : v, o?.placement ?? "aboveEditor"]),
      },
    },
  };
}
/** 取本次渲染的主 widget 调用（key=pi-hud 且带行内容） */
const mainWidget = (calls) => calls.widget.filter(([k, v]) => k === "pi-hud" && Array.isArray(v)).at(-1);
const line = (label, used, reset) => ({ label, used, reset });
const flash = { provider: "magpie", id: "workbuddy/glm-5.3-flash", contextWindow: 1_000_000, maxTokens: 131_072 };

let pass = 0;
const ok = (msg) => { pass++; console.log("  ✓ " + msg); };

// ── 场景 1：WorkBuddy（余额型 Credits） ──────────────────────────────────
{
  const { ctx, calls } = mkCtx(flash);
  hud.cache.clear();
  hud.cache.set("magpie:workbuddy", {
    at: Date.now(),
    result: { groups: [{ lines: [line("Credits", 0.148, "103.92 / 700")] }] },
  });
  hud.renderStatus(ctx);

  const w = mainWidget(calls);
  assert.ok(w, "没有找到 key=pi-hud 的 widget 调用");
  assert.strictEqual(w[0], "pi-hud");
  assert.strictEqual(w[2], "belowEditor", "必须在编辑器下方");
  assert.strictEqual(w[1].length, 2, `应为两行，实得 ${w[1].length}：${JSON.stringify(w[1])}`);
  assert.ok(w[1][0].includes("ctx"), "第 1 行缺 ctx：" + w[1][0]);
  assert.ok(!w[1][0].includes("workbuddy/"), "模型名不该在 HUD 里重复（pi footer 右侧已有）：" + w[1][0]);
  assert.ok(w[1][1].includes("Credits"), "第 2 行缺额度：" + w[1][1]);
  assert.ok(!w[1][0].includes("Credits"), "额度不该出现在第 1 行");
  assert.ok(
    calls.status.some(([k, v]) => k === "pi-hud" && (v === undefined || v === null)),
    "底栏旧位置的 setStatus 应被清空，避免双份显示",
  );
  assert.ok(
    !calls.status.some(([k, v]) => k === "pi-hud-speed" && v),
    "v8 不再往 footer 追加速度行（那会多占一行高度）",
  );
  ok("WorkBuddy 两行布局：\n      " + w[1].join("\n      ⏎ "));
}

// ── 场景 2：Antigravity（5h + 7d 双窗压在第 2 行） ───────────────────────
{
  const agy = { provider: "magpie", id: "agy-cli/claude-opus-4-6-thinking", contextWindow: 250_000, maxTokens: 64_000 };
  const { ctx, calls } = mkCtx(agy);
  hud.cache.clear();
  hud.cache.set("magpie:agy-cli", {
    at: Date.now(),
    result: {
      groups: [
        { modelId: "@pool:gemini", lines: [line("Gemini·5h", 0.1, "14:58")] },
        {
          modelId: "@pool:claude&gpt",
          lines: [line("Claude&GPT·5h", 0, "14:58"), line("Claude&GPT·7d", 0.512, "10-22 12:07")],
        },
      ],
    },
  });
  hud.renderStatus(ctx);
  const w = mainWidget(calls);
  assert.strictEqual(w[1].length, 2, "仍是两行（多窗口压在第 2 行）");
  assert.ok(w[1][1].includes("5h") && w[1][1].includes("7d"), "第 2 行应含 5h 与 7d：" + w[1][1]);
  assert.ok(!w[1][1].includes("Gemini·5h"), "应只显示匹配当前模型的池：" + w[1][1]);
  ok("agy-cli 双窗收窄：\n      " + w[1].join("\n      ⏎ "));
}

// ── 场景 3：无额度数据 → 只留第 1 行 ────────────────────────────────────
{
  const { ctx, calls } = mkCtx(flash);
  hud.cache.clear();
  hud.renderStatus(ctx);
  const w = mainWidget(calls);
  assert.strictEqual(w[1].length, 1, "无额度时应只有 1 行，实得 " + JSON.stringify(w[1]));
  assert.ok(w[1][0].includes("ctx"), "剩下的那行仍应含 ctx");
  ok("无额度数据降级为单行：" + w[1][0]);
}

// ── 场景 4：连续两次渲染不叠加、不残留 ──────────────────────────────────
{
  const { ctx, calls } = mkCtx(flash);
  hud.cache.clear();
  hud.cache.set("magpie:workbuddy", {
    at: Date.now(),
    result: { groups: [{ lines: [line("Credits", 0.2, "100 / 700")] }] },
  });
  hud.renderStatus(ctx);
  hud.renderStatus(ctx);
  const mains = calls.widget.filter(([k, v]) => k === "pi-hud" && Array.isArray(v));
  assert.strictEqual(mains.length, 2, "每次渲染都应整组重发");
  assert.deepStrictEqual(mains[0][1], mains[1][1], "两次渲染内容应一致，不能叠加");
  ok("重复渲染幂等（整组替换，无叠加）");
}

// ── 场景 5：ttft / tokens/s 并进第一行（不再占 pi footer 的一行）────────────
{
  const { ctx, calls } = mkCtx(flash);
  hud.cache.clear();
  hud.pushSpeedSample({ ttft: 700, tps: 99.2, out: 150 });
  hud.renderStatus(ctx);
  const w = mainWidget(calls);
  assert.ok(w[1][0].includes("ctx"), "第 1 行应有 ctx：" + w[1][0]);
  assert.ok(w[1][0].includes("ttft 0.7s"), "第 1 行应有 ttft：" + w[1][0]);
  assert.ok(w[1][0].includes("99.2 tokens/s"), "第 1 行应有 tokens/s（不写 t/s）：" + w[1][0]);
  assert.ok(
    !calls.status.some(([k, v]) => k === "pi-hud-speed" && v),
    "v8 不再往 footer 追加速度行",
  );
  ok("ctx + 速度同一行：" + w[1][0]);
}

console.log(`\n✓ pi-hud v8 布局验收 ${pass}/5 通过`);
