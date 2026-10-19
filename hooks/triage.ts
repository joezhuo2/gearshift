export type Decision = 'interrupt' | 'steer' | 'queue'

export const TRIAGE_LABELS = [
  'interrupt-cancels-or-contradicts-current-task',
  'steer-small-tweak-to-current-task',
  'queue-separate-task-for-later',
] as const

const DECISIONS: readonly Decision[] = ['interrupt', 'steer', 'queue']

const STOP = /^(stop|wait|cancel|abort|halt|hold on|hang on|nevermind|never mind|no[,.!]|nope|wrong|actually|instead)\b/i

export function fastTriage(text: string): Decision | undefined {
  return STOP.test(text.trim()) ? 'interrupt' : undefined
}

export function decisionFromLabel(label: string | undefined): Decision | undefined {
  const i = TRIAGE_LABELS.findIndex(l => l === label)
  return i === -1 ? undefined : DECISIONS[i]
}

export function triageInput(currentTask: string, message: string): string {
  return `Task the agent is working on now:\n${currentTask.slice(0, 2000)}\n\nNew message from the user:\n${message}`
}

export function steerPrompt(currentTask: string, message: string): string {
  return `I interrupted you. You were working on: "${currentTask.slice(0, 500)}". Keep any useful progress, but change direction:\n\n${message}`
}

export function flushPrompt(queue: readonly string[]): string {
  if (queue.length === 1) return queue[0] ?? ''
  return `Requests I sent while you were busy, in order:\n${queue.map((q, i) => `${i + 1}. ${q}`).join('\n')}`
}
