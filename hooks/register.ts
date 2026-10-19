import type { EngineInterface, Register } from 'claude-code'

import { applySticky, fastTier, LABELS, parseOverride, tierFromLabel, TIERS } from './route'
import type { Sticky, Tier } from './route'

const CLASSIFY_TIMEOUT_MS = 3000

type Mode = 'auto' | 'off' | Tier

type State = {
  mode: Mode
  sticky: Sticky
  pending?: Promise<Tier | undefined>
  oneShot?: Tier
  lastReason: string
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
  const timeout = $.clock.sleep(CLASSIFY_TIMEOUT_MS).then(
    () => undefined,
    () => new Promise<undefined>(() => {}),
  )
  const label = await Promise.race([$.model.classify(text, LABELS, { model: 'haiku' }).catch(() => undefined), timeout])
  const tier = tierFromLabel(label)
  s.lastReason = tier ? 'haiku classifier' : 'classifier gave no answer, kept tier'
  return tier ?? s.sticky.current
}

export const register: Register = (on, options) => {
  const modelFor = (tier: Tier) => String(options[`model_${tier}`] ?? '')
  const s: State = { mode: options.enabled === false ? 'off' : 'auto', sticky: { lowerVotes: 0 }, lastReason: 'no prompt yet' }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'gearshift',
      description: 'Show or set model routing: /gearshift [auto|off|simple|everyday|hard]',
    })
    return next(e)
  })

  on('command.run', { command: 'gearshift' }, async ($, e) => {
    const arg = (e.args ?? '').trim().toLowerCase()
    if (arg === 'auto' || arg === 'off' || (TIERS as readonly string[]).includes(arg)) s.mode = arg as Mode
    else if (arg) return { text: `gearshift: unknown "${arg}". Use auto, off, simple, everyday or hard.` }
    if (s.mode === 'off') $.ui.status(undefined)
    const tier = s.sticky.current
    return {
      text: `gearshift mode: ${s.mode}. Current tier: ${tier ?? 'none'}${tier ? ` (${modelFor(tier)})` : ''}. Last decision: ${s.lastReason}.`,
    }
  })

  on('prompt.submit', async ($, e, next) => {
    if (s.mode === 'off' || e.turnId !== undefined || e.command || e.isMeta) return next(e)
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
