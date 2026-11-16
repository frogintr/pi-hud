// pi-hud magpie 聚合网关测试
// 覆盖：vendor 前缀选择 / 窗口名归一化 / pool 按模型收窄 / 余额型读数 / 合计行收起 / holdsWhy 不渲染 / 未知 vendor 兜底
// 运行：node --test test/pi-hud.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

process.env.TZ = 'UTC';
const HUD = fileURLToPath(new URL('../extensions/pi-hud.ts', import.meta.url));
const NOW = Date.parse('2026-10-21T04:45:00Z');

// 以下 fixture 逐字取自 127.0.0.1:3425/v1/magpie/quotas 的实际响应
const quotas = () => ({
  data: [
    {
      provider: 'workbuddy', name: 'WorkBuddy', kind: 'subscription', plan: 'Free', user: '王迪',
      windows: [
        { name: 'Credits', used: 3.7114285642857143, remaining: 96.28857143571429,
          display: '25.98 / 700', amount: 25.97999995, limit: 700, unit: 'credits', holdsWhy: 'clock' },
        { name: 'Extra credits', used: 0.25, display: '5.81 / 2109', amount: 5.81, limit: 2109, unit: 'credits' },
        { name: 'Total credits', used: 0.2, display: '5.81 / 2809', amount: 5.81, limit: 2809, unit: 'credits', holdsWhy: 'low' },
      ],
    },
    {
      provider: 'agy-cli', name: 'agy-cli', kind: 'subscription', plan: 'Google AI Pro',
      windows: [
        { name: 'Gemini · 7 days', used: 2.8073849999999956, resetsAt: '2026-10-28T02:40:11Z', pool: 'Gemini' },
        { name: 'Gemini · 5 hours', used: 7.325833999999998, resetsAt: '2026-10-21T07:40:11Z', pool: 'Gemini' },
        { name: 'Claude & GPT · 7 days', used: 51.22356, resetsAt: '2026-10-22T12:07:36Z', pool: 'Claude & GPT' },
        { name: 'Claude & GPT · 5 hours', used: 100, resetsAt: '2026-10-21T08:24:46Z', pool: 'Claude & GPT' },
      ],
    },
    {
      provider: 'grok', name: 'Grok', kind: 'subscription', plan: null,
      windows: [{ name: '7 days', used: 100, remaining: 0,
        resetsAt: '2026-10-22T12:29:07.853Z', holdsWhy: 'none' }],
    },
    {
      provider: 'kimi-code-cn', name: 'Kimi Code (China)', kind: 'plan',
      windows: [
        { name: '5 hours', used: 0, resetsAt: '2026-10-21T06:08:23.890904Z' },
        { name: '7 days', used: 7.000000000000001, resetsAt: '2026-10-22T10:08:23.890904Z' },
      ],
    },
  ],
});

const normalized = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const labelsOf = (r) => Array.from(r?.groups?.[0]?.lines ?? [], (l) => l.label);

function loadHud({ fetch: fetcher } = {}) {
  const requests = [];
  const sandbox = {
    Buffer, URLSearchParams, AbortSignal, console, path, homedir,
    Date: class extends Date {
      constructor(...a) { super(...(a.length ? a : [NOW])); }
      static now() { return NOW; }
    },
    readFileSync: () => '{}',
    writeFileSync: () => { throw new Error('Tests must not write credentials'); },
    appendFileSync: () => {},
    process: { on() {} },
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
    fetch: async (url, init) => {
      requests.push({ url, init });
      return fetcher ? fetcher(url, init) : { ok: true, status: 200, json: async () => quotas() };
    },
  };
  const source = stripTypeScriptTypes(readFileSync(HUD, 'utf8'), { mode: 'strip' })
    .replace(/^import .*;\r?\n/gm, '')
    .replace('export default function', 'function install');
  vm.createContext(sandbox);
  vm.runInContext(`${source}
globalThis.t = { sourceMagpie, magpieVendorOf, magpieWindowName, poolMatchesModel, lineText, holdText, usageToken, paint, bar, refreshAll, install, speedLine, pushSpeedSample, wrapSegments, visibleWidth, widgetWidth };`,
  sandbox);
  return { ...sandbox.t, requests };
}

test('vendor 由 model id 前缀决定，与 magpie provider 字段同名', () => {
  const hud = loadHud();
  assert.equal(hud.magpieVendorOf('agy-cli/claude-opus-4-6-thinking'), 'agy-cli');
  assert.equal(hud.magpieVendorOf('workbuddy/glm-5.3-flash'), 'workbuddy');
  assert.equal(hud.magpieVendorOf('kimi-code-cn/k3-256k'), 'kimi-code-cn');
  assert.equal(hud.magpieVendorOf('no-slash'), '', '无前缀 → 空，不误报');
});

test('窗口名归一化覆盖三家形状 + 未知名原样兜底', () => {
  const hud = loadHud();
  assert.deepEqual(normalized(hud.magpieWindowName('5 hours')), { label: '5h', long: false });
  assert.deepEqual(normalized(hud.magpieWindowName('7 days')), { label: '7d', long: true });
  assert.deepEqual(normalized(hud.magpieWindowName('Gemini · 5 hours')), { label: 'Gemini·5h', pool: 'Gemini', long: false });
  assert.deepEqual(normalized(hud.magpieWindowName('Claude & GPT · 7 days')), { label: 'Claude&GPT·7d', pool: 'Claude & GPT', long: true });
  assert.equal(hud.magpieWindowName('Credits').label, 'Credits');
  // 未来 vendor 的未知命名不崩、不漏行
  assert.equal(hud.magpieWindowName('Rolling window').label, 'Rolling window');
  assert.equal(hud.magpieWindowName('').label, '?');
});

test('pool 按当前模型收窄："Claude & GPT" 拆 token 匹配', () => {
  const hud = loadHud();
  assert.equal(hud.poolMatchesModel('Claude & GPT', 'agy-cli/claude-opus-4-6-thinking'), true);
  assert.equal(hud.poolMatchesModel('Claude & GPT', 'agy-cli/gemini-3.8-flash'), false);
  assert.equal(hud.poolMatchesModel('Gemini', 'agy-cli/gemini-3.8-flash'), true);
  assert.equal(hud.poolMatchesModel(undefined, 'anything'), false);
});

test('AGY：网关层返回全部池（两组），同 vendor 切模型不丢数据', async () => {
  const hud = loadHud();
  // 缓存存的是 vendor 全量，收窄交给 renderStatus——否则同 vendor 内切模型会复用旧池
  for (const id of ['agy-cli/claude-opus-4-6-thinking', 'agy-cli/gemini-3.8-flash']) {
    const r = await hud.sourceMagpie(id);
    assert.deepEqual(Array.from(r.groups, (g) => g.modelId).sort(),
      ['@pool:Claude & GPT', '@pool:Gemini'], '两个池都在');
  }
  const opus = await hud.sourceMagpie('agy-cli/claude-opus-4-6-thinking');
  const claudePool = opus.groups.find((g) => g.modelId === '@pool:Claude & GPT');
  assert.deepEqual(normalized(claudePool.lines), [
    { label: 'Claude&GPT·5h', used: 1, reset: '08:24' },
    { label: 'Claude&GPT·7d', used: 51.22356 / 100, reset: '10-22 12:07' },
  ]);
  assert.equal(hud.lineText(claudePool.lines[0]), 'Claude&GPT·5h ███████ 100.0% 08:24');
});

test('渲染层按模型收窄：opus → Claude 池，gemini → Gemini 池', async () => {
  const hud = loadHud();
  const statuses = [];
  const ctx = (id) => ({
    model: { provider: 'magpie', id, contextWindow: 0, maxTokens: 0 },
    ui: { setStatus: (k, v) => statuses.push(v) },
    sessionManager: { getEntries: () => [] },
  });
  for (const [id, want] of [
    ['agy-cli/claude-opus-4-6-thinking', 'Gemini'],
    ['agy-cli/gemini-3.8-flash', 'Claude'],
  ]) {
    statuses.length = 0;
    await hud.refreshAll(ctx(id));
    const line = statuses.at(-1);
    // 断言"不该出现的那一半"已消失
    assert.ok(!line.includes(want), `${id} 不应包含 ${want} 池: ${line}`);
  }
});

test('kimi-code-cn：裸 5h/7d，无 pool 不收窄', async () => {
  const hud = loadHud();
  const r = await hud.sourceMagpie('kimi-code-cn/k3-256k');
  assert.deepEqual(normalized(r.groups[0].lines), [
    { label: '5h', used: 0, reset: '06:08' },
    { label: '7d', used: 7.000000000000001 / 100, reset: '10-22 10:08' },
  ]);
});

test('workbuddy：余额型用 display 读数替掉百分比；合计行收起；holdsWhy 不渲染', async () => {
  const hud = loadHud();
  const r = await hud.sourceMagpie('workbuddy/glm-5.3-flash');
  // Credits(700) + Extra(2309) = Total(2809) → Total 是汇总行，不重复报
  assert.deepEqual(normalized(r.groups[0].lines), [
    { label: 'Credits', used: 3.7114285642857143 / 100, value: '25.98 / 700', reset: '' },
    { label: 'Extra credits', used: 0.0025, value: '5.81 / 2109', reset: '' },
  ]);
  assert.ok(!JSON.stringify(r).includes('clock'), 'holdsWhy 不进渲染数据');
  assert.ok(!JSON.stringify(r).includes('low'), 'holdsWhy 不进渲染数据');
});

test('未接入的 vendor → null，不伪造也不崩', async () => {
  const hud = loadHud();
  assert.equal(await hud.sourceMagpie('cursor/fast'), null);
  assert.equal(await hud.sourceMagpie('zed/inline'), null);
  assert.equal(await hud.sourceMagpie(''), null);
});

test('网关不可达 / 非 200 → null', async () => {
  const down = loadHud({ fetch: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(await down.sourceMagpie('agy-cli/x'), null);
  const err = loadHud({ fetch: async () => ({ ok: false, status: 502, json: async () => ({}) }) });
  assert.equal(await err.sourceMagpie('agy-cli/x'), null);
});

test('命名变化（未来 vendor 带新 pool 全不匹配）→ 退化为显示全部池，不空窗', async () => {
  const hud = loadHud({
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: [{
      provider: 'newvendor', kind: 'plan',
      windows: [
        { name: 'Heavy · 5 hours', used: 20, resetsAt: '2026-10-21T08:00:00Z', pool: 'Heavy' },
        { name: 'Light · 5 hours', used: 50, resetsAt: '2026-10-21T08:00:00Z', pool: 'Light' },
      ],
    }] }) }),
  });
  const r = await hud.sourceMagpie('newvendor/some-model');
  assert.deepEqual(Array.from(r.groups, (g) => g.modelId).sort(), ['@pool:Heavy', '@pool:Light'],
    '两个陌生池都保留在缓存里');
  // 渲染层全都不匹配 → 退化为叠加全部池，不空窗
  const statuses = [];
  await hud.refreshAll({
    model: { provider: 'magpie', id: 'newvendor/some-model', contextWindow: 0, maxTokens: 0 },
    ui: { setStatus: (k, v) => statuses.push(v) },
    sessionManager: { getEntries: () => [] },
  });
  const line = statuses.at(-1);
  assert.ok(line.startsWith('newvendor/some-model · '), line);
  assert.ok(line.includes('Heavy·5h') && line.includes('Light·5h'), '两个池都渲染: ' + line);
});

test('窗口同时缺 used 与 display → 跳过该行，不生成空壳', async () => {
  const hud = loadHud({
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: [{
      provider: 'mystery', kind: 'plan',
      windows: [
        { name: '5 hours' },                                        // 无 used 无 display → skip
        { name: 'Extra usage', used: 0, unit: 'CNY', balance: 0 },   // 无 resetsAt 无 display → skip
        { name: '7 days', used: 33, resetsAt: '2026-10-22T10:00:00Z' }, // 保留
      ],
    }] }) }),
  });
  assert.deepEqual(labelsOf(await hud.sourceMagpie('mystery/m1')), ['7d']);
});

test('只请求本地 3425 的 quotas 端点', async () => {
  const hud = loadHud();
  await hud.sourceMagpie('agy-cli/gemini-3.8-flash');
  assert.equal(hud.requests.length, 1);
  assert.equal(hud.requests[0].url, 'http://127.0.0.1:3425/v1/magpie/quotas');
});

test('grok：仅一个 7d 窗；holdsWhy:"none" 是常态不得当告警', async () => {
  const hud = loadHud();
  const r = await hud.sourceMagpie('grok/grok-4.7-build-fast');
  assert.deepEqual(normalized(r.groups[0].lines), [
    { label: '7d', used: 1, reset: '10-22 12:29' },
  ], '无 ⚠none 后缀');
});

test('holdsWhy 五个取值一律不渲染成告警（它是「整窗额度」的估算置信度，不是额度告警）', async () => {
  const hud = loadHud({
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: [{
      provider: 'v', kind: 'plan',
      windows: [
        { name: '5 hours', used: 10, resetsAt: '2026-10-21T10:00:00Z', holdsWhy: 'LOW' },
        { name: '7 days', used: 5, resetsAt: '2026-10-22T10:00:00Z', holdsWhy: 'NONE' },
        { name: '30 days', used: 1, resetsAt: '2026-10-22T11:00:00Z', holdsWhy: 'clock' },
        { name: '90 days', used: 1, resetsAt: '2026-10-22T12:00:00Z', holdsWhy: 'log' },
        { name: '365 days', used: 1, resetsAt: '2026-10-22T13:00:00Z', holdsWhy: 'credits' },
      ],
    }] }) }),
  });
  const r = await hud.sourceMagpie('v/m');
  const byLabel = Object.fromEntries(r.groups[0].lines.map((l) => [l.label, l]));
  assert.equal(byLabel['5h'].reset, '10:00');
  assert.equal(byLabel['7d'].reset, '10-22 10:00');
  for (const [label, line] of Object.entries(byLabel)) {
    assert.equal(line.hold, undefined, label + ' 不应带 hold');
  }
  assert.ok(!JSON.stringify(r.data ?? r).includes('holdsWhy'), '不把 holdsWhy 传下去');
});

// ── 配色分档（Claude-HUD 风格：<50% 绿 / 50–80% 橙 / ≥80% 红）──────────
test('usageToken 三档阈值：边界值精确', () => {
  const hud = loadHud();
  const t = hud.usageToken;
  assert.equal(t(0), 'success');
  assert.equal(t(0.499), 'success');
  assert.equal(t(0.5), 'warning', '50% 进橙档');
  assert.equal(t(0.799), 'warning');
  assert.equal(t(0.8), 'error', '80% 进红档');
  assert.equal(t(1), 'error');
  // 越界钳制
  assert.equal(t(-1), 'success');
  assert.equal(t(2), 'error');
});

test('lineText 在无 theme 时输出裸文本（不崩、不加转义）', () => {
  const hud = loadHud();
  const line = { label: '7d', used: 0.16, reset: '10-04 12:00' };
  assert.equal(hud.lineText(line), '7d █░░░░░░ 16.0% 10-04 12:00');
  assert.equal(hud.lineText(line, undefined).includes('\x1b'), false);
});

test('lineText 有 theme 时只给进度条+百分比着色，label/reset 保持默认', () => {
  const hud = loadHud();
  const calls = [];
  const theme = { fg: (token, text) => { calls.push({ token, text }); return '[' + token + ']' + text + '[/]'; } };
  const line = { label: '5h', used: 0.85, reset: '08:24' };
  const out = hud.lineText(line, theme);
  assert.equal(calls.length, 1, '只调一次 fg');
  assert.equal(calls[0].token, 'error', '85% → error');
  assert.ok(out.startsWith('5h '), 'label 未着色: ' + out);
  assert.ok(out.endsWith(' 08:24'), 'reset 未着色: ' + out);
  assert.ok(out.includes('[error]'), out);
});

test('paint 在 theme.fg 抛错时降级为原文本', () => {
  const hud = loadHud();
  const out = hud.paint({ fg() { throw new Error('boom'); } }, 0.9, 'XYZ');
  assert.equal(out, 'XYZ');
});

test('holdText：alert 用 error(红)、info 用 warning(黄)，都带 ⚠️', () => {
  const hud = loadHud();
  const calls = [];
  const theme = { fg: (token, text) => { calls.push({ token, text }); return '{' + token + '}'; } };

  const alert = hud.holdText({ label: 'x', reset: '', hold: { level: 'alert', text: 'low' } }, theme);
  assert.equal(calls.at(-1).token, 'error', 'alert → error 红');
  assert.ok(calls.at(-1).text.includes('\u26a0\ufe0f'), '含 ⚠️(VS16): ' + JSON.stringify(calls.at(-1).text));
  assert.ok(calls.at(-1).text.includes('low'));

  const info = hud.holdText({ label: 'x', reset: '', hold: { level: 'info', text: 'clock' } }, theme);
  assert.equal(calls.at(-1).token, 'warning', 'info → warning 黄');
  assert.ok(calls.at(-1).text.includes('clock'));
});

test('holdText：无 hold 返回空串；theme 缺失时输出裸 ⚠️', () => {
  const hud = loadHud();
  assert.equal(hud.holdText({ label: 'x', reset: '' }), '');
  const bare = hud.holdText({ label: 'x', reset: '', hold: { level: 'info', text: 'clock' } });
  assert.equal(bare, ' \u26a0\ufe0f clock');
});

test('lineText：余额型写读数不写百分比；有重置时刻时两者都在', () => {
  const hud = loadHud();
  assert.equal(hud.lineText({ label: 'Extra credits', used: 0.25 / 100, value: '5.81 / 2309', reset: '' }),
    'Extra credits ░░░░░░░ 5.81 / 2309');
  assert.equal(hud.lineText({ label: 'Credits', used: 0, value: '0 / 500', reset: '10-31 15:59' }),
    'Credits ░░░░░░░ 0 / 500 10-31 15:59');
});

test('lineText 末尾追加 hold 标记（真故障才用）', () => {
  const hud = loadHud();
  const theme = { fg: (tok, text) => '{' + tok + '}' };
  const out = hud.lineText(
    { label: 'Credits', used: 0.101, reset: '70.65 / 700', hold: { level: 'info', text: 'clock' } },
    theme,
  );
  assert.ok(out.startsWith('Credits '), out);
  assert.ok(out.includes('{success}'), 'meter 用 success: ' + out);
  assert.ok(out.endsWith('{warning}'), 'hold 用 warning: ' + out);
  assert.ok(!out.includes(' · '), '不该再出现 · 分隔符');
});

// ── 延迟 / 吞吐（TTFT + t/s）──────────────────────────────────────────
test('speedLine：没有样本时不显示', () => {
  const hud = loadHud();
  assert.equal(hud.speedLine(), null);
});

test('speedLine：ttft 与 t/s 取最近几轮均值', () => {
  const hud = loadHud();
  hud.pushSpeedSample({ ttft: 400, tps: 40, out: 300 });
  hud.pushSpeedSample({ ttft: 800, tps: 50, out: 500 });
  assert.equal(hud.speedLine(), 'ttft 0.6s · 45.0 t/s');
});

test('speedLine：输出太短的轮次只贡献 ttft，不进 tps 均值', () => {
  const hud = loadHud();
  hud.pushSpeedSample({ ttft: 600, tps: 999, out: 10 });   // 工具调用轮
  assert.equal(hud.speedLine(), 'ttft 0.6s');
  hud.pushSpeedSample({ ttft: 600, tps: 60, out: 400 });
  assert.equal(hud.speedLine(), 'ttft 0.6s · 60.0 t/s');
});

test('speedLine：只保留最近 5 轮；慢启动/大数值格式化', () => {
  const hud = loadHud();
  for (let i = 0; i < 7; i++) hud.pushSpeedSample({ ttft: 1000 * (i + 1), tps: 100 + i, out: 200 });
  // 只剩 ttft 3s..7s → 均值 5s；tps 102..106 → 104
  assert.equal(hud.speedLine(), 'ttft 5.0s · 104 t/s');
  const slow = loadHud();
  slow.pushSpeedSample({ ttft: 12_400, tps: 20, out: 200 });
  assert.equal(slow.speedLine(), 'ttft 12s · 20.0 t/s');
});

// ── 状态栏排版：按段换行 ───────────────────────────────────────────────
test('visibleWidth：去 ANSI、CJK 算 2 列', () => {
  const hud = loadHud();
  assert.equal(hud.visibleWidth('abc'), 3);
  assert.equal(hud.visibleWidth('[32mabc[0m'), 3);
  assert.equal(hud.visibleWidth('额度'), 4);
});

test('wrapSegments：不切断任何一段，超宽就整段落到下一行', () => {
  const hud = loadHud();
  const segs = [
    'Credits ░░░░░░░ 0 / 500 11-30 15:59',
    'Extra credits ░░░░░░░ 21.38 / 2309',
    'deepseek-v4.1-flash tokens (est.) ░░░░░░░ 13.0M / ~200M 11-17 05:04',
  ];
  const out = hud.wrapSegments(segs, 96);
  assert.equal(out.length, 2, JSON.stringify(out));
  assert.equal(out[0], segs.slice(0, 2).join(' · '));
  assert.equal(out[1], segs[2], '第三段整体换行，不被拆开');
  // 极窄时每段一行，但仍然不拆段内
  assert.deepEqual(normalized(hud.wrapSegments(segs, 20)), segs);
  // 单段就超宽时也不拆（宁可让 Text 自己兜底）
  assert.deepEqual(normalized(hud.wrapSegments([segs[2]], 10)), [segs[2]]);
});

test('wrapSegments：ANSI 段按可见宽度算，不按字节', () => {
  const hud = loadHud();
  const a = '[32m' + 'x'.repeat(40) + '[0m';
  const b = 'y'.repeat(40);
  assert.equal(hud.wrapSegments([a, b], 96).length, 1, '40+3+40 可见列放得下');
  assert.equal(hud.wrapSegments([a, b], 50).length, 2);
});

test('widget 行：workbuddy 的三段额度排成两行', async () => {
  const hud = loadHud({
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: [{
      provider: 'workbuddy', kind: 'plan',
      windows: [
        { name: 'Credits', used: 0, resetsAt: '2026-10-31T15:59:59Z', display: '0 / 500', limit: 500, unit: 'credits' },
        { name: 'Extra credits', used: 21.38 / 23.09, display: '21.38 / 2309', limit: 2309, unit: 'credits' },
        { name: 'Total credits', used: 21.38 / 28.09, resetsAt: '2026-10-31T15:59:59Z', display: '21.38 / 2809', limit: 2809, unit: 'credits' },
        { name: 'deepseek-v4.1-flash tokens (est.)', used: 6.5, resetsAt: '2026-11-17T05:04:00Z', display: '13.0M / ~200M' },
      ],
    }] }) }),
  });
  const widgets = [];
  await hud.refreshAll({
    model: { provider: 'magpie', id: 'workbuddy/glm-5.3', contextWindow: 200000, maxTokens: 20000 },
    ui: { setWidget: (k, v) => { if (k === 'pi-hud') widgets.push(v); }, setStatus: () => {}, theme: undefined },
    sessionManager: { getEntries: () => [] },
  });
  const lines = widgets.at(-1);
  assert.equal(lines.length, 3, JSON.stringify(lines));
  assert.match(lines[1], /Credits .*Extra credits/);
  assert.match(lines[2], /^deepseek-v4\.1-flash tokens/);
});

test('account.error 在 windows 为空时显式渲染为 status 警告行，不静默吞掉', async () => {
  const hud = loadHud({
    fetch: async () => ({
      ok: true, status: 200,
      json: async () => ({
        data: [{
          provider: 'workbuddy', windows: [],
          error: 'WorkBuddy desktop keeps its sign-in encrypted (WorkBuddy 5.6 and later)...'
        }]
      })
    })
  });
  const r = await hud.sourceMagpie('workbuddy/glm-5.3-flash');
  assert.ok(r?.groups?.[0]?.lines?.length === 1);
  const line = r.groups[0].lines[0];
  assert.equal(line.label, 'status');
  assert.ok(line.reset.includes('token sealed'));
  assert.equal(line.hold?.level, 'alert');
});
