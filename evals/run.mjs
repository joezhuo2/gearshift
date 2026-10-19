// Classifier accuracy eval. Uses the local Claude Code CLI (claude -p), so no API key is needed.
// Usage: node evals/run.mjs [model]   (default haiku)
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const LABELS = {
  simple: 'simple-edit-docs-or-lookup',
  everyday: 'everyday-feature-fix-or-tests',
  hard: 'hard-design-subtle-bug-or-security',
}
const model = process.argv[2] ?? 'haiku'
const cases = JSON.parse(readFileSync(new URL('./prompts.json', import.meta.url), 'utf8'))
const labels = Object.values(LABELS)

function classify(text) {
  const prompt = ['Classify the text below. Reply with exactly one of these labels and nothing else:', ...labels, '', 'Text:', text].join('\n')
  const env = { ...process.env }
  delete env.ANTHROPIC_API_KEY
  const r = spawnSync('claude', ['-p', prompt, '--model', model], { encoding: 'utf8', env, shell: process.platform === 'win32' })
  if (r.error || r.status !== 0) throw new Error(`claude -p failed: ${(r.error?.message ?? r.stderr ?? '').slice(0, 200)}`)
  const answer = r.stdout.trim()
  const tier = Object.keys(LABELS).find(t => answer.includes(LABELS[t]))
  return { tier, answer }
}

const counts = { simple: [0, 0], everyday: [0, 0], hard: [0, 0] }
let correct = 0
const misses = []
for (const c of cases) {
  const { tier, answer } = classify(c.text)
  counts[c.tier][1]++
  if (tier === c.tier) { correct++; counts[c.tier][0]++ } else misses.push({ text: c.text, want: c.tier, got: tier ?? `no label: ${answer.slice(0, 60)}` })
}

console.log(`model ${model}: ${correct}/${cases.length} correct (${((100 * correct) / cases.length).toFixed(1)}%)`)
for (const [t, [ok, n]] of Object.entries(counts)) console.log(`  ${t}: ${ok}/${n}`)
for (const m of misses) console.log(`  miss: want ${m.want}, got ${m.got}: "${m.text}"`)
console.log(correct / cases.length >= 0.85 ? 'PASS (>= 85%)' : 'FAIL (< 85%)')
process.exitCode = correct / cases.length >= 0.85 ? 0 : 1
