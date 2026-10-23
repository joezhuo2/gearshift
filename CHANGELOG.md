# Changelog

## 0.1.4

- Clearer notice when triage queues or redirects a prompt sent mid-run, with no duplicate toast.

## 0.1.3

- The `gearshift:` label beside the model picker now shows from the start (`gearshift: auto`), not only after a tier was picked.

## 0.1.2

- Fix `npx` install: the npm name `gearshift` belongs to an unrelated package, so install with `npx github:joezhuo2/gearshift`.

## 0.1.1

- `/gearshift` reports the hint line draws.
- Add CI and tagged GitHub releases.

## 0.1.0

First release.

- Routes each prompt to Haiku, Sonnet or Opus by difficulty, using a keyword fast path and a classifier fallback.
- Sticky tiers: moves up at once, moves down only after two lower suggestions in a row.
- Routes subagents that were spawned without a model.
- Triages prompts sent mid-run into interrupt, steer or queue.
- `!haiku`, `!sonnet` and `!opus` prefixes force a model for one prompt.
- `/gearshift` command with `auto`, `off`, tier pins, `now`, `drop`, `panel` and `probe`.
- Falls back to the session model when a routed model or classifier is unavailable.
