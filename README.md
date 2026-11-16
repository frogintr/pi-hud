# pi-quota-hud

A `pi` extension that puts the numbers you actually watch into the status area:

- **subscription quota windows** (5h / 7d / weekly / credit balances) for every provider you have signed in, plus every provider `magpie` aggregates;
- **context usage**;
- **TTFT and tokens/s**, measured locally from pi's own stream events.

Nothing is uploaded anywhere: it reads your existing `~/.pi/agent/auth.json`, asks the same endpoints the provider's own client asks, and writes refreshed OAuth tokens back to that file.

```
# widget, right under the editor (placement: belowEditor)
workbuddy/deepseek-v4.1-flash · ctx ░░░░░░░ 4.8% (42k/872k)
Credits ░░░░░░░ 0 / 500 11-30 15:59 · Extra credits ░░░░░░░ 21.38 / 2309
deepseek-v4.1-flash tokens (est.) █░░░░░░ 17.0M / ~200M 11-17 05:04

# pi's own footer (pwd / tokens / cost / context / model) stays untouched;
# the extension only adds its status line at the bottom:
ttft 0.7s · 99.2 t/s
```

## Install

```bash
pi install git:github.com/<owner>/pi-hud
```

or try it for one session:

```bash
pi -e git:github.com/<owner>/pi-hud
```

or drop `extensions/pi-hud.ts` into `~/.pi/agent/extensions/` (it is a single file with no runtime dependencies; only type imports from pi).

`/reload` after installing.

## What it reads

| Source | Endpoint / file | Auth |
|---|---|---|
| `magpie` (local gateway) | `http://127.0.0.1:3425/v1/magpie/quotas` | none (loopback) |
| `openai-codex` | `chatgpt.com/backend-api/wham/usage` | `auth.json` OAuth |
| `claude` | `api.anthropic.com/v1/organizations/usage_report/messages` | `auth.json` OAuth |
| `xai` (SuperGrok) | `cli-chat-proxy.grok.com/v1/billing` | OAuth, refreshed and written back |
| `kimi-coding` | `api.kimi.com/coding/v1/usages` | OAuth, refreshed and written back |
| `openrouter` | `openrouter.ai/api/v1/credits` | API key from `auth.json` |

The model's **provider** picks the source; for `magpie` the **first segment of the model id** picks the vendor
(`workbuddy/glm-5.3` → vendor `workbuddy`). Windows are rendered from what the endpoint reports, so an unknown
vendor (or a renamed window) degrades to its own label instead of disappearing.

### magpie vendors

The quotas endpoint answers with one card per vendor, each with windows that differ by vendor:

- `5 hours` / `7 days`, optionally prefixed by a pool: `Gemini · 5 hours`, `Claude & GPT · 7 days`.
  A pool's two windows are shown only when the active model belongs to that pool.
- credit ledgers such as WorkBuddy's `Credits` / `Extra credits` / `deepseek-… tokens (est.)`.
  These are shown as **used / limit** (the vendor's own reading), not as a percentage.
  A window whose limit equals the sum of the other windows' limits (`Total credits` = `Credits` + `Extra credits`)
  is treated as their total and dropped, so the same allowance is not reported three times.
- `holdsWhy` is **not** a warning. It explains why magpie cannot estimate how much a whole window holds
  (`low` = under 5% used, so a rounded share is too coarse; `clock` = reset time unknown; `log` = window began
  before magpie's request log; `none` = nothing routed yet; `credits` = a call may have been paid from credits).
  The extension ignores it; magpie's own GUI shows it as a muted "Whole: not enough data" with a tooltip.

## TTFT and tokens/s

Measured per request, provider-agnostic:

```
before_provider_request (T0) → first *_delta event (T1) → message_end (T2)
ttft = T1 - T0                      queue + prefill + first token
t/s  = usage.output / (T2 - T1)     generation only, TTFT excluded
```

- the footer line shows the mean of the **last 5** turns;
- turns with fewer than 24 output tokens (most tool calls) contribute their TTFT but not their t/s;
- nothing is persisted, so a freshly started pi shows the footer line after its first turn;
- for providers behind an aggregator (magpie, ACP bridges) the number includes that hop's overhead — it is the
  latency you actually experience.

## Configuration

All optional, via environment:

| Variable | Default | Meaning |
|---|---|---|
| `PI_HUD_MAGPIE_URL` | `http://127.0.0.1:3425/v1/magpie/quotas` | quota endpoint of a local magpie gateway |
| `PI_HUD_REFRESH_MS` | `60000` | quota polling interval |
| `PI_HUD_WIDTH` | terminal width − 4 | max width of a widget line |
| `PI_HUD_LINE_WIDTH` | `96` | max width of one quota line before it wraps |

A quota line wraps **at `" · "` boundaries only**, so a value such as `13.0M / ~200M` or a coloured meter is never
split; each additional line goes below the previous one inside the same widget.

## Tests

```bash
npm test
```

`test/pi-hud.test.mjs` drives the quota parser with recorded magpie payloads; `test/speed-hooks.test.mjs` runs the
event sequence with real timers and asserts TTFT/t/s land on the footer status line, not in the widget.

## Notes and limits

- pi renders extension widgets below the editor and extension `setStatus` lines in its footer; the built-in footer
  line (tokens, cost, cache hit rate, context %, model name) belongs to pi and cannot be modified from an extension.
- The context percentage in the widget uses `contextWindow - maxTokens` as its denominator, which is *not* what pi's
  footer uses (`contextWindow`). Both are shown, so they can differ; that is a display choice, not a bug in either.
- Providers that report no stream deltas produce no TTFT sample.
- No credentials live in this repository; nothing here is a secret. OAuth client ids are those of the official CLIs.
