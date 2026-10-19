export type Tier = 'simple' | 'everyday' | 'hard'

export const TIERS: readonly Tier[] = ['simple', 'everyday', 'hard']

export const LABELS = [
  'simple-edit-docs-or-lookup',
  'everyday-feature-fix-or-tests',
  'hard-design-subtle-bug-or-security',
] as const

const HARD = /\b(architect\w*|system design|race condition|deadlock|concurren\w*|memory leak|root cause|security (audit|review)|threat model|algorithm|rewrite the|migrate (the|our) (whole|entire))\b/i
const SIMPLE = /\b(typo|rename|reformat|format|spelling|comment|docstring|readme|changelog|bump|version)\b/i
const ACK = /^(y|yes|yep|ok|okay|sure|go|go ahead|continue|do it|next|thanks|thank you|lgtm|ship it)[.!]*$/i

export type FastResult = Tier | 'keep' | undefined

export function fastTier(text: string): FastResult {
  const t = text.trim()
  if (ACK.test(t)) return 'keep'
  if (HARD.test(t)) return 'hard'
  if (t.length <= 120 && SIMPLE.test(t)) return 'simple'
  return undefined
}

export function tierFromLabel(label: string | undefined): Tier | undefined {
  const i = LABELS.findIndex(l => l === label)
  return i === -1 ? undefined : TIERS[i]
}

const OVERRIDE = /^!(haiku|sonnet|opus)\b\s*/i
const OVERRIDE_TIER: Record<string, Tier> = { haiku: 'simple', sonnet: 'everyday', opus: 'hard' }

export function parseOverride(text: string): { tier?: Tier; text: string } {
  const m = OVERRIDE.exec(text)
  return m ? { tier: OVERRIDE_TIER[(m[1] ?? '').toLowerCase()], text: text.slice(m[0].length) } : { text }
}

export type Sticky = { current?: Tier; lowerVotes: number }

export function applySticky(s: Sticky, suggested: Tier): Sticky {
  if (s.current === undefined || TIERS.indexOf(suggested) >= TIERS.indexOf(s.current)) {
    return { current: suggested, lowerVotes: 0 }
  }
  const votes = s.lowerVotes + 1
  return votes >= 2 ? { current: suggested, lowerVotes: 0 } : { current: s.current, lowerVotes: votes }
}
