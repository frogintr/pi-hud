# pi-quota-hud

A `pi` extension that shows subscription quota, context usage, TTFT and generation speed
where you already look: a small widget under the editor.

It reads your existing `~/.pi/agent/auth.json`, calls the same endpoints each provider's own
client calls, and writes refreshed OAuth tokens back to that file. Nothing is uploaded anywhere.

## What you see

```
ctx ░░░░░░░ 4.8% (42k/872k) · ttft 0.7s · 99 tokens/s
Credits ░░░░░░░ 0 / 500 11-30 15:59 · Extra credits ░░░░░░░ 33.8 / 2309
deepseek-v4.1-flash tokens (est.) █░░░░░░ 26.2M / ~200M 11-17 05:04
```

- one line for **context + ttft + tokens/s**;
- the lines after it are the **quota windows** of whatever you are talking to;
- the model and provider are **not repeated** here: pi's own footer already shows them.

The widget is placed below the editor. The extension adds nothing to pi's footer, so the bottom
of the screen keeps its usual height.

## Install

```bash
pi install git:github.com/frogintr/pi-hud
```

Try it without installing:

```bash
pi -e git:github.com/frogintr/pi-hud
```

Or copy `extensions/pi-hud.ts` into `~/.pi/agent/extensions/`. It is one file with no runtime
dependencies (only type imports from pi). Run `/reload` afterwards.

Keep exactly one of those: the package and a copy in `extensions/` both load, which means two
pollers hitting every endpoint and two independent TTFT histories.

## Which providers get a card

Sources are chosen by the model's provider, so any of these works as soon as you are signed in:

- `openai-codex` — ChatGPT plan (5h and/or 7d, labelled from the window the API reports)
- `anthropic` — Claude Pro/Max (5h + 7d)
- `xai` — Grok / GrokBot weekly window
- `kimi-coding` — Kimi Code plan (5h + 7d)
- `openrouter` — credit balance
- `magpie` — every vendor the local gateway serves

Kimi is a useful example of the two paths:

- **direct**: log in with `pi auth login kimi-coding`, and the card comes from
  `api.kimi.com/coding/v1/usages`;
- **through magpie**: keep one local gateway for all agents and use `magpie/kimi-code-cn/k3`
  instead; the card then comes from magpie's `/v1/magpie/quotas`.

Both are supported at the same time; the one that matches the active model is the one shown.

API-key providers with no plan windows (DeepSeek, Groq, Mistral, MiniMax, …) have nothing to
show and produce no line — the extension never invents numbers. Vendors that exist only as
magpie plugins (Cursor, Factory, Zed, Qoder, …) appear when magpie serves them.

### magpie vendors

For `magpie`, the first segment of the model id picks the card:

- `magpie/workbuddy/glm-5.3` → vendor `workbuddy`
- `magpie/agy-cli/gemini-3.8-flash` → vendor `agy-cli`
- `magpie/kimi-code-cn/k3` → vendor `kimi-code-cn`
- `magpie/grok/grok-4.7@500k` → vendor `grok`

Switching models inside magpie switches the quota card with it.

## Window kinds

- `5h` / `7d`: usage percentage, bar and reset time.
- Pooled windows: `Gemini · 5 hours`, `Claude & GPT · 7 days`. A pool is shown only while the
  active model belongs to it.
- Credit ledgers: WorkBuddy's `Credits`, `Extra credits`, or a per-model `… tokens (est.)`.
  These show the vendor's own **used / limit** reading instead of a percentage: `33.8 / 2309`
  says something, `1.4%` does not.
- Aggregate windows are folded away: if a window's limit equals the sum of the others'
  (`Total credits` = `Credits` + `Extra credits`), it is that total, not a fourth reading.

### `holdsWhy` is not a warning

magpie sends a `holdsWhy` field that explains why it **cannot estimate how much a whole window
holds**. It is about data confidence, not about running out:

- `low` — under 5% of the window is used, so a rounded share is too coarse to scale up
- `clock` — reset time unknown, so the window's start is unknown
- `log` — the window began before magpie's request log
- `none` — magpie has not routed a call through the account in this window yet
- `credits` — a call in it may have been paid from credits or extra usage

magpie's own GUI shows this as muted "Whole: not enough data" with a tooltip. A status bar has no
tooltip, and any ⚠️ there reads as "quota is about to run out", so this extension ignores the field.

## TTFT and tokens/s

Measured per request from pi's own events, so it works for every provider:

```
before_provider_request (T0) → first *_delta event (T1) → message_end (T2)

ttft      = T1 - T0                    queue + prefill + first token
tokens/s  = usage.output / (T2 - T1)    generation only, TTFT excluded
```

- the line shows the mean of the last **5** turns;
- turns under 24 output tokens (most tool calls) contribute TTFT but not tokens/s;
- `message_start` / `content_block_start` do not count as the first token, thinking deltas do;
- nothing is persisted, so a fresh pi shows the line after its first turn;
- behind magpie or an ACP bridge the number includes that hop — it is the latency you actually get.

## Verified

Checked on Windows with real accounts (pi 1.5.2, magpie 0.1.4291, 2026-11-16):

- direct `openai-codex` — `7d 68.0% 11-19 01:07`
- direct `xai`, Grok + X unified plan — `7d 2.0% 11-23 20:01`
- direct `openrouter` — `credits 54.8% $9.03 / $20.00`
- magpie → Kimi Code (China) — `5h 7.0% 17:08`, `7d 6.4% 11-19 10:08`
- magpie → WorkBuddy Free — `Credits 0 / 500`, `Extra credits 33.8 / 2309`,
  `deepseek-… tokens 26.2M / ~200M`
- magpie → agy-cli — `Gemini·5h/7d` or `Claude&GPT·5h/7d`, narrowed by the active model
- magpie → grok — `7d 2.0% 11-23 12:01`

Covered by tests but not exercised against a live account on that machine: direct `kimi-coding`
and direct `anthropic` (recorded payloads in `test/providers.test.mjs`).

### xAI credentials

pi refreshes `xai` from `~/.pi/agent/auth.json`. xAI rotates refresh tokens, so a token unused for
a few weeks can go `invalid_grant`. When that happens the extension borrows the login the official
Grok CLI keeps in `~/.grok/auth.json` (same account, same OAuth client id).

That fallback is **read-only** on purpose: the CLI rotates its own refresh token, and writing to
its file from here would sign it out. To restore the primary path, run `pi auth login xai`.

## Configuration

Optional, via environment:

| Variable | Default |
|---|---|
| `PI_HUD_MAGPIE_URL` | `http://127.0.0.1:3425/v1/magpie/quotas` |
| `PI_HUD_REFRESH_MS` | `60000` |
| `PI_HUD_WIDTH` | terminal width − 4 |
| `PI_HUD_LINE_WIDTH` | `96` |

A quota line wraps only at `" · "` boundaries, so a reading such as `26.2M / ~200M` or a coloured
meter is never split in half; extra lines stack below in the same widget.

## Tests

```bash
npm test
```

- `test/quota.test.mjs` — magpie payloads: vendors, pool narrowing, credit ledgers, aggregate
  folding, `holdsWhy`, wrapping.
- `test/providers.test.mjs` — direct providers: `kimi-coding`, `anthropic`, `openai-codex`,
  `openrouter`.
- `test/speed-hooks.test.mjs` — the real event sequence with real timers.
- `test/layout.test.mjs` — what goes in the widget: one meta line, quota wrapping, no footer
  status line, idempotent re-render.

None of them need network access.

## Limits

- pi owns its footer line (tokens, cost, cache hit rate, context %, model). An extension can only
  put its own widget under the editor; it cannot edit that line.
- The widget's context percentage uses `contextWindow - maxTokens` as its denominator, while pi's
  footer uses `contextWindow`. Both appear, so the two numbers can differ.
- A provider that streams no deltas yields no TTFT sample.

MIT licensed.
