// pi-hud 延迟/吞吐：真实定时器下跑一遍事件顺序，验证 TTFT 与 t/s 落到 footer 状态行
// 运行：node --test test/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

const HUD = fileURLToPath(new URL('../extensions/pi-hud.ts', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function load() {
  const sandbox = {
    Buffer, URLSearchParams, AbortSignal, console, path, homedir, fetch,
    readFileSync: () => '{}',
    writeFileSync: () => {},
    appendFileSync: () => {},
    process: { on() {} },
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
  };
  const source = stripTypeScriptTypes(readFileSync(HUD, 'utf8'), { mode: 'strip' })
    .replace(/^import .*;\r?\n/gm, '')
    .replace('export default function', 'function install');
  vm.createContext(sandbox);
  vm.runInContext(`${source}\nglobalThis.t = { install, renderStatus, speedLine };`, sandbox);
  return sandbox.t;
}

/** 装好扩展并拿到事件处理器；widget 行与 footer 状态各自收集 */
function harness(hud) {
  const handlers = new Map();
  hud.install({
    on(name, fn) {
      const list = handlers.get(name) ?? [];
      list.push(fn);
      handlers.set(name, list);
      return () => {};
    },
  });
  const widgets = [];
  const statuses = new Map();
  const ctx = {
    model: { provider: 'magpie', id: 'workbuddy/deepseek-v4.1-flash', contextWindow: 200000, maxTokens: 20000 },
    ui: {
      setWidget: (key, v) => { if (key === 'pi-hud') widgets.push(v); },
      setStatus: (key, v) => { statuses.set(key, v); },
      theme: undefined,
    },
    sessionManager: { getEntries: () => [] },
  };
  const fire = async (name, event) => {
    for (const fn of handlers.get(name) ?? []) await fn(event, ctx);
  };
  return { handlers, ctx, widgets, statuses, fire };
}

test('事件顺序 before_provider_request → 首个 delta → message_end 产出 ttft + t/s', async () => {
  const hud = load();
  const { handlers, widgets, statuses, fire } = harness(hud);
  for (const name of ['before_provider_request', 'message_update', 'message_end']) {
    assert.ok(handlers.has(name), `未注册 ${name} 事件`);
  }

  await fire('before_provider_request', { payload: {} });
  await sleep(60);
  await fire('message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'H' } });
  await sleep(240);
  await fire('message_end', { message: { role: 'assistant', usage: { output: 120 } } });

  // 速度走 footer 扩展状态行（pi 把 setStatus 拼在 pwd / 用量行之后）
  const speed = statuses.get('pi-hud-speed') ?? '';
  const m = speed.match(/ttft ([\d.]+)s · ([\d.]+) t\/s/);
  assert.ok(m, `footer 状态行应带 ttft 和 t/s: ${speed}`);
  assert.ok(Number(m[1]) < 0.2, `ttft 不该含生成时间: ${speed}`);
  // 120 token / ~0.24s ≈ 500 t/s（含 message_end 触发的少量偏差）
  assert.ok(Number(m[2]) > 300 && Number(m[2]) < 800, `t/s 应在合理区间: ${speed}`);

  // widget 里不该再出现速度
  const widgetText = (widgets.at(-1) ?? []).join('\n');
  assert.ok(!/ttft|t\/s/.test(widgetText), `widget 里不该有速度: ${widgetText}`);
});

test('start / content_block_start 这类事件不算首 token', async () => {
  const hud = load();
  const { fire } = harness(hud);
  await fire('before_provider_request', {});
  await fire('message_start', { message: { role: 'assistant', content: [] } });
  await fire('message_update', { assistantMessageEvent: { type: 'content_block_start' } });
  await sleep(180);
  await fire('message_update', { assistantMessageEvent: { type: 'thinking_delta', delta: '…' } });
  await sleep(60);
  await fire('message_end', { message: { role: 'assistant', usage: { output: 100 } } });

  const line = hud.speedLine();
  assert.match(line, /^ttft 0\.[12]s/, `首个 delta 在 180ms 后才到，TTFT 应约 0.2s: ${line}`);
});

test('输出过短的轮次只显示 ttft（工具调用轮不带 t/s）', async () => {
  const hud = load();
  const { fire } = harness(hud);
  await fire('before_provider_request', {});
  await sleep(30);
  await fire('message_update', { assistantMessageEvent: { type: 'toolcall_delta', delta: '{"' } });
  await sleep(120);
  await fire('message_end', { message: { role: 'assistant', usage: { output: 8 } } });

  const line = hud.speedLine();
  assert.match(line, /^ttft 0\.[01]s$/, `短轮不该有 t/s: ${line}`);
});

test('用户消息的 message_end 不影响计时', async () => {
  const hud = load();
  const { fire } = harness(hud);
  await fire('before_provider_request', {});
  await sleep(40);
  await fire('message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'x' } });
  await sleep(200);
  await fire('message_end', { message: { role: 'user', content: 'hi' } });
  assert.equal(hud.speedLine(), null, 'user 的 message_end 不该产生样本');
});
