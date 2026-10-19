# gearshift: build plan

Gearshift does two jobs automatically:

1. **Routing.** It sends each piece of work to the right model: Haiku for simple work, Sonnet for everyday work, Opus for hard work.
2. **Triage.** When you type while the agent is busy, it decides whether to **queue** the new prompt until the current task finishes, or to **interrupt** and steer the agent in a new direction.

Repo: `github.com/joezhuo2/gearshift` (public). One repo is both a Claude Code plugin marketplace and the plugin itself.

## What ships

| Piece | Where it runs | What it does |
| --- | --- | --- |
| **Mod** (`hooks/register.ts`) | Claude Code only | Switches the main model on each turn, routes subagents, and triages prompts sent mid-run. Fully automatic. |
| **Skill** (`skills/gearshift/SKILL.md`) | Claude Code, Codex, Cursor, and any agent that reads `SKILL.md` | Gives the agent a tier rubric and tells it to delegate to subagents on the right model. Does routing only: other agents have no API for interrupting a turn. |

Install lines for the README:

```
/plugin install gearshift --marketplace joezhuo2/gearshift      # Claude Code: mod + skill
npx skills add joezhuo2/gearshift                              # other agents: skill only
```

`gearshift` is already taken on npm. If our own npm installer is needed (see Phase 0), publish it as `@joezhuo2/gearshift`.

## Repo layout

```
gearshift/
  .claude-plugin/
    plugin.json          name, version, description, types, userConfig
    marketplace.json     one entry, source "./"
  hooks/
    hooks.json           { "modules": ["./register.ts"] }
    register.ts          wires up routing + triage
    route.ts             tier classifier + model picker
    triage.ts            queue / interrupt logic
    route.test.ts
    triage.test.ts
  types/index.d.ts       $.state contract (tier, running turn, queue)
  skills/gearshift/SKILL.md
  evals/prompts.json     ~40 labelled prompts for classifier accuracy
  .github/workflows/ci.yml
  README.md  CHANGELOG.md  LICENSE (MIT)  tsconfig.json
```

## Mod API facts (checked against Claude Code 2.1.299 types)

- `turn.step` runs with `e.model` and `e.effort`, and `next({ ...e, model })` swaps the model for that request. This is how the main model gets switched.
- `agent.spawn` runs with `e.model` undefined when the caller picked no model. Returning `next({ ...e, model })` sets it.
- `prompt.submit` also fires for a prompt typed during a turn, "at Enter, with that turn's id". `{ drop }` stops the prompt from going through.
- `$.turn.abort({ turnId })` cancels the running main turn and stops its tools. Whatever the plugin submits next becomes the context.
- `$.prompt.submit(...)` sends a user turn. `$.model.classify(text, labels, opts)` runs a Haiku label call.
- `$.ui.status`, `$.ui.toast`, the `AbovePrompt` band, and `$.command.register` with `immediate` (runs mid-turn) handle the UI.

## Phase 0: spike (~1 hour)

Prove the risky calls work before building anything.

1. Write a throwaway mod with three tests:
   - log `prompt.submit` during a running turn
   - call `$.turn.abort`, then `$.prompt.submit`
   - rewrite `turn.step` to `model: "haiku"`
2. Run each by hand. Confirm:
   - the turn id arrives with a mid-turn submit
   - abort followed by submit gives a clean steer
   - the status line shows the swapped model
3. Measure the latency of `$.model.classify`. The target is under 1.5 s, because triage has to feel instant.
4. Confirm `npx skills add joezhuo2/gearshift` installs `skills/gearshift/SKILL.md` into Codex/Cursor. If it doesn't, plan the `@joezhuo2/gearshift` npx installer (Phase 4b).

**Exit:** all four confirmed, or the plan gets adjusted before Phase 1.

### Phase 0 findings so far

- **The skills CLI works for other agents.** `npx skills add joezhuo2/gearshift` is supported: the `skills` npm package (vercel-labs) installs into Claude Code, Codex, Cursor and 75+ other agents. We don't need our own npm package, so Phase 4b is dropped.
- **Mid-turn prompts:** by default the engine delivers a prompt typed mid-turn *into* the running turn. That steers the agent but doesn't stop it. `prompt.submit` sees the prompt with `turnId` set.
- **Explicit queue flag:** `prompt.submit` has `wait: true` when the user pressed `ctrl+x enter` to say "queue this". Gearshift must never interrupt when that flag is set.
- **Queueing is cheap:** `$.prompt.submit` from a plugin "runs once it is idle". To queue a prompt, return `{ drop }` and call `$.prompt.submit({ text, asUser: true })` right away. No manual queue or flush on `turn.complete` is needed.
- **Hook shape:** a `turn.step` hook must be an `async function*` generator (`return yield* next({ ...e, model })`).
- **Validator rule:** helpers that take `$` must be top-level function declarations.
- **The real choice is three-way:**
  - **queue:** the prompt waits until the current task is done
  - **steer:** the engine's default; the prompt is injected into the running turn
  - **interrupt:** abort the turn, then resubmit the prompt

  Steer is free and is already the default, so the classifier mainly decides between queue and interrupt, with steer as the fallback for related follow-ups.
- **Still to confirm live with the spike mod:** that the `turn.step` model swap takes effect, `classify` latency, and that abort followed by resubmit gives a clean result.

## Phase 1: routing in the mod (~3 hours)

1. **Classifier** (`route.ts`):
   - Fast path first, with no model call: a very short prompt or a docs/typo/rename keyword means `simple`; "architecture", "race condition", "why does" or a debugging failure means `hard`.
   - Otherwise call `$.model.classify(text, ["simple","everyday","hard"], { model: "haiku" })`.
   - Tier maps to model: `simple→haiku`, `everyday→sonnet`, `hard→opus`. The map can be changed in `userConfig`.
2. **Main model:**
   - At `prompt.submit` (when no turn is running), classify and store the tier.
   - At `turn.start` on the main loop, bind the tier to the `turnId`.
   - At `turn.step`, set `model` (and `effort`) for that turn.
3. **Stickiness:** stay on the current model unless the new tier differs by 2 levels or the same new tier shows up twice in a row. Each switch breaks the prompt cache and costs money, so this cuts down on switching.
4. **Subagents:** at `agent.spawn` with no model set, classify the spawn prompt and set `model`. Never override a model the caller chose.
5. **Escalation (v0.2, optional):** if a Haiku turn runs more than N steps or hits repeated tool errors, step up one tier for the rest of the turn.
6. **Controls:** `/gearshift` shows the current tier and the reason. `/gearshift pin opus|sonnet|haiku|auto` and `/gearshift off`. A prompt prefix like `!opus` forces the tier for one prompt.
7. **UI:** a status line entry such as `⚙ sonnet (everyday)`.
8. **Tests** (`route.test.ts`): fast-path cases, map overrides, stickiness, the subagent model being respected.

## Phase 2: triage in the mod (~3 hours)

1. **Track the running turn:** `turn.start` on the main loop (`agentId` undefined) sets `running = { turnId, text }`. `turn.complete` clears it and flushes the queue.
2. **Mid-run prompt:** when `prompt.submit` fires while a turn is running:
   - Ask `$.model.classify` with the current task text plus the new prompt, labels `["interrupt","queue"]`.
   - The rubric says **interrupt** when the new prompt contradicts, cancels or redirects the current task ("stop", "wait, use X instead", "wrong file"). It says **queue** for anything unrelated or additive.
   - Anything unsure (low confidence, timeout, or error) gets **queued**.
3. **Interrupt:** `$.turn.abort({ turnId })`, then `$.prompt.submit` with:
   `Interrupted task: <old>. New direction from user: <new>. Continue from current state.`
   Show a toast: `⚡ interrupted: steering`.
4. **Queue:** return `{ drop }`, add the prompt to the queue in `$.state`, and list the queue in the `AbovePrompt` band. On `turn.complete`, submit the queued prompts as one message, numbered and in order.
5. **Override:** `/gearshift now` (immediate) moves the newest queued prompt to interrupt. `/gearshift drop` clears the queue.
6. **Tests** (`triage.test.ts`): idle submit passes through, mid-run cases go to the right path, unsure goes to queue, the queue flushes in order, abort is only called with the running turn id.

## Phase 3: portable skill (~1 hour)

`skills/gearshift/SKILL.md`:

- The frontmatter description triggers on any multi-step coding task.
- **Tier rubric:** the same three tiers and examples the mod uses, kept in one place in the README and copied into the skill.
- **Rule:** handle 1–2 step tasks inline. Delegate larger pieces to a subagent on the tier's model. Notes for each harness:
  - Claude Code: `Agent` tool `model` param
  - Codex: `--model` or profile
  - otherwise: just state the tier in the plan
- Inside Claude Code with the mod active, the skill says: "the mod already routes; skip".
- States plainly that interrupt triage needs the Claude Code mod.

## Phase 4: packaging and release (~2 hours)

1. `plugin.json`:
   - `userConfig`: `models.simple/everyday/hard`, `triage.unsure` (default `queue`), `stickiness` (default on), `enabled`
   - `types: ./types/index.d.ts`
2. `marketplace.json`: one entry, `source: "./"`.
3. 4b, only if Phase 0 step 4 failed: a tiny `bin/install.js` npm package `@joezhuo2/gearshift`. `npx @joezhuo2/gearshift install [--agent claude|codex|cursor|all]` copies `SKILL.md` into each agent's skills folder. No dependencies.
4. **CI** (`ci.yml`): `claude plugin validate .`, `tsc -p .`, `claude plugin test .`, plus a classifier eval on `evals/prompts.json` that fails below 85% accuracy. Run the eval only when `ANTHROPIC_API_KEY` is set.
5. **Release:** start at `v0.1.0`. A release bumps the version in `plugin.json`, `CHANGELOG.md` and the README (and `package.json` if 4b exists), then makes a local commit and tag. Push and tag only with your OK.
6. **Publish:** run `gh repo create joezhuo2/gearshift --public --source . --push` only after a secrets scan of the staged files and your go-ahead.

## README outline

1. One-line pitch and a 10-second GIF: an Opus→Haiku switch, then a mid-run "wait, use pnpm" interrupt.
2. Install: the Claude Code line, the desktop app steps (+ → Plugins → Add marketplace `joezhuo2/gearshift`), and the other-agents line.
3. How it works: the tier table, the queue vs interrupt rubric, stickiness and why it matters for cost.
4. Commands: `/gearshift`, `pin`, `off`, `now`, `drop`, and the `!opus` prefix.
5. Config: the `userConfig` keys with their defaults.
6. Compatibility: what works where (the mod is Claude Code only, the skill works everywhere).
7. Privacy and cost: classification uses one Haiku call per prompt, and nothing leaves the user's own API session.
8. Contributing, license.

## Risks

- **Prompt-cache cost:** switching the main model throws away cached context. Stickiness reduces this, and the README documents it.
- **Classifier latency:** if Haiku takes over ~1.5 s, triage feels slow. The fast path covers common cases, and a timeout falls back to queue.
- **Wrong interrupts:** this is the costliest mistake, which is why unsure goes to queue and `/gearshift now` gives a manual escape.
- **Mod API churn:** the mod API is new. Pin the minimum Claude Code version in the README and keep CI on the latest version.
- **Desktop app:** the `/plugin` line doesn't run in the Code tab, so the README needs the UI steps.

## Total

About 10 hours across phases 0–4. Phase 0 decides whether triage is buildable as designed.
