import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { decisionFromLabel, fastTriage, flushPrompt, TRIAGE_LABELS } from './triage'

test('stop words interrupt without a model call', () => {
  expect(fastTriage('stop, use pnpm instead')).toBe('interrupt')
  expect(fastTriage('Wait — wrong file')).toBe('interrupt')
  expect(fastTriage('actually make it blue')).toBe('interrupt')
  expect(fastTriage('also add a test for the parser')).toBeUndefined()
})

test('labels map back to decisions', () => {
  expect(decisionFromLabel(TRIAGE_LABELS[0])).toBe('interrupt')
  expect(decisionFromLabel(TRIAGE_LABELS[1])).toBe('steer')
  expect(decisionFromLabel(TRIAGE_LABELS[2])).toBe('queue')
  expect(decisionFromLabel('maybe')).toBeUndefined()
})

test('flush keeps order and numbers several prompts', () => {
  expect(flushPrompt(['one'])).toBe('one')
  expect(flushPrompt(['one', 'two'])).toContain('1. one\n2. two')
})

type Log = { submitted: string[]; delivered: string[]; aborted: string[] }

function engine(on: On, triageLabel: string | undefined): Log {
  const log: Log = { submitted: [], delivered: [], aborted: [] }
  on('model.classify', ($, e) => ({
    value: e.labels.includes(TRIAGE_LABELS[0]) ? triageLabel : undefined,
  }))
  on('prompt.submit', ($, e) => {
    if (e.origin.kind === 'plugin') log.submitted.push(e.text)
    else log.delivered.push(e.text)
    return { text: e.text }
  })
  on('turn.abort', ($, e) => {
    log.aborted.push(e.turnId)
    return { value: undefined }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  return log
}

async function startTurn($: Engine, turnId: string, text: string) {
  await $.turn.start({ turnId, text })
}

async function endTurn($: Engine, turnId: string, isAborted = false) {
  await $.turn.complete({ turnId, answer: '', durationMs: 1, isAborted, reason: isAborted ? 'aborted' : 'answer' } as never)
}

async function typeMidTurn($: Engine, turnId: string, text: string, wait = false) {
  return $.prompt.submit({ text, turnId, wait, origin: { kind: 'composer' } } as never)
}

test('unrelated prompt is queued and sent when the task ends', async ($, on) => {
  const log = engine(on, TRIAGE_LABELS[2])
  await startTurn($, 't1', 'refactor the parser')
  await typeMidTurn($, 't1', 'then update the changelog')
  expect(log.delivered).toEqual([])
  expect(log.submitted).toEqual([])
  await endTurn($, 't1')
  expect(log.submitted).toEqual(['then update the changelog'])
})

test('related tweak steers the running turn', async ($, on) => {
  const log = engine(on, TRIAGE_LABELS[1])
  await startTurn($, 't1', 'refactor the parser')
  await typeMidTurn($, 't1', 'keep the old function names')
  expect(log.delivered).toEqual(['keep the old function names'])
  expect(log.aborted).toEqual([])
})

test('a stop word aborts the running turn and resubmits with context', async ($, on) => {
  const log = engine(on, undefined)
  await startTurn($, 't1', 'refactor the parser')
  await typeMidTurn($, 't1', 'stop, use the lexer from main instead')
  expect(log.aborted).toEqual(['t1'])
  expect(log.delivered).toEqual([])
  await endTurn($, 't1', true)
  expect(log.submitted.length).toBe(1)
  expect(log.submitted[0]).toContain('refactor the parser')
  expect(log.submitted[0]).toContain('use the lexer from main instead')
})

test('unsure triage falls back to queue', async ($, on) => {
  const log = engine(on, undefined)
  await startTurn($, 't1', 'refactor the parser')
  await typeMidTurn($, 't1', 'look at the docs folder too')
  expect(log.delivered).toEqual([])
  expect(log.aborted).toEqual([])
})

test('unsure triage can be set to steer', { options: { triage_unsure: 'steer' } }, async ($, on) => {
  const log = engine(on, undefined)
  await startTurn($, 't1', 'refactor the parser')
  await typeMidTurn($, 't1', 'look at the docs folder too')
  expect(log.delivered).toEqual(['look at the docs folder too'])
})

test('ctrl+x enter (wait) is never triaged', async ($, on) => {
  const log = engine(on, TRIAGE_LABELS[0])
  await startTurn($, 't1', 'refactor the parser')
  await typeMidTurn($, 't1', 'stop and do something else', true)
  expect(log.aborted).toEqual([])
  expect(log.delivered).toEqual(['stop and do something else'])
})

test('interrupt sends the steer before anything queued', async ($, on) => {
  const log = engine(on, TRIAGE_LABELS[2])
  await startTurn($, 't1', 'refactor the parser')
  await typeMidTurn($, 't1', 'update the changelog')
  await typeMidTurn($, 't1', 'stop, revert that last edit')
  await endTurn($, 't1', true)
  expect(log.submitted.length).toBe(2)
  expect(log.submitted[0]).toContain('revert that last edit')
  expect(log.submitted[1]).toBe('update the changelog')
})

test('several queued prompts flush as one numbered message', async ($, on) => {
  const log = engine(on, TRIAGE_LABELS[2])
  await startTurn($, 't1', 'refactor the parser')
  await typeMidTurn($, 't1', 'update the changelog')
  await typeMidTurn($, 't1', 'bump the version')
  await endTurn($, 't1')
  expect(log.submitted.length).toBe(1)
  expect(log.submitted[0]).toContain('1. update the changelog\n2. bump the version')
})
