// 直连 provider 的额度解析：pi 能 login 的那几条订阅路径
// （kimi-coding / anthropic / openai-codex / xai / openrouter），不连网，用录制报文。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const HUD = path.join(homedir(), '.pi/agent/extensions/pi-hud.ts');
const AUTH = path.join(homedir(), '.pi', 'agent', 'auth.json');
const NOW = Date.parse('2026-11-16T04:00:00Z');

const jwt = (exp) => `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`;
const valid = () => jwt(NOW / 1000 + 3600);

function loadHud({ auth, fetch: fetcher }) {
  const sandbox = {
    Buffer, URLSearchParams, AbortSignal, console, path, homedir,
    Date: class extends Date {
      constructor(...a) { super(...(a.length ? a : [NOW])); }
      static now() { return NOW; }
    },
    readFileSync: (p) => (p === AUTH ? JSON.stringify(auth) : '{}'),
    writeFileSync: () => {},
    appendFileSync: () => {},
    process: { on() {} },
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
    fetch: fetcher ?? (async () => ({ ok: false, status: 500, json: async () => ({}) })),
  };
  const src = stripTypeScriptTypes(readFileSync(HUD, 'utf8'), { mode: 'strip' })
    .replace(/^import .*;\r?\n/gm, '')
    .replace('export default function', 'function install');
  vm.createContext(sandbox);
  vm.runInContext(`${src}\nglobalThis.t = { sourceKimi, sourceClaude, sourceCodex, sourceGrok, sourceOpenRouter };`, sandbox);
  return sandbox.t;
}

test('kimi-coding 直连（pi 自带 login）：5h + 7d 双窗', async () => {
  const hud = loadHud({
    auth: { 'kimi-coding': { type: 'oauth', access: valid(), refresh: 'r' } },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ usages: {
      limit_5h: { used_ratio: 0.07, reset_time: '2026-11-16T09:08:00Z' },
      limit_7d: { used_ratio: 0.064, reset_time: '2026-11-19T10:08:00Z' },
    } }) }),
  });
  const r = await hud.sourceKimi();
  assert.deepEqual(JSON.parse(JSON.stringify(r.groups[0].lines)), [
    { label: '5h', used: 0.07, reset: '09:08' },
    { label: '7d', used: 0.064, reset: '11-19 10:08' },
  ]);
});

test('kimi-coding 直连：401 给登录提示，不伪造额度', async () => {
  const hud = loadHud({
    auth: { 'kimi-coding': { type: 'oauth', access: valid() } },
    fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }),
  });
  const r = await hud.sourceKimi();
  assert.match(r.groups[0].lines[0].reset, /token 过期/);
});

test('anthropic 直连（Claude Pro/Max）：5h + 7d', async () => {
  const hud = loadHud({
    auth: { claude: { type: 'oauth', access: valid() } },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({
      five_hour: [{ utilization: 0.1, resets_at: '2026-11-16T09:00:00Z' }],
      seven_day: [{ utilization: 0.42, resets_at: '2026-11-23T00:00:00Z' }],
    }) }),
  });
  const r = await hud.sourceClaude();
  assert.deepEqual(JSON.parse(JSON.stringify(r.groups[0].lines)), [
    { label: '5h', used: 0.1, reset: '09:00' },
    { label: '7d', used: 0.42, reset: '11-23 00:00' },
  ]);
});

test('anthropic 直连：未登录时不请求、不显示', async () => {
  const hud = loadHud({ auth: {} });
  assert.equal(await hud.sourceClaude(), null);
});

test('openai-codex 直连：按实际窗口时长标注 5h/7d', async () => {
  const hud = loadHud({
    auth: { 'openai-codex': { type: 'oauth', access: valid(), accountId: 'acc' } },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({
      rate_limit: {
        primary_window: { used_percent: 12, limit_window_seconds: 18_000, reset_at: '2026-11-16T09:00:00Z' },
        secondary_window: { used_percent: 55, limit_window_seconds: 604_800, reset_at: '2026-11-23T00:00:00Z' },
      },
    }) }),
  });
  const r = await hud.sourceCodex();
  assert.deepEqual(JSON.parse(JSON.stringify(r.groups[0].lines)), [
    { label: '5h', used: 0.12, reset: '09:00' },
    { label: '7d', used: 0.55, reset: '11-23 00:00' },
  ]);
});

test('openrouter（API key）：余额型，无 5h/7d', async () => {
  const hud = loadHud({
    auth: { openrouter: { type: 'api_key', key: 'k' } },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: { total_credits: 20, total_usage: 9.03 } }) }),
  });
  const r = await hud.sourceOpenRouter();
  const line = r.groups[0].lines[0];
  assert.equal(line.label, 'credits');
  assert.equal(line.reset, '$10.97 / $20.00');
  assert.ok(Math.abs(line.used - 0.4515) < 1e-6);
});
