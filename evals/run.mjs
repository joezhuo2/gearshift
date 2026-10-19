// Classifier accuracy eval. Needs ANTHROPIC_API_KEY.
// Usage: node evals/run.mjs [model]   (default claude-haiku-5-5)
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const LABELS = {
  simple: 'simple-edit-docs-or-lookup',
  everyday: 'everyday-feature-fix-or-tests',
  hard: 'hard-design-subtle-bug-or-security',
}
const key = process.env.ANTHROPIC_API_KEY
if (!key) throw new Error('ANTHROPIC_API_KEY is not set')
const model = process.argv[2] ?? 'claude-haiku-5-5'
const cases = JSON.parse(readFileSync(new URL('./prompts.json', import.meta.url), 'utf8'))
const labels = Object.values(LABELS)

async function classify(text) {
  const prompt = ['Classify the text below. Reply with exactly one of these labels and nothing else:', ...labels, '', 'Text:', text].join('\n')
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 40, messages: [{ role: 'user', content: prompt }] }),
  })
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = await res.json()
  const answer = data.content?.find(b => b.type === 'text')?.text ?? ''
  const tier = Object.keys(LABELS).find(t => answer.includes(LABELS[t]))
  return { tier, answer }
}

const counts = { simple: [0, 0], everyday: [0, 0], hard: [0, 0] }
let correct = 0
const misses = []
for (const c of cases) {
  const { tier, answer } = await classify(c.text)
  const ok = tier === c.tier
  counts[c.tier][1]++
  if (ok) { correct++; counts[c.tier][0]++ } else misses.push({ text: c.text, want: c.tier, got: tier ?? `no label: ${answer.slice(0, 60)}` })
}

console.log(`model ${model}: ${correct}/${cases.length} correct (${((100 * correct) / cases.length).toFixed(1)}%)`)
for (const [t, [ok, n]] of Object.entries(counts)) console.log(`  ${t}: ${ok}/${n}`)
for (const m of misses) console.log(`  miss: want ${m.want}, got ${m.got}: "${m.text}"`)
console.log(correct / cases.length >= 0.85 ? 'PASS (>= 85%)' : 'FAIL (< 85%)')
process.exitCode = correct / cases.length >= 0.85 ? 0 : 1
