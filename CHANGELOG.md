# Changelog

## [0.7.0] - 2026-11-16

- Widget wraps quota windows at `" · "` boundaries instead of letting them be cut mid-value.
- TTFT and tokens/s moved to pi's footer status line (`pi-hud-speed`), averaged over the last 5 turns.
- Balance windows (credits) show the vendor's `used / limit` reading instead of a percentage.
- Aggregate windows (`Total credits` = `Credits` + `Extra credits`) are folded away.
- `holdsWhy` is no longer rendered as a warning; it is a confidence note about the window's whole allowance.
- `magpie` quota source: vendor is taken from the model-id prefix, pools narrow by the active model.
- Configurable endpoint, refresh interval and widget width via `PI_HUD_*` environment variables.
