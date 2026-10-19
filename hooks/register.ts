import type { EngineInterface, Register } from 'claude-code'

import { applySticky, fastTier, LABELS, parseOverride, tierFromLabel, TIERS } from './route'
import type { Sticky, Tier } from './route'
import { decisionFromLabel, fastTriage, flushPrompt, steerPrompt, TRIAGE_LABELS, triageInput } from './triage'
import type { Decision } from './triage'

const CLASSIFY_TIMEOUT_MS = 3000

type Mode = 'auto' | 'off' | Tier

type State = {
  mode: Mode
  sticky: Sticky
  pending?: Promise<Tier | undefined>
  oneShot?: Tier
  lastReason: string
  running?: { turnId: string; text: string }
  queue: string[]
  steer?: string
  classifier: string
  classifierModel?: string
}

async function pick($: EngineInterface, s: State, text: string, labels: readonly string[], model?: string): Promise<string | undefined> {
  const timeout = $.clock.sleep(CLASSIFY_TIMEOUT_MS).then(
    () => 'timeout' as const,
    () => new Promise<never>(() => {}),
  )
  const started = Date.now()
  const result = await Promise.race([
    $.model.classify(text, labels, model ? { model } : undefined).catch((err: unknown) => ({ error: String(err).slice(0, 200) })),
    timeout,
  ])
  const ms = Date.now() - started
  if (result === 'timeout') s.classifier = `timed out after ${ms} ms`
  else if (typeof result === 'object') s.classifier = `failed after ${ms} ms: ${result.error}`
  else s.classifier = `answered ${result ?? 'no matching label'} in ${ms} ms`
  return typeof result === 'string' && result !== 'timeout' ? result : undefined
}

async function classify($: EngineInterface, s: State, text: string): Promise<Tier | undefined> {
  const fast = fastTier(text)
  if (fast === 'keep') {
    s.lastReason = 'follow-up, kept tier'
    return s.sticky.current
  }
  if (fast !== undefined) {
    s.lastReason = 'keyword match'
    return fast
  }
  const tier = tierFromLabel(await pick($, s, text, LABELS, s.classifierModel))
  s.lastReason = tier ? 'haiku classifier' : 'classifier gave no answer, kept tier'
  return tier ?? s.sticky.current
}

async function interrupt($: EngineInterface, s: State, message: string) {
  const running = s.running
  if (!running) return
  s.steer = steerPrompt(running.text, message)
  await $.turn.abort({ turnId: running.turnId })
}

async function flush($: EngineInterface, s: State) {
  const steer = s.steer
  s.steer = undefined
  if (steer) await $.prompt.submit({ text: steer, asUser: true })
  if (s.queue.length === 0) return
  const text = flushPrompt(s.queue)
  s.queue = []
  await $.prompt.submit({ text, asUser: true })
}

export const register: Register = (on, options) => {
  const modelFor = (tier: Tier) => String(options[`model_${tier}`] ?? '')
  const unsure: Decision = options.triage_unsure === 'steer' ? 'steer' : 'queue'
  const s: State = {
    mode: options.enabled === false ? 'off' : 'auto',
    sticky: { lowerVotes: 0 },
    lastReason: 'no prompt yet',
    queue: [],
    classifier: 'not called yet',
    classifierModel: String(options.classifier_model ?? '') || undefined,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'gearshift',
      description: 'Model routing and triage: /gearshift [auto|off|simple|everyday|hard|now|drop]',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'gearshift' }, async ($, e) => {
    const arg = (e.args ?? '').trim().toLowerCase()
    if (arg === 'now') {
      const last = s.queue.pop()
      if (!last) return { text: 'gearshift: nothing queued.' }
      if (s.running) await interrupt($, s, last)
      else await $.prompt.submit({ text: last, asUser: true })
      return { text: 'gearshift: sent the last queued prompt now.' }
    }
    if (arg === 'drop') {
      const n = s.queue.length
      s.queue = []
      return { text: `gearshift: dropped ${n} queued prompt${n === 1 ? '' : 's'}.` }
    }
    if (arg === 'auto' || arg === 'off' || (TIERS as readonly string[]).includes(arg)) s.mode = arg as Mode
    else if (arg) return { text: `gearshift: unknown "${arg}". Use auto, off, simple, everyday, hard, now or drop.` }
    if (s.mode === 'off') $.ui.status(undefined)
    const tier = s.sticky.current
    return {
      text: `gearshift mode: ${s.mode}. Current tier: ${tier ?? 'none'}${tier ? ` (${modelFor(tier)})` : ''}. Last decision: ${s.lastReason}. Classifier: ${s.classifier}. Queued: ${s.queue.length}.`,
    }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) s.running = { turnId: e.turnId, text: e.text || s.running?.text || '' }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && s.running?.turnId === e.turnId) {
      s.running = undefined
      await flush($, s)
    }
    return done
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta) return next(e)

    if (e.turnId !== undefined) {
      if (options.triage_enabled === false || e.wait || e.origin.kind !== 'composer' || !s.running) return next(e)
      const decision =
        fastTriage(e.text) ?? decisionFromLabel(await pick($, s, triageInput(s.running.text, e.text), TRIAGE_LABELS, s.classifierModel)) ?? unsure
      if (decision === 'steer') {
        $.ui.toast('gearshift: steering the current task')
        return next(e)
      }
      if (decision === 'interrupt') {
        $.ui.toast('gearshift: interrupting to change direction')
        await interrupt($, s, e.text)
        return { drop: 'gearshift: interrupted and resubmitted' }
      }
      s.queue.push(e.text)
      $.ui.toast(`gearshift: queued (${s.queue.length}) until this task finishes. /gearshift now to send it now`)
      return { drop: 'gearshift: queued until the current task finishes' }
    }

    if (s.mode === 'off') return next(e)
    const { tier, text } = parseOverride(e.text)
    if (tier) {
      s.oneShot = tier
      s.lastReason = `!${modelFor(tier)} override`
      return next({ ...e, text })
    }
    s.oneShot = undefined
    s.pending = s.mode === 'auto' ? classify($, s, text) : undefined
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (s.mode === 'off' || e.agentId !== undefined) return yield* next(e)
    if (e.index === 0 && s.pending) {
      const suggested = await s.pending
      s.pending = undefined
      if (suggested) s.sticky = applySticky(s.sticky, suggested)
    }
    const tier = s.oneShot ?? (s.mode === 'auto' ? s.sticky.current : s.mode)
    const model = tier ? modelFor(tier) : ''
    if (!tier || !model) return yield* next(e)
    $.ui.status(`⚙ ${tier} · ${model.replace(/^claude-/, '')}`)
    return yield* next({ ...e, model })
  })

  on('agent.spawn', async ($, e, next) => {
    if (s.mode === 'off' || e.model !== undefined) return next(e)
    const tier = s.mode === 'auto' ? await classify($, s, e.prompt) : s.mode
    return tier ? next({ ...e, model: modelFor(tier) }) : next(e)
  })
}
