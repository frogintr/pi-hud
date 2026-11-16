# Changelog

## [0.9.0] - 2026-11-16

- One meta line: `ctx … · ttft … · N tokens/s` (was: model + ctx in the widget, speed on a
  separate footer status line). The model is no longer repeated — pi's footer already shows it.
- No extension status line in pi's footer any more, so the bottom of the screen lost a line.
- Speed reads `tokens/s` instead of the `t/s` abbreviation.
- `test/providers.test.mjs`: direct `kimi-coding` and `anthropic` paths covered alongside
  `openai-codex` and `openrouter`.
- README rewritten with narrow tables so it renders on GitHub without squeezing cells.

## [0.8.0] - 2026-11-16

- xAI: Grok + X unified plan ("GrokBot") is read from `isUnifiedBillingUser` payloads (`creditUsagePercent`, or
  `productUsage` rows named `GrokBot` / `GrokBuild`).
- xAI: when pi's own credential is stale, fall back to the Grok CLI's login in `~/.grok/auth.json` (read-only, so the
  CLI keeps its refresh token).
- Verified against live endpoints: direct `openai-codex`, `xai`, `openrouter`; magpie vendors `kimi-code-cn`,
  `workbuddy`, `agy-cli`, `grok`. See the README's "Verified" table.

## [0.7.0] - 2026-11-16

- Widget wraps quota windows at `" · "` boundaries instead of letting them be cut mid-value.
- TTFT and tokens/s moved to pi's footer status line (`pi-hud-speed`), averaged over the last 5 turns.
- Balance windows (credits) show the vendor's `used / limit` reading instead of a percentage.
- Aggregate windows (`Total credits` = `Credits` + `Extra credits`) are folded away.
- `holdsWhy` is no longer rendered as a warning; it is a confidence note about the window's whole allowance.
- `magpie` quota source: vendor is taken from the model-id prefix, pools narrow by the active model.
- Configurable endpoint, refresh interval and widget width via `PI_HUD_*` environment variables.
