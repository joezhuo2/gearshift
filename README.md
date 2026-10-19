<h1 align="center">gearshift</h1>

<p align="center">
  <em>Cheaper where it can be, smarter where it counts.</em>
</p>

<p align="center">
  <a href="https://github.com/joezhuo2/gearshift/stargazers"><img src="https://img.shields.io/github/stars/joezhuo2/gearshift?style=flat-square&logo=github" alt="GitHub stars"></a>
  <a href="https://github.com/joezhuo2/gearshift/releases"><img src="https://img.shields.io/github/downloads/joezhuo2/gearshift/total?style=flat-square&logo=github" alt="Release downloads"></a>
  <a href="https://github.com/joezhuo2/gearshift/blob/main/LICENSE"><img src="https://img.shields.io/github/license/joezhuo2/gearshift?style=flat-square" alt="License"></a>
  <a href="https://github.com/joezhuo2/gearshift/releases/latest"><img src="https://img.shields.io/github/v/release/joezhuo2/gearshift?style=flat-square" alt="Latest version"></a>
  <a href="https://github.com/joezhuo2/gearshift#-requirements"><img src="https://img.shields.io/badge/node-%3E%3D18-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js 18+"></a>
</p>
  
<p align="center">
  <a href="#-requirements">Requirements</a> •
  <a href="#-install">Install</a> •
  <a href="#-how-routing-works">Routing</a> •
  <a href="#-how-triage-works">Triage</a> •
  <a href="#-configuration">Configuration</a> •
  <a href="#-token-usage">Token Usage</a> •
  <a href="#-privacy">Privacy</a> •
  <a href="#-troubleshooting">Troubleshooting</a> •
  <a href="#-development">Development</a>
</p>

<p align="center">
  gearshift runs two jobs in the background, so you never pick a model or babysit a queue. Routing sends each prompt to the model that fits it: Haiku for simple work, Sonnet for everyday work, Opus for hard work, subagents included. Triage decides whether a prompt typed mid-run should interrupt, steer, or queue behind the current task.
</p>

## 📋 Requirements

- Claude Code with plugin mod support (built and tested against Claude Code 2.1.299). gearshift runs as a mod, so it only works inside Claude Code: the CLI, the desktop app's Code tab, and the IDE extensions.
- Access to the models you route to. By default that is `claude-haiku-5-5`, `claude-sonnet-5-5` and `claude-opus-5-5`. If one is unavailable on your plan, gearshift falls back to your session model (see [Fallbacks](#-fallbacks)).
- Node.js 18+ only if you install through `npx`/`npm`.

No API key or build step is needed. gearshift uses your existing Claude Code session.

## 🚀 Install

### ⚡ npx (one command)

```bash
npx gearshift
```

This runs `claude plugin marketplace add joezhuo2/gearshift` and `claude plugin install gearshift@gearshift` for you. Restart Claude Code (or start a new session) so the mod loads.

Prefer a global install?

```bash
npm install -g gearshift
gearshift install
```

`gearshift update` and `gearshift uninstall` work the same way (`npx gearshift update`, `npx gearshift uninstall`).

### 🖥️ Claude Code CLI (manual)

```
/plugin marketplace add joezhuo2/gearshift
/plugin install gearshift@gearshift
```

Restart Claude Code (or start a new session) so the mod loads.

### 🪟 Claude desktop app (Code tab)

The `/plugin` command does not run in the Code tab, so use the UI:

1. Click **+** next to the prompt box, then **Plugins**.
2. Choose **Add marketplace** and enter `joezhuo2/gearshift`.
3. Install **gearshift** from that marketplace.
4. Start a new session.

### ✅ Check it works

Run `/gearshift`. You should see a line like:

```
gearshift mode: auto. Current tier: none. Last decision: no prompt yet. ...
```

After your next prompt, the prompt hint shows the routed model, for example `⚙ everyday · sonnet-5-5`.

### 🔄 Update

```bash
npx gearshift update
```

This refreshes the marketplace and updates the plugin to the latest release. Restart Claude Code (or start a new session) so the new version loads.

Inside Claude Code CLI, run:

```
/plugin marketplace update gearshift
/plugin update gearshift@gearshift
```

To see the newest version, check the [latest release](https://github.com/joezhuo2/gearshift/releases/latest).

### 🗑️ Uninstall

```bash
npx gearshift uninstall
```

Or, inside Claude Code:

```
/plugin uninstall gearshift@gearshift
```

## 🧭 How routing works

Every prompt you send gets a tier:

| Tier | Default model | Typical work |
| --- | --- | --- |
| 🟢 `simple` | `claude-haiku-5-5` | Typos, renames, formatting, docs, version bumps, quick lookups |
| 🟡 `everyday` | `claude-sonnet-5-5` | Features, clear bug fixes, tests, refactors with a clear spec |
| 🔴 `hard` | `claude-opus-5-5` | Architecture, race conditions, memory leaks, root-cause debugging, security reviews |

The tier is picked in this order:

1. **Override prefix.** `!haiku`, `!sonnet` or `!opus` at the start of a prompt forces that model for that one prompt. The prefix is stripped before the agent sees it.
2. **Keyword fast path.** No model call. Words like "architecture", "race condition", "root cause" or "security review" mean `hard`. Short prompts (120 characters or less) with words like "typo", "rename", "readme" or "bump" mean `simple`. Short acknowledgements ("ok", "yes", "go ahead", "continue") keep the current tier.
3. **Classifier.** Anything else is labelled by a small model call (see [Classifier](#-classifier)).

### 🧲 Stickiness

Switching the main model throws away the prompt cache, which costs tokens. So gearshift is sticky:

- It moves **up** a tier immediately when a prompt needs it.
- It moves **down** only after two prompts in a row suggest a lower tier.

### 🤖 Subagents

When the agent spawns a subagent without choosing a model, gearshift classifies the subagent's prompt and picks the model. If the caller already chose a model, gearshift leaves it alone.

## 🚦 How triage works

When you send a prompt while a task is running, gearshift picks one of three paths:

| Decision | When | What happens |
| --- | --- | --- |
| 🛑 **interrupt** | The prompt cancels, contradicts or redirects the task ("stop", "wait, use pnpm", "wrong file") | The running turn is aborted, then the agent gets your new prompt along with what it was doing, so it can keep useful progress |
| 🧭 **steer** | A small tweak to the current task | The prompt goes into the running turn (Claude Code's normal behavior) |
| 📥 **queue** | A separate task for later | The prompt is held and sent when the current task finishes. Several queued prompts are sent together as one numbered list |

Prompts starting with "stop", "wait", "cancel", "hold on", "never mind", "no", "wrong", "actually" or "instead" interrupt immediately with no model call. Others go to the classifier. If the classifier can't decide, the prompt is queued (configurable with `triage_unsure`).

gearshift never interrupts when you explicitly queue a prompt with `ctrl+x enter`.

## 💬 Commands

| Command | What it does |
| --- | --- |
| `/gearshift` | Show mode, current tier and model, why it was picked, classifier status and queue size |
| `/gearshift auto` | Route automatically (default) |
| `/gearshift simple` / `everyday` / `hard` | Pin every prompt to one tier |
| `/gearshift off` | Stop routing and use the session model |
| `/gearshift now` | Send the newest queued prompt right away (interrupts the running task) |
| `/gearshift drop` | Clear the queue |
| `/gearshift panel` | Open a side panel with live status |
| `/gearshift probe` | Diagnostic: checks that a Haiku subagent can be spawned |

`/gearshift` runs immediately, even while a task is running.

## 🔧 Configuration

Set these in the plugin's settings after install (in the CLI, through `/plugin`; in the desktop app, from the plugin's entry under **Plugins**).

| Key | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Route prompts automatically. `false` starts in `off` mode |
| `model_simple` | `claude-haiku-5-5` | Model for simple work |
| `model_everyday` | `claude-sonnet-5-5` | Model for everyday work |
| `model_hard` | `claude-opus-5-5` | Model for hard work |
| `classifier_model` | empty | Model that labels prompts. Empty uses Claude Code's own small fast model |
| `triage_enabled` | `true` | Triage prompts sent while a task runs. `false` keeps Claude Code's default (steer) |
| `triage_unsure` | `queue` | What to do when triage can't decide: `queue` or `steer` |

## 🧠 Classifier

When the keyword fast path doesn't match, gearshift asks a model to label the prompt. It tries, in order:

1. `classifier_model` if set, otherwise Claude Code's default small fast model
2. `sonnet`
3. A short Haiku subagent

Each attempt has a timeout (3 seconds for direct calls, 12 seconds for the subagent). A classifier that errors is skipped for 5 minutes. If none answers, gearshift keeps the current tier (routing) or uses `triage_unsure` (triage).

## 🛟 Fallbacks

If a routed model fails (for example, your plan doesn't include it), gearshift retries the step on your session model, shows a toast, and avoids that model for 5 minutes. Your work is never blocked by routing.

## 📊 Token usage

gearshift aims to spend less overall by running simple work on cheaper models. It also adds some overhead of its own:

- **Classifier calls.** One small labelling call per prompt that misses the keyword fast path, and one per mid-run prompt that isn't an obvious "stop/wait". Override prefixes, keyword matches and acknowledgements cost nothing extra.
- **Prompt cache.** Each switch of the main model starts a fresh prompt cache. Stickiness keeps switches rare.
- **Interrupts.** An interrupt resubmits a short summary of the old task (up to 500 characters) with your new prompt.

### 📈 Measured results

> Results pending. Numbers below will be filled in from real sessions.

Test setup: _TBD (Claude Code version, task mix, number of sessions)_

| Scenario | Without gearshift | With gearshift | Difference |
| --- | --- | --- | --- |
| Input tokens | _TBD_ | _TBD_ | _TBD_ |
| Output tokens | _TBD_ | _TBD_ | _TBD_ |
| Cache reads | _TBD_ | _TBD_ | _TBD_ |
| Classifier overhead | n/a | _TBD_ | _TBD_ |
| Estimated cost | _TBD_ | _TBD_ | _TBD_ |

Tier mix across the test prompts: _TBD (% simple / everyday / hard)_

## 🔒 Privacy

gearshift runs locally inside Claude Code. Classification uses the same Claude session and account you're already using. Nothing is sent to any other service, and gearshift stores no data outside the session.

## 🩺 Troubleshooting

- **Hint never shows a model.** Run `/gearshift`. If mode is `off`, run `/gearshift auto`. If the tier is `none`, send a prompt first.
- **Classifier shows errors.** Run `/gearshift` to see which classifier failed and why. Set `classifier_model` to a model your plan includes, or run `/gearshift probe` to check subagent spawning.
- **Too many interrupts.** Set `triage_unsure` to `steer`, or set `triage_enabled` to `false`.
- **Want one prompt on a specific model.** Start it with `!haiku`, `!sonnet` or `!opus`.

## 🧪 Development

```bash
git clone https://github.com/joezhuo2/gearshift
cd gearshift
claude plugin validate .
claude plugin test .
```

Source lives in `hooks/`: `route.ts` (tiers, keywords, stickiness), `triage.ts` (interrupt/steer/queue) and `register.tsx` (the mod wiring). Tests sit next to each file.

## 📄 License

[MIT](LICENSE)
