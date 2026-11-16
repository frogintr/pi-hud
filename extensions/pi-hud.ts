// Quota HUD — 多订阅 provider 限额统一显示（pi 扩展）
// 行顺序（用户定稿）：provider-model · ctx · 5h · 7d（无该字段的池不显示）
// 口径：实心条/百分比 = 已使用；reset = 本地时区，5h 类同日只写 HH:mm，7d 类同日也写 MM-DD
// 源（可插拔）：
//   magpie → 本地 magpie 网关 (3425) /v1/magpie/quotas —— 次级 vendor 的额度查询
//     全部外包给 magpie，pi 不直连 vendor 的 usage/reset 接口。
//     vendor 由 pi model id 的前缀决定（与 magpie provider 字段同名）；
//     窗口名自适应："5 hours"/"7 days"/"<pool> · N hours"/余额型 "Credits"
//   openai-codex → chatgpt.com wham/usage（按实际窗口识别 5h / 7d；Pro 可能仅有 7d）
//   claude → api.anthropic.com usage_report（Pro/Max：5h + 7d；需 /login claude）
//   grok → cli-chat-proxy.grok.com billing（SuperGrok：WEEKLY）
//   openrouter → /v1/credits 余额消耗（非 5h/7d 窗）
//   kimi-coding → api.kimi.com /coding/v1/usages（Kimi Code 订阅：5h + 7d 双窗；
//     OAuth 刷新走 auth.kimi.com，refresh token 会轮换 → 立即回写 auth.json，同 xAI）
//   ttft / t/s → 不连网，由 pi 的 before_provider_request / message_update / message_end 实测
//
// 环境变量（都可选）：
//   PI_HUD_MAGPIE_URL     magpie 的 quotas 端点（默认 http://127.0.0.1:3425/v1/magpie/quotas）
//   PI_HUD_REFRESH_MS     额度轮询间隔（默认 60000）
//   PI_HUD_WIDTH          widget 每行最大列数（默认 min(终端宽-4, 96)）
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** 读环境变量（测试沙箱里可能没有 process.env）。 */
function env(name: string): string | undefined {
  try {
    const v = (globalThis as any)?.process?.env?.[name];
    return typeof v === "string" && v !== "" ? v : undefined;
  } catch {
    return undefined;
  }
}

function envInt(name: string, fallback: number): number {
  const n = Number(env(name));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const MAGPIE_QUOTA_URL = env("PI_HUD_MAGPIE_URL") ?? "http://127.0.0.1:3425/v1/magpie/quotas";
const REFRESH_MS = envInt("PI_HUD_REFRESH_MS", 60_000);
const EXTERNAL_TTL_MS = 5 * 60_000;
/** widget 里额度行的宽度上限：再宽也只是把不同窗口挤一行，不好读 */
const QUOTA_LINE_MAX = 96;
const AUTH_FILE = path.join(homedir(), ".pi", "agent", "auth.json");

/** hold 级别：只留给真故障（凭证失效等），不用于额度充裕度。
 *  注意 magpie 的 holdsWhy **不是**故障/告警信号，见 fetchMagpieQuota 里的说明。 */
interface HoldMark {
  level: "alert" | "info";
  text: string;
}

interface PoolLine {
  label: string; // "5h" / "7d"
  used?: number; // 0..1，已使用（上游不提供占比时缺省）
  /** 余额型窗口的直接读数（magpie 的 display，如 "5.81 / 2309"）。
   *  有值时用它替掉百分比：百分比对积分账本没有意义。 */
  value?: string;
  reset: string; // 格式化 reset（无重置时刻时为空串）
  /** 真故障标记（凭证失效等），绘制时按级别着色。 */
  hold?: HoldMark;
}
interface ModelGroup {
  modelId?: string; // 有值时仅在该模型激活时显示
  lines: PoolLine[];
}
interface SourceResult {
  groups: ModelGroup[];
}

let cache = new Map<string, { at: number; result: SourceResult | null }>();
let lastCtx: any = null;
let widgetShown = false; // 额度 widget 当前是否有行（reload 时决定是否要清）
let timer: ReturnType<typeof setInterval> | undefined;
let shuttingDown = false; // reload/quit 后旧实例停摆标志

function readAuth(): Record<string, any> {
  try {
    return JSON.parse(readFileSync(AUTH_FILE, "utf8"));
  } catch {
    return {};
  }
}

// OAuth 刷新端点（HUD 独立换新 access token，不依赖 pi 的惰性刷新）
const OAUTH_REFRESH: Record<string, { endpoint: string; clientId: string }> = {
  xai: { endpoint: "https://auth.x.ai/oauth2/token", clientId: "b1a00492-073a-47ea-816f-4c329264a828" },
  "kimi-coding": {
    endpoint: "https://auth.kimi.com/api/oauth/token",
    clientId: "17e5f671-d194-4dfb-9706-5516cb48c098",
  },
};
const freshTokens = new Map<string, { access: string; at: number; expiresAt: number }>();

/** xAI 官方 CLI 的登录（`~/.grok/auth.json`，客户端 id 与 pi 相同）。
 *  **只读**：grok CLI 自己会刷新它的 token；HUD 在这里刷新会把 CLI 轮换掉的
 *  refresh token 写乱，反而把它登出。所以只在 pi 的 auth.json 不可用时借用。 */
function grokCliToken(): string | null {
  try {
    const raw = readFileSync(path.join(homedir(), ".grok", "auth.json"), "utf8");
    const entries: Record<string, any> = JSON.parse(raw);
    for (const [key, val] of Object.entries(entries)) {
      if (!key.includes("auth.x.ai")) continue;
      const token = typeof val?.key === "string" ? val.key : "";
      if (!token) continue;
      try {
        const claims = decodeJwtPayload(token);
        if (claims?.exp && claims.exp * 1000 < Date.now() + 120_000) continue; // 已过期，别拿去撞 401
      } catch {
        /* 解不开就照用，交给调用方判断 */
      }
      return token;
    }
  } catch {
    /* 没装 grok CLI / 没登录 */
  }
  return null;
}

/** 拿可用 access token：未过期直接用；过期则用 refresh token 换新（并回写 auth.json，xAI 会轮换 refresh） */
async function getAccessToken(providerId: string): Promise<string | null> {
  const cached = freshTokens.get(providerId);
  // 按实际过期时间缓存（kimi access 仅 15 分钟寿命，不能固定 50 分钟）
  if (cached && Date.now() < cached.expiresAt - 120_000) return cached.access;
  const auth = readAuth()[providerId];
  const usable = auth?.type === "oauth" && auth.access ? String(auth.access) : "";
  if (usable) {
    // JWT 未过期就直接用，避免无谓刷新
    try {
      const claims = decodeJwtPayload(usable);
      if (claims?.exp && claims.exp * 1000 > Date.now() + 120_000) return usable;
    } catch {
      /* 解不开 → 当过期处理 */
    }
  }
  const conf = OAUTH_REFRESH[providerId];
  if (!usable || !conf || !auth?.refresh) {
    // pi 这边没有可用凭据：xAI 可以借用官方 CLI 的登录（同一账号、同一 client id）
    if (providerId === "xai") return grokCliToken() ?? (usable || null);
    return usable || null;
  }
  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: auth.refresh,
      client_id: conf.clientId,
    });
    const r = await fetch(conf.endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return (providerId === "xai" ? grokCliToken() : null) ?? usable;
    const d: any = await r.json();
    if (!d.access_token) return (providerId === "xai" ? grokCliToken() : null) ?? usable;
    const expiresAt = Date.now() + (typeof d.expires_in === "number" ? d.expires_in : 3000) * 1000;
    freshTokens.set(providerId, { access: d.access_token, at: Date.now(), expiresAt });
    // xAI 轮换 refresh token，必须回写，否则 pi 自己的刷新链路会断
    try {
      const all = readAuth();
      const ent = all[providerId] ?? {};
      all[providerId] = {
        ...ent,
        access: d.access_token,
        ...(d.refresh_token ? { refresh: d.refresh_token } : {}),
        ...(d.expires_in ? { expires: Date.now() + d.expires_in * 1000 } : {}),
      };
      writeFileSync(AUTH_FILE, JSON.stringify(all, null, 1));
    } catch {
      /* 回写失败不影响本次使用 */
    }
    return d.access_token;
  } catch {
    return (providerId === "xai" ? grokCliToken() : null) ?? usable;
  }
}

function decodeJwtPayload(jwt: string): any {
  try {
    const part = jwt.split(".")[1];
    return JSON.parse(
      Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    );
  } catch {
    return {};
  }
}

function bar(used: number, width = 7): string {
  const clamped = Math.max(0, Math.min(1, used));
  const filled = Math.round(clamped * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** 用量百分比 → 配色档位。阈值对齐 Claude-HUD 的直观习惯：
 *   <50%   安全  绿（主题 success）
 *   50–80% 注意  橙（主题 warning）
 *   ≥80%   告急  红（主题 error）
 * 用主题 token 而非硬编码 ANSI，跟随用户的 theme 自动适配。 */
function usageToken(used: number): "success" | "warning" | "error" {
  const u = Math.max(0, Math.min(1, used));
  if (u >= 0.8) return "error";
  if (u >= 0.5) return "warning";
  return "success";
}

/** 把文本着色。theme 不可用（print/JSON 模式、异常）时原样返回，不抛。 */
function paint(theme: any, used: number, text: string): string {
  try {
    if (!theme?.fg) return text;
    return theme.fg(usageToken(used), text);
  } catch {
    return text;
  }
}

function pct(used: number): string {
  return `${(Math.max(0, Math.min(1, used)) * 100).toFixed(1)}%`;
}

/** 壁钟分量。utc8=true 时按固定 UTC+8（不跟宿主时区；这台机器是 UTC）。 */
function wallClock(input: Date, utc8: boolean): { y: number; m: number; d: number; hh: number; mi: number } {
  const d = utc8 ? new Date(input.getTime() + 8 * 3_600_000) : input;
  if (utc8) {
    return {
      y: d.getUTCFullYear(),
      m: d.getUTCMonth() + 1,
      d: d.getUTCDate(),
      hh: d.getUTCHours(),
      mi: d.getUTCMinutes(),
    };
  }
  return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), hh: d.getHours(), mi: d.getMinutes() };
}

/** reset 格式化：longWindow=true 同日也写 MM-DD；false 同日只写 HH:mm。utc8 仅 xAI 7d 使用。 */
function fmtReset(input: string | number | undefined, longWindow: boolean, utc8 = false): string {
  if (input == null) return "?";
  const raw = typeof input === "number" ? new Date(input) : new Date(input);
  if (Number.isNaN(raw.getTime())) return "?";
  const d = wallClock(raw, utc8);
  const now = wallClock(new Date(), utc8);
  const sameDay = d.y === now.y && d.m === now.m && d.d === now.d;
  const hh = String(d.hh).padStart(2, "0");
  const mi = String(d.mi).padStart(2, "0");
  if (!longWindow && sameDay) return `${hh}:${mi}`;
  const mm = String(d.m).padStart(2, "0");
  const dd = String(d.d).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}

// ── magpie（聚合网关：多次级 vendor，结构各家不同，全部数据驱动） ─────
/** pi model id → magpie vendor（两者同名，取 id 前缀） */
function magpieVendorOf(modelId: string): string {
  const id = String(modelId ?? "");
  return id.includes("/") ? id.split("/")[0] : "";
}

/** 窗口名归一化。实测三家形状不同：
 *  "5 hours"                → label "5h"
 *  "7 days"                 → label "7d"
 *  "Gemini · 5 hours"       → label "Gemini·5h"（带 pool 前缀，防多池重名）
 *  "Claude & GPT · 7 days"  → label "Claude&GPT·7d"
 *  "Credits"                → label "Credits"（余额型，无时长）
 * 认得的一律归一化，认不出的原样保留 → 未来 vendor 自动兜底，不崩不漏行。 */
function magpieWindowName(name: unknown): { label: string; pool?: string; long: boolean } {
  const raw = String(name ?? "").trim();
  const m = raw.match(/^(?:(.+?)\s*·\s*)?(\d+)\s*(hours?|days?)$/i);
  if (m) {
    const rawPool = m[1]?.trim();
    // 压缩 "Claude & GPT" → "Claude&GPT"：状态栏宽度有限
    const pool = rawPool?.replace(/\s*[&/+]\s*/g, (s) => s.trim()) || undefined;
    const long = /^d/i.test(m[3]);
    const short = `${m[2]}${long ? "d" : "h"}`;
    return { label: pool ? `${pool}·${short}` : short, pool: rawPool, long };
  }
  return { label: raw || "?", pool: undefined, long: false };
}

/** 池归属当前模型？"Claude & GPT" 拆成 claude/gpt 两个 token，任一命中即可。
 *  命中 → 只显示该池（AGY 一个订阅出 4 行，必须收窄到 2 行）。 */
function poolMatchesModel(pool: string | undefined, modelId: string): boolean {
  if (!pool) return false;
  const id = String(modelId ?? "").toLowerCase();
  return pool.toLowerCase().split(/[&/+]/).map((t) => t.trim()).filter(Boolean)
    .some((token) => id.includes(token));
}

/** 5h 排 7d 前，其余（余额型）保持原始顺序 */
function magpieLabelRank(label: string): number {
  if (/·5h$|^5h$/.test(label)) return 0;
  if (/·7d$|^7d$/.test(label)) return 1;
  return 2;
}

async function sourceMagpie(modelId: string): Promise<SourceResult | null> {
  const vendor = magpieVendorOf(modelId);
  if (!vendor) return null;
  // magpie 是长驻本地网关，重启/升级时会短暂 ECONNREFUSED；单源失败必须静默降级，
  // 不能让异常冒到 refreshAll 的 Promise.all 里（那会导致本轮所有源都不刷新）
  try {
    return await fetchMagpieQuota(vendor);
  } catch {
    return null;
  }
}

/** 拉该 vendor 的全部窗口，不做模型级收窄。
 *  收窄必须留到 renderStatus：AGY 一个 vendor 含 Gemini / Claude&GPT 两个池，
 *  若在这里按 model 过滤再入缓存，同 vendor 内切模型会复用上一个模型的池。
 *  每个 pool 携带一个 modelId 分组，交给 renderStatus 现有的组优先匹配逻辑。 */
async function fetchMagpieQuota(vendor: string): Promise<SourceResult | null> {
  const res = await fetch(MAGPIE_QUOTA_URL, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  const data: any = await res.json();
  // ?provider= 过滤参数实测不生效，客户端按 provider 字段过滤
  const account = (Array.isArray(data?.data) ? data.data : [])
    .find((a: any) => a?.provider === vendor);
  if (!account) return null;
  const windows: any[] = Array.isArray(account.windows) ? account.windows : [];

  // 若 vendor 报错且没有可用窗口（如 WorkBuddy 5.6+ 桌面 token 加密封存、登录失效等），
  // 必须显式展示错误，绝不能返回 null 静默吞掉，否则用户会误以为 HUD 插件没加载
  if (account.error && windows.length === 0) {
    const rawErr = String(account.error);
    const shortErr = rawErr.includes("encrypted")
      ? "token sealed · 需浏览器登录: magpie accounts add workbuddy"
      : rawErr.length > 45 ? rawErr.slice(0, 42) + "..." : rawErr;
    return {
      groups: [{
        lines: [{
          label: "status",
          reset: shortErr,
          hold: { level: "alert", text: "auth" }
        }]
      }]
    };
  }

  /** 某行的 limit 恰好等于同单位其它两行（或更多）的 limit 之和时，它是这些行的合计。
   *  WorkBuddy 的 Total credits = Credits + Extra credits；magpie 自己也把这几个当
   *  「同一口额度的分池」（internal/provider/credits_daily.go 的 poolsOfWhole）。
   *  状态栏只留明细，否则同一笔额度报三遍。 */
  const limitOf = (w: any): number | undefined => {
    const n = w?.limit;
    return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const isAggregate = (w: any): boolean => {
    const unit = String(w?.unit ?? "");
    let sum = 0;
    let n = 0;
    for (const o of windows) {
      if (o === w || String(o?.unit ?? "") !== unit) continue;
      const l = limitOf(o);
      if (!l) continue;
      sum += l;
      n += 1;
    }
    // 同单位明细不足两行 → 不可能是它们的合计
    if (n < 2) return false;
    const limit = limitOf(w);
    if (limit && Math.abs(sum - limit) <= Math.max(0.5, limit * 0.005)) return true;
    // 对不上账也兜底：名字写 Total、同单位还有至少两行明细 → 它就是那些明细的合计
    return /^total\b/i.test(String(w?.name ?? "").trim());
  };

  const toLine = (p: any): PoolLine | null => {
    const used = typeof p.w.used === "number" && Number.isFinite(p.w.used) ? p.w.used / 100 : undefined;
    // 余额型窗口（积分/额度账本）：magpie 直接给刻度读数（display，如 "5.81 / 2309"）。
    // 百分比对这种账本没意义：只用了 0.1% 与「只剩 5.81」并排出现，读起来自相矛盾。
    const value = typeof p.w.display === "string" && p.w.display.trim() ? p.w.display.trim() : undefined;
    // 既没有重置时刻、也没有读数 → 这行说不出任何有用的话（曾渲染成 "Extra usage ░ 0.0% ?"）
    if (!p.w.resetsAt && !value) return null;
    const reset = p.w.resetsAt ? fmtReset(p.w.resetsAt, p.long) : "";
    // holdsWhy 一律不渲染。它**不是**告警，而是 magpie 对「这个窗口整窗到底有多少额度」
    // 的估算置信度说明（internal/provider/window_holds.go，字段注释就叫
    // "Why a window's whole isn't told"）：
    //   low     —— 本窗口只用了不到 5%，样本太粗，推不出整窗总量
    //   clock   —— 不知道它的重置时刻，也就不知道它何时开始
    //   log     —— 它开始于 magpie 的请求日志之前，有些调用没看到
    //   none    —— magpie 在这个窗口里还没路由过调用
    //   credits —— 窗口里的某次调用可能用的是积分/额外额度
    // magpie 自己的 GUI 把它渲染成灰色小字 "Whole: not enough data" + tooltip。
    // 状态栏没有 tooltip，任何 ⚠️ 都会被读成「额度要没了」，所以这里不显示。
    const base: PoolLine = { label: p.label, reset };
    if (used != null) base.used = used;
    if (value) base.value = value;
    return base;
  };

  const parsed = windows.filter((w) => !isAggregate(w)).map((w) => ({ w, ...magpieWindowName(w?.name) }));
  // 无 pool 的窗口（kimi 裸 5h/7d、grok 裸 7d、workbuddy Credits）归一个"订阅级"组
  const groups: ModelGroup[] = [];
  const plain = parsed.filter((p) => !p.pool)
    .map(toLine).filter((l): l is PoolLine => l != null);
  if (plain.length > 0) {
    plain.sort((a, b) => magpieLabelRank(a.label) - magpieLabelRank(b.label));
    groups.push({ lines: plain });
  }
  // 每个 pool 单独一组，modelId 存成池的 token，供 renderStatus 匹配
  const pools = [...new Set(parsed.filter((p) => p.pool).map((p) => p.pool as string))];
  for (const pool of pools) {
    const lines = parsed.filter((p) => p.pool === pool)
      .map(toLine).filter((l): l is PoolLine => l != null);
    if (lines.length === 0) continue;
    lines.sort((a, b) => magpieLabelRank(a.label) - magpieLabelRank(b.label));
    groups.push({ modelId: `@pool:${pool}`, lines });
  }
  return groups.length > 0 ? { groups } : null;
}

/** SuperGrok weekly 已用比。优先 creditUsagePercent；缺字段时用 GrokBuild，再缺则按 proto3 省略 0 处理。 */
function grokWeeklyUsed(config: any): number | null {
  if (typeof config?.creditUsagePercent === "number") return config.creditUsagePercent / 100;
  const products: any[] = Array.isArray(config?.productUsage) ? config.productUsage : [];
  // 产品名随订阅套餐变：GrokBuild（旧） / GrokBot（Grok + X 混合额度）
  const pool = products.find((p) => typeof p?.usagePercent === "number" &&
    /^(GrokBuild|GrokBot)$/i.test(String(p.product ?? "")));
  if (pool) return pool.usagePercent / 100;
  const period = String(config?.currentPeriod?.type ?? "");
  if (period.includes("WEEKLY")) return 0;
  return null;
}

// ── openai-codex（ChatGPT 订阅） ──────────────────────────────────────────────────────────────────────
/** wham 当前用 rate_limit；primary 不一定是 5h，Pro 的唯一主窗可能是 7d。 */
function codexUsageLines(data: any, now = Date.now()): PoolLine[] {
  const rl = data?.rate_limit ?? data?.rate_limits ?? data;
  const windows: Array<[any, string]> = [
    [rl?.primary_window ?? rl?.primary, "5h"],
    [rl?.secondary_window ?? rl?.secondary, "7d"],
  ];
  const lines: PoolLine[] = [];
  for (const [window, fallbackLabel] of windows) {
    if (!window) continue;
    const used = typeof window.used_percent === "number"
      ? window.used_percent / 100
      : window.utilization;
    if (typeof used !== "number" || !Number.isFinite(used)) continue;
    const seconds = window.limit_window_seconds;
    // 缺时长时兼容旧响应；已知但不支持的时长不冒充 5h/7d。
    const label = seconds == null ? fallbackLabel
      : seconds === 18_000 ? "5h" : seconds === 604_800 ? "7d" : null;
    if (!label) continue;
    let resetAt: string | number | undefined = window.reset_at;
    // Unix 秒 → 毫秒；也兼容毫秒时间戳和 ISO 字符串。
    if (typeof resetAt === "number") {
      resetAt = Number.isFinite(resetAt)
        ? (resetAt < 1e12 ? resetAt * 1000 : resetAt) : undefined;
    }
    if (resetAt == null && typeof window.reset_after_seconds === "number" &&
        Number.isFinite(window.reset_after_seconds)) {
      resetAt = now + window.reset_after_seconds * 1000;
    }
    lines.push({ label, used, reset: fmtReset(resetAt, label === "7d") });
  }
  return lines.sort((a, b) => (a.label === "5h" ? 0 : 1) - (b.label === "5h" ? 0 : 1));
}

async function sourceCodex(): Promise<SourceResult | null> {
  const auth = readAuth()["openai-codex"];
  if (auth?.type !== "oauth" || !auth.access) return null;
  // 使用 Pi 自身的认证链（含锁与 token 回写），不另起 HUD OAuth 刷新器。
  const registry = lastCtx?.modelRegistry;
  const access = typeof registry?.getApiKeyForProvider === "function"
    ? await registry.getApiKeyForProvider("openai-codex") : auth.access;
  if (!access) {
    return { groups: [{ lines: [{ label: "7d", reset: "授权不可用 — /login openai-codex" }] }] };
  }
  const claims = decodeJwtPayload(access);
  const accountId = claims?.["https://api.openai.com/auth"]?.chatgpt_account_id ?? auth.accountId;
  const headers: Record<string, string> = {
    authorization: `Bearer ${access}`,
    accept: "application/json",
  };
  if (accountId) headers["chatgpt-account-id"] = accountId;
  const res = await fetch("https://chatgpt.com/backend-api/wham/usage", {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 401 || res.status === 403) {
    return { groups: [{ lines: [{ label: "7d", reset: "授权不可用 — /login openai-codex" }] }] };
  }
  if (!res.ok) return null;
  const lines = codexUsageLines(await res.json());
  return lines.length > 0 ? { groups: [{ lines }] } : null;
}

// ── claude（Pro/Max 订阅） ─────────────────────────────────────────────
async function sourceClaude(): Promise<SourceResult | null> {
  const auth = readAuth()["claude"];
  if (auth?.type !== "oauth" || !auth.access) return null;
  const res = await fetch(
    "https://api.anthropic.com/v1/organizations/usage_report/messages?model=claude",
    {
      headers: {
        authorization: `Bearer ${auth.access}`,
        "anthropic-beta": "oauth-2025-04-04",
      },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!res.ok) return null;
  const data: any = await res.json();
  const lines: PoolLine[] = [];
  const five = Array.isArray(data.five_hour) ? data.five_hour[data.five_hour.length - 1] : null;
  const seven = Array.isArray(data.seven_day) ? data.seven_day[data.seven_day.length - 1] : null;
  if (five?.utilization != null) {
    lines.push({ label: "5h", used: five.utilization, reset: fmtReset(five.resets_at, false) });
  }
  if (seven?.utilization != null) {
    lines.push({ label: "7d", used: seven.utilization, reset: fmtReset(seven.resets_at, true) });
  }
  return lines.length > 0 ? { groups: [{ lines }] } : null;
}

// ── grok（xAI SuperGrok：WEEKLY = 7d 类） ─────────────────────────────
async function sourceGrok(): Promise<SourceResult | null> {
  const access = await getAccessToken("xai");
  if (!access) return null;
  const res = await fetch("https://cli-chat-proxy.grok.com/v1/billing?format=credits", {
    headers: { authorization: `Bearer ${access}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 401) {
    // token 过期：pi 仅在实际使用 xai 模型时刷新，提示用户而非静默隐藏
    return {
      groups: [
        {
          lines: [
            {
              label: "7d",
              reset: "token 过期 — /login xai 或跑一轮 xai 模型刷新",
            },
          ],
        },
      ],
    };
  }
  if (!res.ok) return null;
  const data: any = await res.json();
  const config = data?.config;
  if (!config) return null;
  const used = grokWeeklyUsed(config);
  if (used == null) return null;
  const reset = config.currentPeriod?.end ?? config.billingPeriodEnd ?? undefined;
  return { groups: [{ lines: [{ label: "7d", used, reset: fmtReset(reset, true, true) }] }] };
}

// ── openrouter（API 计费，无 5h/7d；显示余额消耗） ─────────────────────
async function sourceOpenRouter(): Promise<SourceResult | null> {
  const key = readAuth()["openrouter"]?.key;
  if (!key) return null;
  const res = await fetch("https://openrouter.ai/api/v1/credits", {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const data: any = await res.json();
  const total = data?.data?.total_credits;
  const used = data?.data?.total_usage;
  if (typeof total !== "number" || typeof used !== "number" || total <= 0) return null;
  return {
    groups: [
      {
        lines: [
          {
            label: "credits",
            used: used / total,
            reset: `$${(total - used).toFixed(2)} / $${total.toFixed(2)}`,
          },
        ],
      },
    ],
  };
}

// ── kimi-coding（Kimi Code 订阅：5h + 7d 双窗，used_ratio 直接可用） ──
async function sourceKimi(): Promise<SourceResult | null> {
  const access = await getAccessToken("kimi-coding");
  if (!access) return null;
  const res = await fetch("https://api.kimi.com/coding/v1/usages", {
    headers: { authorization: `Bearer ${access}`, accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 401 || res.status === 403) {
    // token 过期：pi 仅在实际使用 kimi 模型时刷新，提示用户而非静默隐藏
    return {
      groups: [
        {
          lines: [
            {
              label: "5h",
              reset: "token 过期 — /login kimi-coding 或跑一轮 kimi 模型刷新",
            },
          ],
        },
      ],
    };
  }
  if (!res.ok) return null;
  const data: any = await res.json();
  const u = data?.usages ?? {};
  const lines: PoolLine[] = [];
  if (typeof u.limit_5h?.used_ratio === "number") {
    lines.push({ label: "5h", used: u.limit_5h.used_ratio, reset: fmtReset(u.limit_5h.reset_time, false) });
  }
  if (typeof u.limit_7d?.used_ratio === "number") {
    lines.push({ label: "7d", used: u.limit_7d.used_ratio, reset: fmtReset(u.limit_7d.reset_time, true) });
  }
  return lines.length > 0 ? { groups: [{ lines }] } : null;
}

const SOURCES: Array<{ id: string; fetch: (modelId: string) => Promise<SourceResult | null> }> = [
  // magpie 是聚合网关，需按当前 model id 的前缀选次级 vendor
  // （Antigravity 的额度/reset 查询已完全外包给 magpie，不在此处直连）
  { id: "magpie", fetch: (modelId) => sourceMagpie(modelId) },
  { id: "codex", fetch: () => sourceCodex() },
  { id: "claude", fetch: () => sourceClaude() },
  { id: "grok", fetch: () => sourceGrok() },
  { id: "openrouter", fetch: () => sourceOpenRouter() },
  { id: "kimi", fetch: () => sourceKimi() },
];

// 进程级兜底：未捕获的 rejection/异常落盘（防 /reload 时把整个 pi 带崩），同时留取证
const G = globalThis as any;
if (!G.__quotaHudHandlersInstalled) {
  G.__quotaHudHandlersInstalled = true;
  const errLog = path.join(path.dirname(AUTH_FILE), "extensions", "quota-hud-errors.log");
  const writeErr = (kind: string, err: unknown) => {
    try {
      const line = `[${new Date().toISOString()}] ${kind}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`;
      appendFileSync(errLog, line, "utf8");
    } catch {
      /* ignore */
    }
  };
  process.on("unhandledRejection", (err) => writeErr("unhandledRejection", err));
  process.on("uncaughtException", (err) => writeErr("uncaughtException", err));
}

/** pi provider id → HUD source id */
const PROVIDER_TO_SOURCE: Record<string, string> = {
  // 次级 vendor 经 magpie 网关，不再有 antigravity 直连源
  "openai-codex": "codex",
  claude: "claude",
  xai: "grok",
  zai: "openrouter",
  openrouter: "openrouter",
  "kimi-coding": "kimi",
  // magpie → 聚合源（次级 vendor 由 model id 前缀决定，见 sourceMagpie）
  magpie: "magpie",
};

// ── 上下文占用：官方 ctx.getContextUsage()，回退手扫 entries ───────────
// 分母 = contextWindow - maxTokens（剔除 output/thinking 预留，才是标准可用的对话上下文）
function contextLine(ctx: any): PoolLine | null {
  const model = ctx?.model;
  const rawWindow = model?.contextWindow ?? 0;
  const maxOut = model?.maxTokens ?? 0;
  const window = rawWindow > 0 ? Math.max(rawWindow - maxOut, 1) : 0;
  try {
    const usage = ctx?.getContextUsage?.();
    if (usage && usage.tokens > 0) {
      const w = usage.contextWindow ?? window;
      if (w > 0) {
        return { label: "ctx", used: usage.tokens / w, reset: `(${fmtTokens(usage.tokens)}/${fmtTokens(w)})` };
      }
    }
  } catch {
    /* fall through */
  }
  try {
    const entries: any[] = ctx?.sessionManager?.getEntries?.() ?? [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const msg = entries[i]?.message;
      if (msg?.role === "assistant" && msg.usage) {
        const u = msg.usage;
        const tokens = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) + (u.output ?? 0);
        if (window > 0)
          return { label: "ctx", used: tokens / window, reset: `(${fmtTokens(tokens)}/${fmtTokens(window)})` };
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

// ── 排版：按段换行 ──────────────────────────────────────────────
/** 可见列数（去掉 ANSI 颜色码；CJK / emoji 算 2 列）。 */
function visibleWidth(s: string): number {
  const plain = String(s).replace(/\x1b\[[0-9;]*m/g, "");
  let w = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0) ?? 0;
    w += (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f) ||
      (cp >= 0x1f900 && cp <= 0x1f9ff) ? 2 : 1;
  }
  return w;
}

/** widget 可用宽度：pi 把每个 widget 行包在 `Text(line, 1, 0)` 里（左右各 1 列 padding）。
 *  拿不到 TTY 宽度（测试 / RPC）时退到 120。 */
function widgetWidth(): number {
  const forced = envInt("PI_HUD_WIDTH", 0);
  if (forced > 20) return forced;
  const cols = (process as any)?.stdout?.columns;
  const n = typeof cols === "number" && Number.isFinite(cols) && cols > 20 ? cols : 120;
  return Math.max(40, n - 4); // 再留 2 列余量，避免压线时被 Text 二次切断
}

/** 把 quota 各段（" · " 分隔）按宽度换行，**不切断任何一段**。
 *  段内可能有 ANSI 颜色和 "13.0M / ~200M" 这种不许拆的读数。 */
function wrapSegments(segments: string[], width: number): string[] {
  const lines: string[] = [];
  let cur = "";
  let curW = 0;
  for (const seg of segments) {
    const w = visibleWidth(seg);
    const sep = cur ? 3 : 0; // " · "
    if (cur && curW + sep + w > width) {
      lines.push(cur);
      cur = seg;
      curW = w;
    } else {
      cur = cur ? `${cur} · ${seg}` : seg;
      curW += sep + w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

// ── 延迟 / 吞吐（每轮实测，不依赖 provider 上报） ──────────────────────
// 一轮请求的三个时间点都由 pi 的事件拿到，provider 无关：
//   T0 = before_provider_request（请求发出的瞬间）
//   T1 = 第一个增量（text_delta / thinking_delta / toolcall_delta，思维链也算首 token）
//   T2 = message_end
// ttft = T1 - T0（排队 + 预填充 + 首个 token）
// tps  = 输出 token / (T2 - T1)（不含首 token 等待，才是“生成速度”）
interface SpeedSample { ttft: number; tps?: number; out: number }
const SPEED_KEEP = 5; // 取最近 5 轮均值：单轮抖动大，尤其是工具轮
const SPEED_MIN_OUT = 24; // 工具调用轮只出十几个 token，除出来的 tps 没意义
let inFlight: { start: number; first?: number } | null = null;
let speedSamples: SpeedSample[] = [];

function pushSpeedSample(s: SpeedSample): void {
  if (!Number.isFinite(s.ttft) || s.ttft < 0) return;
  // 输出太短的轮次不参与 tps 均值（ttft 仍然有效，预填充成本与输出长度无关）
  speedSamples.push({ ttft: s.ttft, out: s.out, tps: s.out >= SPEED_MIN_OUT ? s.tps : undefined });
  if (speedSamples.length > SPEED_KEEP) speedSamples.shift();
}

/** 状态栏尾部的速度段：`ttft 0.9s · 42.1 t/s`；没样本时返回 null（不显示）。 */
function speedLine(): string | null {
  if (speedSamples.length === 0) return null;
  const ttft = speedSamples.reduce((s, x) => s + x.ttft, 0) / speedSamples.length;
  const rated = speedSamples.filter((x) => x.tps != null) as Array<SpeedSample & { tps: number }>;
  const tps = rated.length > 0 ? rated.reduce((s, x) => s + x.tps, 0) / rated.length : null;
  const wait = ttft >= 10_000 ? `${Math.round(ttft / 1000)}s` : `${(ttft / 1000).toFixed(1)}s`;
  if (tps == null) return `ttft ${wait}`;
  const rate = tps >= 100 ? tps.toFixed(0) : tps.toFixed(1);
  return `ttft ${wait} · ${rate} t/s`;
}

function lineText(p: PoolLine, theme?: any): string {
  const hold = holdText(p, theme);
  // 有占比 → 进度条 + 读数（余额型用 magpie 的 display 替掉百分比）；
  // 无占比但有读数 → 只写读数。进度条与读数同色，label/reset 保持主题默认色。
  let head = "";
  if (p.used != null) {
    head = paint(theme, p.used, `${bar(p.used, 7)} ${p.value ?? pct(p.used)}`) + " ";
  } else if (p.value) {
    head = `${p.value} `;
  }
  return `${p.label} ${head}${p.reset}`.trimEnd() + hold;
}

/** 渲染 hold 标记（只用于真故障，如凭证失效）。
 *  两档都用 ⚠️（带 VS16 的彩色 emoji，2 列，pi 与终端宽度一致不会重叠），
 *  仅靠主题颜色区分轻重：
 *    alert → error（红）
 *    info  → warning（黄/橙）
 *  theme 不可用时用裸 ⚠️ 与文本。 */
function holdText(p: PoolLine, theme?: any): string {
  if (!p.hold) return "";
  const icon = "\u26a0\ufe0f"; // ⚠️ = U+26A0 + VS16
  const body = `${icon} ${p.hold.text}`;
  try {
    if (!theme?.fg) return ` ${body}`;
    return " " + theme.fg(p.hold.level === "alert" ? "error" : "warning", body);
  } catch {
    return ` ${body}`;
  }
}

// 429 实时覆写：上游不返回占比的池（如 AGY 的 claude 系）在收到 429 后强制显示 100%
const exhaustedOverride = new Map<string, { until: number }>();
function isExhausted(modelId: string): boolean {
  const e = exhaustedOverride.get(modelId);
  if (!e) return false;
  if (Date.now() > e.until) {
    exhaustedOverride.delete(modelId);
    return false;
  }
  return true;
}

function renderStatus(ctx: any) {
  try {
    if (!ctx?.ui?.setStatus) return; // print/JSON 模式无 UI
    const provider = ctx?.model?.provider ?? "";
    const modelId = ctx?.model?.id ?? "";
    const theme = ctx?.ui?.theme; // Theme 实例；不可用时 paint() 原样返回
    const sourceId = PROVIDER_TO_SOURCE[provider];
    // 布局（v6，用户定稿）：第一行 = 模型 + ctx；第二行起 = 额度窗口 5h/7d/Credits/reset。
    // 第一行走状态栏（setStatus）；其余行走编辑器下方的 widget（setWidget，placement:"belowEditor"）。
    // 注意 pi 的 setWidget 是「按 key 整组替换」：同一 key 先删 above 再删 below，
    // 所以 ctx 行的 refresh 绝不能带 lines 调用，否则会把额度行整组清掉。
    const head: string[] = [];
    // 1) provider-model
    head.push(modelId || provider || "ctx");
    // 2) ctx
    const ctxLine = contextLine(ctx);
    if (ctxLine) head.push(lineText(ctxLine, theme));
    // ttft / t/s 不放这里：它走 footer 的扩展状态行（在 pwd 与用量行之后），见下
    // 3) 5h / 7d（模型级组优先匹配；无 modelId 的组=订阅级）
    const parts: string[] = [];
    if (sourceId) {
      // 与 refreshAll 的缓存键保持一致（magpie 按次级 vendor 隔离）
      const cacheKey = sourceId === "magpie"
        ? `${sourceId}:${magpieVendorOf(modelId)}`
        : sourceId;
      const result = cache.get(cacheKey)?.result;
      if (result) {
        // magpie 的池用 "@pool:<name>" 占位 modelId，需按 token 包含匹配；
        // 命不中任何池 → 回退到订阅级组，再不行就把全部池叠上（未来 vendor 兜底）
        const magpieGroup = sourceId === "magpie"
          ? result.groups.find((g) => {
              if (!g.modelId?.startsWith("@pool:")) return false;
              return poolMatchesModel(g.modelId.slice("@pool:".length), modelId);
            })
          : undefined;
        const group =
          magpieGroup ??
          result.groups.find((g) => g.modelId && g.modelId === modelId) ??
          result.groups.find((g) => !g.modelId);
        const renderGroups = group
          ? [group]
          : sourceId === "magpie"
            ? result.groups.filter((g) => g.modelId?.startsWith("@pool:"))
            : [];
        for (const g of renderGroups) {
          for (const p of g.lines) {
            // 429 覆写：上游不返回占比的池，收到 429 后按耗尽渲染
            const override = isExhausted(modelId) && p.used == null;
            const shown: PoolLine = override
              ? { ...p, used: 1 }
              : p;
            parts.push(lineText(shown, theme));
          }
        }
      }
    }
    // 布局（v7）：
    //   第一行：模型 + 上下文占用(ctx)
    //   第二行起：usage 限额。按 " · " 分段换行，一行不超过 ~96 列，
    //            所以 workbuddy 的 Credits / Extra credits 一行、模型 token 窗一行。
    //   ttft / t/s：不进 widget，走 ctx.ui.setStatus（footer 的扩展状态行），
    //             渲染在 pi 自己的 pwd 行与用量行之后，不占 widget 位置。
    const line1 = head.join(" · ");
    const quotaLines = wrapSegments(parts, Math.min(widgetWidth(), envInt("PI_HUD_LINE_WIDTH", QUOTA_LINE_MAX)));
    const widgetLines = [line1, ...quotaLines];
    const speed = speedLine();

    // footer 扩展状态行：pi 会把所有扩展的 setStatus 拼成一行（按 key 排序）。
    // 本机只有 pi-hud 用 status，所以这一行就只有速度。
    try {
      ctx.ui.setStatus?.("pi-hud-speed", speed ?? undefined);
    } catch {
      /* 老版本没有 setStatus */
    }

    if (ctx.ui?.setWidget) {
      // 整组放入 setWidget("pi-hud", [line1, ...quota], placement: "belowEditor")：
      // 上下文行在前，额度行在后，紧贴在输入框下方
      ctx.ui.setWidget("pi-hud", widgetLines, { placement: "belowEditor" });
      ctx.ui.setWidget("pi-hud-quota", undefined); // 清理旧 key
      ctx.ui.setStatus("pi-hud", undefined);       // 清理底栏旧位置，不重复占用
      widgetShown = true;
    } else if (ctx.ui?.setStatus) {
      // 无 setWidget 环境（单测/降级）回退单行
      const flat = [line1, ...quotaLines].filter(Boolean).join(" · ");
      ctx.ui.setStatus("pi-hud", flat ? `${flat}${speed ? ` · ${speed}` : ""}` : undefined);
    }
  } catch {
    /* 渲染失败不影响主流程 */
  }
}

async function refreshAll(ctx: any) {
  if (shuttingDown) return; // reload/quit 后旧实例立即停摆
  lastCtx = ctx ?? lastCtx;
  const now = Date.now();
  let activeSourceId: string | undefined;
  let activeModelId = "";
  try {
    const provider = lastCtx?.model?.provider ?? "";
    activeSourceId = PROVIDER_TO_SOURCE[provider];
    activeModelId = lastCtx?.model?.id ?? "";
  } catch {
    return; // ctx stale（reload/切换后旧实例），不碰它
  }
  await Promise.all(
    SOURCES.map(async (source) => {
      // 只拉当前激活 provider 的源；其余清掉不显示
      if (source.id !== activeSourceId) {
        cache.delete(source.id);
        return;
      }
      // magpie 是聚合源：一个 source id 下藏着多次级 vendor，缓存必须按 vendor 隔离，
      // 否则切模型（agy→workbuddy）后 5 分钟 TTL 内会直接复用上一个 vendor 的额度
      const cacheKey = source.id === "magpie"
        ? `${source.id}:${magpieVendorOf(activeModelId)}`
        : source.id;
      const entry = cache.get(cacheKey);
      if (entry && now - entry.at < EXTERNAL_TTL_MS) return;
      try {
        const result = await source.fetch(activeModelId);
        // null 不入 TTL，避免 weekly 字段瞬时缺失后空白 5 分钟
        if (result == null) cache.delete(cacheKey);
        else cache.set(cacheKey, { at: now, result });
      } catch {
        /* 单源失败静默 */
      }
    }),
  );
  renderStatus(lastCtx);
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    shuttingDown = false;
    lastCtx = ctx;
    // 仅真实 session 启动后轮询；/reload、/quit 时由 shutdown 清理。
    if (!timer) {
      timer = setInterval(() => { void refreshAll(lastCtx); }, REFRESH_MS);
      timer.unref?.();
    }
    await refreshAll(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    lastCtx = ctx;
    await refreshAll(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    await refreshAll(ctx);
  });

  // ── 延迟 / 吞吐：T0 → 首个 delta → message_end ─────────────────────────
  pi.on("before_provider_request", async () => {
    inFlight = { start: Date.now() };
  });

  pi.on("message_update", async (event: any) => {
    if (!inFlight || inFlight.first != null) return;
    // 任何增量都算首 token；只认 *_delta，跳过 start / content_block_start 这类标记
    const kind = String(event?.assistantMessageEvent?.type ?? "");
    if (kind && !kind.endsWith("_delta")) return;
    inFlight.first = Date.now();
  });

  pi.on("message_end", async (event: any, ctx: any) => {
    const msg = event?.message;
    if (msg?.role !== "assistant") return;
    const inflight = inFlight;
    inFlight = null;
    lastCtx = ctx ?? lastCtx;
    if (inflight?.first != null) {
      const out = Number(msg?.usage?.output ?? 0);
      const genMs = Date.now() - inflight.first;
      pushSpeedSample({
        ttft: inflight.first - inflight.start,
        out,
        tps: out >= SPEED_MIN_OUT && genMs >= 200 ? out / (genMs / 1000) : undefined,
      });
    }
    renderStatus(lastCtx);
  });

  // 429 实时捕获：RESOURCE_EXHAUSTED 时把当前模型的池标为耗尽（到 reset 为止）
  pi.on("after_provider_response", async (event: any, ctx) => {
    if (event?.status !== 429) return;
    const modelId = ctx?.model?.id ?? "";
    if (!modelId) return;
    // reset 时间取缓存里该模型的已知 reset；取不到则默认 5h
    let until = Date.now() + 5 * 3_600_000;
    const sourceId = PROVIDER_TO_SOURCE[ctx?.model?.provider ?? ""];
    const result = sourceId ? cache.get(sourceId)?.result : undefined;
    for (const g of result?.groups ?? []) {
      if (g.modelId && g.modelId !== modelId) continue;
      for (const p of g.lines) {
        const t = Date.parse(p.reset.replace(/^(\d{2})-(\d{2}) /, `${new Date().getFullYear()}-`));
        if (Number.isFinite(t) && t > Date.now()) until = t;
      }
    }
    exhaustedOverride.set(modelId, { until });
    renderStatus(ctx);
  });

  pi.on("session_fork", async (_event, ctx) => {
    lastCtx = ctx;
    renderStatus(lastCtx);
  });

  // reload/quit/new/resume/fork 时停掉旧实例的定时器并停摆，
  // 防止 stale ctx 在定时器里反复抛错（pi 官方建议在 session_shutdown 里做 cleanup）
  pi.on("session_shutdown", async (_event) => {
    shuttingDown = true;
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    // /reload 会重建交互层，但同一实例的 widget 可能残留；顺手显式清掉
    if (widgetShown) {
      try {
        lastCtx?.ui?.setWidget?.("pi-hud", undefined);
        lastCtx?.ui?.setWidget?.("pi-hud-quota", undefined);
        lastCtx?.ui?.setStatus?.("pi-hud", undefined);
        lastCtx?.ui?.setStatus?.("pi-hud-speed", undefined);
      } catch {
        /* stale ctx */
      }
      widgetShown = false;
    }
  });

}
