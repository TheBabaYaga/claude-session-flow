import { expect, test } from 'claude-code/testing'

import { detailOf, firstLine, rowsOf } from '../hooks/register'
import type { FlowNode } from '../types'

let clock = 0
const node = (id: string, parent: string, label: string, detail = '', extra: Partial<FlowNode> = {}): FlowNode => {
  clock += 1000
  return { id, parent, kind: 'tool', label, detail, status: 'done', startedAt: clock, endedAt: clock + 500, ...extra }
}

test('groups the steps of a prompt into phases and nests a subagent answer under its row', async () => {
  const list = [
    node('t1', '', 'Prompt', 'make it clear', { kind: 'turn', result: 'Done, see the pane.', row: 'u-prompt', answerRow: 'u-answer', usd: 0.8421 }),
    node('r1', 't1', 'Read', '/src/a.ts'),
    node('g1', 't1', 'Grep', 'useAuth'),
    node('r2', 't1', 'Read', '/src/b.ts'),
    node('e1', 't1', 'Edit', '/src/a.ts'),
    node('e2', 't1', 'Edit', '/src/a.ts'),
    node('b1', 't1', 'Bash', 'npm test', { status: 'error' }),
    node('b2', 't1', 'Bash', 'npm test'),
    node('a1', 't1', 'Agent · Explore', 'Review the tests', { kind: 'agent', result: '3/3 pass', tokensIn: 212_400, tokensOut: 3_900 }),
    node('ar', 'agent:x', 'Read', '/tests/flow.test.ts'),
  ]
  const rows = rowsOf(list, { 'agent:x': 'a1' }).map(r => [r.prefix.trim(), r.mark, r.label, r.detail].filter(Boolean).join(' '))

  expect(rows).toEqual([
    'You make it clear',
    '├─ ✓ Explored a.ts, b.ts, 1 search',
    '├─ ✓ Edited a.ts ×2',
    '├─ ✗ → ✓ Tested npm test ×2',
    '├─ ✓ Subagent Review the tests · 1 step',
    '│ “3/3 pass”',
    '└─ Claude Done, see the pane.',
  ])
  // A click jumps to the prompt, the first call of each phase, the Agent call, and the answer.
  expect(rowsOf(list, { 'agent:x': 'a1' }).map(r => r.target)).toEqual(
    ['u-prompt', 'r1', 'e1', 'b1', 'a1', 'a1', 'u-answer'],
  )
  // The prompt shows its dollar cost, the subagent its tokens, and a phase nothing.
  expect(rowsOf(list, { 'agent:x': 'a1' }).map(r => r.cost)).toEqual(
    ['$0.84', undefined, undefined, undefined, '212k in · 4k out', undefined, undefined],
  )
})

test('shows a running prompt as working and keeps prompts apart', async () => {
  const list = [
    node('t1', '', 'Prompt', 'first', { kind: 'turn', result: 'ok' }),
    node('t2', '', 'Prompt', 'second', { kind: 'turn', status: 'running', endedAt: undefined }),
    node('b1', 't2', 'Bash', 'ls', { status: 'running', endedAt: undefined }),
  ]
  const rows = rowsOf(list, {})

  expect(rows.map(r => r.detail)).toEqual(['first', 'ok', '', 'second', 'ls', 'working…'])
  expect(rows[4]?.mark).toBe('◐')
  expect(rows[4]?.seconds).toBe('')
})

test('takes the command of a Bash call and the description of an Agent call', async () => {
  expect(detailOf({ tool: 'Bash', command: 'npm   test', description: 'Run tests' })).toBe('npm test')
  expect(detailOf({ tool: 'Agent', description: 'find auth', prompt: 'long text' })).toBe('find auth')
  expect(detailOf({ tool: 'TodoWrite' })).toBe('')
})

test('takes the first line of an answer that holds words, without Markdown marks', async () => {
  expect(firstLine('\n## **Done.** See `flow`\nmore')).toBe('Done. See flow')
})
