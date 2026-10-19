# Changelog

## 0.1.0

First release.

- Routes each prompt to Haiku, Sonnet or Opus by difficulty, using a keyword fast path and a classifier fallback.
- Sticky tiers: moves up at once, moves down only after two lower suggestions in a row.
- Routes subagents that were spawned without a model.
- Triages prompts sent mid-run into interrupt, steer or queue.
- `!haiku`, `!sonnet` and `!opus` prefixes force a model for one prompt.
- `/gearshift` command with `auto`, `off`, tier pins, `now`, `drop`, `panel` and `probe`.
- Falls back to the session model when a routed model or classifier is unavailable.
