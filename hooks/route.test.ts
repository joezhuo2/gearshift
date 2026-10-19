import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { applySticky, fastTier, LABELS, parseOverride, tierFromLabel } from './route'

test('fast path catches obvious tiers and follow-ups', () => {
  expect(fastTier('fix the typo in README')).toBe('simple')
  expect(fastTier('find the race condition in the job queue')).toBe('hard')
  expect(fastTier('yes')).toBe('keep')
  expect(fastTier('continue')).toBe('keep')
  expect(fastTier('add a dark mode toggle to settings')).toBeUndefined()
})

test('long prompts never take the simple fast path', () => {
  expect(fastTier(`rename ${'x'.repeat(200)}`)).toBeUndefined()
})

test('labels map back to tiers', () => {
  expect(tierFromLabel(LABELS[0])).toBe('simple')
  expect(tierFromLabel(LABELS[2])).toBe('hard')
  expect(tierFromLabel('nonsense')).toBeUndefined()
  expect(tierFromLabel(undefined)).toBeUndefined()
})

test('!model prefix overrides and is stripped', () => {
  expect(parseOverride('!opus design the cache')).toEqual({ tier: 'hard', text: 'design the cache' })
  expect(parseOverride('!Haiku fix typo')).toEqual({ tier: 'simple', text: 'fix typo' })
  expect(parseOverride('no override')).toEqual({ text: 'no override' })
})

test('sticky: escalates at once, downgrades after two votes', () => {
  let s = applySticky({ lowerVotes: 0 }, 'everyday')
  expect(s.current).toBe('everyday')
  s = applySticky(s, 'hard')
  expect(s.current).toBe('hard')
  s = applySticky(s, 'simple')
  expect(s.current).toBe('hard')
  s = applySticky(s, 'simple')
  expect(s.current).toBe('simple')
})

test('sticky: a higher vote resets the downgrade count', () => {
  let s = applySticky({ current: 'hard', lowerVotes: 0 }, 'simple')
  s = applySticky(s, 'hard')
  s = applySticky(s, 'simple')
  expect(s.current).toBe('hard')
})

function engine(on: On, label: string, seen: string[], fail: { classify?: boolean; model?: string; calls?: { n: number } } = {}) {
  on('model.classify', () => {
    if (fail.calls) fail.calls.n += 1
    if (fail.classify) throw new Error('HTTP 429 rate_limit')
    return { value: label }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.step', async function* ($, e) {
    if (e.model === fail.model) throw new Error('HTTP 429 rate_limit')
    seen.push(e.model)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
}

async function submit($: Engine, text: string) {
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
}

async function step($: Engine, turnId: string) {
  for await (const _ of $.turn.step({ turnId, index: 0, model: 'engine-default', messageCount: 1 })) {
  }
}

test('routes a hard prompt to the hard model', async ($, on) => {
  const seen: string[] = []
  engine(on, LABELS[2], seen)
  await submit($, 'please look at how the scheduler shares state between workers')
  await step($, 't1')
  expect(seen).toEqual(['claude-opus-5-5'])
})

test('routes an everyday prompt to the everyday model', async ($, on) => {
  const seen: string[] = []
  engine(on, LABELS[1], seen)
  await submit($, 'add a dark mode toggle to the settings page')
  await step($, 't1')
  expect(seen).toEqual(['claude-sonnet-5-5'])
})

test('respects the configured model map', { options: { model_simple: 'my-small-model' } }, async ($, on) => {
  const seen: string[] = []
  engine(on, LABELS[0], seen)
  await submit($, 'fix the typo in README')
  await step($, 't1')
  expect(seen).toEqual(['my-small-model'])
})

test('/gearshift off passes the engine model through', async ($, on) => {
  const seen: string[] = []
  engine(on, LABELS[0], seen)
  await $.command.run({ command: 'gearshift', args: 'off', origin: { kind: 'composer' }, presentation: 'text' } as never)
  await submit($, 'fix the typo in README')
  await step($, 't1')
  expect(seen).toEqual(['engine-default'])
})

test('a classifier failure keeps the session model', async ($, on) => {
  const seen: string[] = []
  engine(on, LABELS[0], seen, { classify: true })
  await submit($, 'in one line, suggest a name for a cat')
  await step($, 't1')
  expect(seen).toEqual(['engine-default'])
})

test('a failing routed model falls back to the session model', async ($, on) => {
  const seen: string[] = []
  engine(on, LABELS[0], seen, { model: 'claude-haiku-5-5' })
  await submit($, 'in one word, what is the capital of France?')
  await step($, 't1')
  await submit($, 'in one word, what is the capital of Spain?')
  await step($, 't2')
  expect(seen).toEqual(['engine-default', 'engine-default'])
})

test('a rate-limited classifier is paused instead of called every prompt', async ($, on) => {
  const seen: string[] = []
  const calls = { n: 0 }
  engine(on, LABELS[0], seen, { classify: true, calls })
  await submit($, 'add a dark mode toggle to the settings page')
  await step($, 't1')
  const first = calls.n
  await submit($, 'add a light mode toggle to the settings page')
  await step($, 't2')
  expect(first).toBe(2)
  expect(calls.n).toBe(first)
})
