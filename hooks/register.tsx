import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Snapshot } from '../types'

import { applySticky, fastTier, heuristicTier, LABELS, parseOverride, tierFromLabel, TIERS } from './route'
import type { Sticky, Tier } from './route'
import { decisionFromLabel, fastTriage, flushPrompt, steerPrompt, TRIAGE_LABELS, triageInput } from './triage'
import type { Decision } from './triage'

const CLASSIFY_TIMEOUT_MS = 3000
const BLOCK_MS = 5 * 60 * 1000
const AGENT_TIMEOUT_MS = 12000
const AGENT_POLL_MS = 250

const PANE = 'gearshift'

const view = atom({ plugin: 'gearshift', key: 'snapshot' } as const, {
  mode: 'auto',
  tier: null,
  model: null,
  reason: 'no prompt yet',
  classifier: 'not called yet',
  queued: 0,
} as Snapshot)

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
  blockedUntil: Record<string, number>
  probeId?: string
  probe: string
  answers: Record<string, string>
}

async function viaAgent($: EngineInterface, s: State, text: string, labels: readonly string[]): Promise<string | { error: string }> {
  const prompt = ['Classify the text below. Reply with exactly one of these labels and nothing else:', ...labels, '', 'Text:', text].join('\n')
  const started = await $.agent.spawn({ prompt, description: 'gearshift classify', model: 'haiku' }).catch((err: unknown) => ({ error: String(err).slice(0, 120) }))
  if (!('agentId' in started) || !started.agentId) return { error: `spawn returned ${JSON.stringify(started).slice(0, 100)}` }
  const id = started.agentId
  for (let waited = 0; waited < AGENT_TIMEOUT_MS; waited += AGENT_POLL_MS) {
    const answer = s.answers[id]
    if (answer !== undefined) {
      delete s.answers[id]
      return labels.find(l => answer.includes(l)) ?? { error: `agent answered "${answer.slice(0, 60)}"` }
    }
    await $.clock.sleep(AGENT_POLL_MS).catch(() => undefined)
  }
  return { error: 'agent timed out' }
}

async function pick($: EngineInterface, s: State, text: string, labels: readonly string[]): Promise<string | undefined> {
  const candidates = [s.classifierModel ?? '', 'sonnet', 'agent'].filter((m, i, all) => all.indexOf(m) === i)
  const notes: string[] = []
  for (const model of candidates) {
    const key = `classifier:${model}`
    if ((s.blockedUntil[key] ?? 0) > Date.now()) {
      notes.push(`${model || 'default'} paused after an error`)
      continue
    }
    const started = Date.now()
    let result: string | undefined | { error: string }
    if (model === 'agent') {
      result = await viaAgent($, s, text, labels)
    } else {
      const timeout = $.clock.sleep(CLASSIFY_TIMEOUT_MS).then(
        () => ({ error: 'timed out' }),
        () => new Promise<never>(() => {}),
      )
      result = await Promise.race([
        $.model.classify(text, labels, model ? { model } : undefined).catch((err: unknown) => ({ error: String(err).slice(0, 120) })),
        timeout,
      ])
    }
    const ms = Date.now() - started
    if (typeof result === 'string') {
      s.classifier = `${model === 'agent' ? 'haiku subagent' : model || 'default'} answered in ${ms} ms`
      return result
    }
    if (result === undefined) {
      s.classifier = `${model || 'default'} answered no label in ${ms} ms`
      return undefined
    }
    s.blockedUntil[key] = Date.now() + BLOCK_MS
    notes.push(`${model === 'agent' ? 'subagent' : model || 'default'}: ${result.error}`)
  }
  s.classifier = notes.join('; ')
  return undefined
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
  const tier = tierFromLabel(await pick($, s, text, LABELS))
  if (tier) {
    s.lastReason = 'classifier'
    return tier
  }
  s.lastReason = 'no model available to classify, used keyword rules'
  return heuristicTier(text)
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

async function publish($: EngineInterface, snapshot: Snapshot) {
  await update($, view, () => snapshot)
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
    blockedUntil: {},
    probe: 'not run',
    answers: {},
  }
  const usable = (model: string) => model !== '' && (s.blockedUntil[model] ?? 0) < Date.now()
  const snap = (): Snapshot => {
    const tier = s.oneShot ?? (s.mode === 'auto' ? s.sticky.current : s.mode === 'off' ? undefined : s.mode)
    return {
      mode: s.mode,
      tier: tier ?? null,
      model: tier ? modelFor(tier) : null,
      reason: s.lastReason,
      classifier: s.classifier,
      queued: s.queue.length,
    }
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'gearshift',
      description: 'Model routing and triage: /gearshift [auto|off|simple|everyday|hard|now|drop|panel]',
      immediate: true,
    })
    await publish($, snap())
    return next(e)
  })

  on('command.run', { command: 'gearshift' }, async ($, e) => {
    const arg = (e.args ?? '').trim().toLowerCase()
    if (arg === 'panel') {
      await $.ui.open({ id: PANE, title: 'gearshift' })
      return { text: 'gearshift: panel opened.' }
    }
    if (arg === 'probe') {
      s.probe = 'running'
      const started = await $.agent
        .spawn({ prompt: 'Reply with exactly one word: ok', description: 'gearshift probe', model: 'haiku' })
        .catch((err: unknown) => ({ error: String(err).slice(0, 200) }))
      s.probeId = 'agentId' in started ? started.agentId : undefined
      if (!s.probeId) s.probe = `spawn returned ${JSON.stringify(started).slice(0, 200)}`
      return { text: `gearshift: spawn returned ${JSON.stringify(started).slice(0, 200)}. Run /gearshift in a few seconds.` }
    }
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
    else if (arg) return { text: `gearshift: unknown "${arg}". Use auto, off, simple, everyday, hard, now, drop or panel.` }
    if (s.mode === 'off') $.ui.status(undefined)
    await publish($, snap())
    const tier = s.sticky.current
    return {
      text: `gearshift mode: ${s.mode}. Current tier: ${tier ?? 'none'}${tier ? ` (${modelFor(tier)})` : ''}. Last decision: ${s.lastReason}. Classifier: ${s.classifier}. Subagent probe: ${s.probe}. Queued: ${s.queue.length}.`,
    }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) s.running = { turnId: e.turnId, text: e.text || s.running?.text || '' }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) {
      s.answers[e.agentId] = e.reason === 'answer' ? e.answer : ''
      if (e.agentId === s.probeId) s.probe = e.reason === 'answer' ? `ok, answered "${e.answer.slice(0, 40)}"` : `ended: ${e.reason}`
    }
    if (e.agentId === undefined && s.running?.turnId === e.turnId) {
      s.running = undefined
      await flush($, s)
      await publish($, snap())
    }
    return done
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta) return next(e)

    if (e.turnId !== undefined) {
      if (options.triage_enabled === false || e.wait || e.origin.kind !== 'composer' || !s.running) return next(e)
      const decision =
        fastTriage(e.text) ?? decisionFromLabel(await pick($, s, triageInput(s.running.text, e.text), TRIAGE_LABELS)) ?? unsure
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
      await publish($, snap())
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
    if (e.index === 0) await publish($, snap())
    if (!tier || !usable(model) || model === e.model) return yield* next(e)
    $.ui.status(`⚙ ${tier} · ${model.replace(/^claude-/, '')}`)
    try {
      return yield* next({ ...e, model })
    } catch (err) {
      s.blockedUntil[model] = Date.now() + BLOCK_MS
      s.lastReason = `${model} failed (${String(err).slice(0, 80)}), used the session model for 5 min`
      $.ui.toast(`gearshift: ${model} unavailable, using the session model`)
      await publish($, snap())
      return yield* next(e)
    }
  })

  on('agent.spawn', async ($, e, next) => {
    if (s.mode === 'off' || e.model !== undefined) return next(e)
    const tier = s.mode === 'auto' ? await classify($, s, e.prompt) : s.mode
    return tier && usable(modelFor(tier)) ? next({ ...e, model: modelFor(tier) }) : next(e)
  })

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const v = await read($, view)
    if (v.mode === 'off' || !v.tier) return next(e)
    return next({ ...e, props: { ...e.props, modes: [...e.props.modes, `gearshift: ${v.tier}`] } })
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const v = await read($, view)
    if (v.mode === 'off') return next(e)
    const routed = v.tier ? `${v.tier} · ${(v.model ?? '').replace(/^claude-/, '')}` : 'session model'
    const tag = `⚙ ${routed}${v.queued ? ` · ${v.queued} queued` : ''}`
    return next({ ...e, props: { ...e.props, hint: e.props.hint ? `${tag} · ${e.props.hint}` : tag } })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const v = await read($, view)
    return (
      <Box flexDirection="column">
        <Text bold>{v.tier ? `${v.tier} · ${(v.model ?? '').replace(/^claude-/, '')}` : 'no tier yet (session model)'}</Text>
        <Text dimColor>mode: {v.mode}</Text>
        <Text dimColor>why: {v.reason}</Text>
        <Text dimColor>classifier: {v.classifier}</Text>
        <Text dimColor>queued: {String(v.queued)}</Text>
      </Box>
    )
  })
}
