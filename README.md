# pi-quota-hud

A `pi` extension that puts the numbers you actually watch into the status area:

- **subscription quota windows** (5h / 7d / weekly / credit balances) for every provider signed in to pi,
  and for every vendor a local [magpie](https://usemagpie.ai) gateway serves;
- **context usage** in the widget;
- **TTFT and tokens/s**, measured locally from pi's own stream events, on pi's footer status line.

Nothing is uploaded anywhere: it reads your existing `~/.pi/agent/auth.json`, calls the same endpoints the
provider's own client calls, and writes refreshed OAuth tokens back to that file.

```
# widget, right under the editor (placement: belowEditor)
workbuddy/deepseek-v4.1-flash · ctx ░░░░░░░ 4.8% (42k/872k)
Credits ░░░░░░░ 0 / 500 11-30 15:59 · Extra credits ░░░░░░░ 33.8 / 2309
deepseek-v4.1-flash tokens (est.) █░░░░░░ 24.3M / ~200M 11-17 05:04

# pi's own footer (pwd / tokens / cost / context / model) is untouched;
# the extension only appends its own status line below it:
ttft 0.7s · 99.2 t/s
```

## Install

```bash
pi install git:github.com/frogintr/pi-hud
```

or try it for a single session:

```bash
pi -e git:github.com/frogintr/pi-hud
```

or copy `extensions/pi-hud.ts` into `~/.pi/agent/extensions/` — it is one file with no runtime dependencies
(only type imports from pi). Run `/reload` afterwards.

> Installing the package *and* keeping a copy in `~/.pi/agent/extensions/` loads the extension twice and draws the
> widget twice. Pick one.

## What it reads

| Provider | Endpoint | Auth |
|---|---|---|
| `magpie` (local gateway) | `http://127.0.0.1:3425/v1/magpie/quotas` | none (loopback) |
| `openai-codex` | `chatgpt.com/backend-api/wham/usage` | OAuth from `auth.json` |
| `claude` | `api.anthropic.com/v1/organizations/usage_report/messages` | OAuth from `auth.json` |
| `xai` (Grok / GrokBot) | `cli-chat-proxy.grok.com/v1/billing` | OAuth; refreshed and written back; falls back to the Grok CLI's own login |
| `kimi-coding` | `api.kimi.com/coding/v1/usages` | OAuth; refreshed and written back |
| `openrouter` | `openrouter.ai/api/v1/credits` | API key from `auth.json` |

A model's **provider** selects the source. For `magpie`, the **first segment of the model id** selects the vendor
(`workbuddy/glm-5.3` → vendor `workbuddy`), so switching models inside magpie switches the quota card.

### Two ways the same subscription can appear

- **Direct**: pi talks to the provider itself, e.g. `xai` (`grok-4.7`), `openai-codex`, `openrouter`.
- **Through magpie**: pi talks to the local gateway, which talks to the vendor, e.g. `magpie/kimi-code-cn/k3`,
  `magpie/workbuddy/…`, `magpie/agy-cli/…`, `magpie/grok/…`. The vendor prefix in the model id picks the card.

Both are supported and are shown the same way; only the card's windows differ.

### Windows

- `5 hours` / `7 days`, optionally prefixed by a pool: `Gemini · 5 hours`, `Claude & GPT · 7 days`.
  A pool's windows are shown only while the active model belongs to that pool.
- **Credit ledgers** (WorkBuddy's `Credits` / `Extra credits`, a per-model `… tokens (est.)` window) are shown as
  the vendor's own **used / limit** reading instead of a percentage, because a percentage of a 2309-credit pool says
  nothing while `33.8 / 2309` says everything.
- A window whose limit equals the sum of the other windows' limits (`Total credits` = `Credits` + `Extra credits`)
  is treated as their total and folded away, so one allowance is not reported three times.
- `holdsWhy` is **not** a warning. It explains why magpie cannot estimate how much a whole window holds:

  | value | meaning |
  |---|---|
  | `low` | under 5% used — a rounded share that small is too coarse to scale up |
  | `clock` | reset time unknown, so the window's start is unknown |
  | `log` | the window began before magpie's request log |
  | `none` | magpie has not routed a call through this account in it yet |
  | `credits` | a call in it may have been paid from credits or extra usage |

  magpie's own GUI renders it as a muted "Whole: not enough data" with a tooltip. This extension ignores it rather
  than turning a data-confidence note into a red alert.

## TTFT and tokens/s

Measured per request, provider-agnostic:

```
before_provider_request (T0) → first *_delta event (T1) → message_end (T2)
ttft = T1 - T0                      queue + prefill + first token
t/s  = usage.output / (T2 - T1)     generation only, TTFT excluded
```

- the footer line shows the mean of the **last 5 turns**;
- turns with fewer than 24 output tokens (most tool calls) contribute their TTFT but not their t/s;
- `content_block_start` / `message_start` do not count as the first token; thinking deltas do;
- nothing is persisted: a freshly started pi shows the line after its first turn;
- behind an aggregator (magpie, ACP bridges) the figure includes that hop — it is the latency you actually get.

## Verified

Checked on Windows with real credentials (pi 1.5.2, magpie 0.1.4291, 2026-11-16):

| Path | Card |
|---|---|
| direct `openai-codex` (ChatGPT) | `7d █████░░ 68.0% 11-19 01:07` |
| direct `xai` — Grok + X "GrokBot" unified plan | `7d ░░░░░░░ 2.0% 11-23 20:01` (weekly window, `isUnifiedBillingUser`) |
| direct `openrouter` | `credits ████░░░ 54.8% $9.03 / $20.00` |
| magpie → Kimi Code (China) plan | `5h ░░░░░░░ 7.0% 17:08 · 7d ░░░░░░░ 6.4% 11-19 10:08` |
| magpie → WorkBuddy (Free plan) | `Credits 0 / 500 11-30 15:59 · Extra credits 33.8 / 2309` + `deepseek-… tokens 24.3M / ~200M` |
| magpie → agy-cli (Antigravity CLI) | `Gemini·5h / Gemini·7d` or `Claude&GPT·5h / Claude&GPT·7d`, narrowed by the active model |
| magpie → grok | `7d ░░░░░░░ 2.0% 11-23 12:01` |
| direct `claude` | code path present, **not** exercised here (no Claude subscription on this machine) |
| direct `kimi-coding` | code path present, **not** exercised here (Kimi is reached through magpie) |

### xAI credentials

pi refreshes `xai` itself from `~/.pi/agent/auth.json`. If that credential is stale (xAI rotates refresh tokens, so a
token unused for a while can go `invalid_grant`), the extension falls back to the login the official Grok CLI keeps in
`~/.grok/auth.json` — same account, same OAuth client id.

That fallback is **read-only**: the CLI rotates its own refresh token when it runs, and writing to its file from here
would log it out. Re-login pi with `pi auth login xai` to restore the primary path.

## Configuration

All optional, via environment:

| Variable | Default | Meaning |
|---|---|---|
| `PI_HUD_MAGPIE_URL` | `http://127.0.0.1:3425/v1/magpie/quotas` | quota endpoint of a local magpie gateway |
| `PI_HUD_REFRESH_MS` | `60000` | quota polling interval |
| `PI_HUD_WIDTH` | terminal width − 4 | max width of a widget line |
| `PI_HUD_LINE_WIDTH` | `96` | max width of one quota line before it wraps |

A quota line wraps **at `" · "` boundaries only**, so a value such as `24.3M / ~200M` or a coloured meter is never
split; extra lines stack below inside the same widget (pi caps a widget at 10 lines).

## Tests

```bash
npm test
```

- `test/pi-hud.test.mjs` — quota parsing and rendering against recorded provider payloads (magpie vendors, pool
  narrowing, credit ledgers, aggregate folding, `holdsWhy`, GrokBot unified billing, xAI CLI fallback, wrapping).
- `test/speed-hooks.test.mjs` — the real event sequence with real timers, asserting TTFT/t/s land on the footer
  status line and never in the widget.

No network access is needed for either; `test/pi-hud-verify-live.mjs` in the author's workspace is the live check.

## Limits

- pi owns the footer line (tokens, cost, cache hit rate, context %, model). An extension can only append a status
  line below it, so that line stays as pi renders it.
- The widget's context percentage uses `contextWindow - maxTokens` as its denominator, while pi's footer uses
  `contextWindow`. Both are shown, and they can therefore differ — a display choice, not a bug in either.
- A provider that reports no stream deltas yields no TTFT sample.
- No credentials live in this repository. OAuth client ids are those of the official CLIs and are public.

MIT licensed.
