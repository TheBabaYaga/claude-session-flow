import { expect, test } from 'claude-code/testing'

import { childrenOf, phasesOf } from '../hooks/phases'
import { cleanPrompt, columnsOf, detailOf, firstLine, fitRow, labelText, rowsOf, timeText } from '../hooks/register'
import type { FlowNode } from '../types'

let clock = 0
const node = (id: string, parent: string, label: string, detail = '', extra: Partial<FlowNode> = {}): FlowNode => {
  clock += 1000
  return { id, parent, kind: 'tool', label, detail, status: 'done', startedAt: clock, endedAt: clock + 500, ...extra }
}

const text = (rows: ReturnType<typeof rowsOf>) =>
  rows.map(r => [r.prefix.trim(), r.mark, r.label, r.detail].filter(Boolean).join(' '))

test('groups the steps of a prompt into phases and nests a subagent answer under its row', async () => {
  const list = [
    node('t1', '', 'You', 'make it clear', { kind: 'turn', result: 'Done, see the pane.', row: 'u-prompt', answerRow: 'u-answer', usd: 0.8421 }),
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
  const rows = rowsOf(list, { 'agent:x': 'a1' })

  expect(text(rows)).toEqual([
    'Prompt 1 · $0.84 · 0.5s',
    'You make it clear',
    '├─ ✓ Explored Read, Grep · a.ts, b.ts, 1 search',
    '├─ ✓ Edited Edit · 2× a.ts',
    '├─ ↻ Tested Bash · 2× npm test',
    '├─ ✓ Subagent Review the tests · 1 step',
    '│ “3/3 pass”',
    '└─ Claude Done, see the pane.',
  ])
  // A click jumps to the prompt, the first call of each phase, the Agent call, and the answer.
  expect(rows.map(r => r.target)).toEqual([undefined, 'u-prompt', 'r1', 'e1', 'b1', 'a1', 'a1', 'u-answer'])
  // The subagent shows its tokens; the prompt's dollar cost is in its header.
  expect(rows.map(r => r.cost)).toEqual([undefined, undefined, undefined, undefined, undefined, '212k in · 4k out', undefined, undefined])
})

test('shows a running prompt as working and a background task apart from prompts', async () => {
  const list = [
    node('t1', '', 'You', 'first', { kind: 'turn', result: 'ok' }),
    node('t2', '', 'Task', 'Background command "npm test" completed', { kind: 'turn', result: 'noted' }),
    node('t3', '', 'You', 'second', { kind: 'turn', status: 'running', endedAt: undefined }),
    node('b1', 't3', 'Bash', 'ls', { status: 'running', endedAt: undefined }),
  ]
  const rows = rowsOf(list, {})

  expect(text(rows)).toEqual([
    'Prompt 1 · 0.5s', 'You first', '└─ Claude ok', '',
    'Background task · 0.5s', 'Task Background command "npm test" completed', '└─ Claude noted', '',
    'Prompt 2', 'You second', '├─ ◐ Ran Bash · ls', '└─ Claude working…',
  ])
})

test('names an MCP step by its server and a built-in step by its tool, hides ToolSearch, and keeps a file name from a long path', async () => {
  const steps = [
    node('s1', 't', 'ToolSearch', 'select:mcp__claude_ai_Atlassian__editJiraIssue'),
    node('m1', 't', 'mcp__claude_ai_Atlassian__editJiraIssue', 'ACME-1337'),
    node('m2', 't', 'mcp__claude_ai_Atlassian__createJiraIssue', ''),
    node('r1', 't', 'Read', `/Users/kevin/.claude/projects/${'-Users-kevin-Workspace-acme'.repeat(3)}/memory/notes.md`),
  ]
  const phases = phasesOf(steps, childrenOf(steps, {}))

  expect(phases.map(p => `${p.label} ${p.detail}`)).toEqual(['Atlassian 2× createJiraIssue', 'Explored Read · notes.md'])
})

test('shows a slash command and a task notification as plain text', async () => {
  expect(cleanPrompt('<command-message>plannotator-review</command-message> <command-name>/plannotator-review</command-name> <command-args>spec.md</command-args>'))
    .toEqual({ label: 'You', text: '/plannotator-review spec.md' })
  expect(cleanPrompt('<task-notification> <task-id>bg2</task-id> <status>completed</status> <summary>Background command "ls" completed</summary> </task-notification>'))
    .toEqual({ label: 'Task', text: 'Background command "ls" completed' })
  expect(cleanPrompt('fix the <b>bug</b>').text.replace(/\s+/g, ' ').trim()).toBe('fix the bug')
})

test('takes the command of a Bash call, the description of an Agent call, and the first question asked', async () => {
  expect(detailOf({ tool: 'Bash', command: 'npm   test', description: 'Run tests' })).toBe('npm test')
  expect(detailOf({ tool: 'Agent', description: 'find auth', prompt: 'long text' })).toBe('find auth')
  expect(detailOf({ tool: 'AskUserQuestion', questions: [{ question: 'Which view?' }] })).toBe('Which view?')
  expect(detailOf({ tool: 'TodoWrite' })).toBe('')
})

test('takes the first line of an answer that holds words, without Markdown marks', async () => {
  expect(firstLine('\n## **Done.** See `flow`\nmore')).toBe('Done. See flow')
})

test('cuts a row to the pane width, and drops the cost before the detail', async () => {
  const fit = (width: number) => {
    const row = fitRow({ prefix: '└─ ', label: 'Claude', detail: 'I rebuilt the pane layout around what your screenshot showed.' }, width)
    return `${row.prefix}${row.label}  ${row.detail}`
  }
  expect(fit(40)).toBe('└─ Claude  I rebuilt the pane layout ar…')
  expect(fit(40).length).toBe(40)
  expect(fit(200)).toBe('└─ Claude  I rebuilt the pane layout around what your screenshot showed.')

  const phase = fitRow({ prefix: '├─ ', mark: '✓', status: 'done', seconds: '41.0s', label: 'Subagent', detail: 'Review the tests', cost: '212k in · 4k out' }, 50)
  expect(phase.cost).toBeUndefined()
  expect(3 + 2 + 11 + 7 + 2 + phase.detail.length).toBeLessThanOrEqual(50)
})

test('sizes the label and time columns to the widest row in the terminal, and keeps one space on the desktop', async () => {
  const row = { prefix: '├─ ', mark: '✓', status: 'done' as const, seconds: '1.5s', label: 'Ran', detail: 'Bash · ls' }
  const rows = [row, { ...row, label: 'Tested', seconds: '1m 13s' }, { prefix: '', label: 'You', detail: 'hi' }]
  const cols = columnsOf(rows)
  expect(cols).toEqual({ label: 7, time: 6 })
  expect(labelText(row, cols) + timeText(row, cols)).toBe('Ran      1.5s  ')
  expect(labelText(row) + timeText(row)).toBe('Ran 1.5s  ')
  // A row without a mark has no time, and keeps two spaces after its label.
  expect(labelText({ prefix: '', label: 'You', detail: 'hi' }, cols)).toBe('You  ')
  // A subagent's note starts under the detail of the phase rows.
  const note = fitRow({ prefix: '│', label: '', detail: '“ok”', isDim: true }, Infinity, cols)
  expect(note.prefix.length).toBe('├─ ✓ '.length + 7 + 6 + 2)
})

test('keeps one cell clear at the left and two at the right edge of the terminal pane, and indents the empty text like a row', async $ => {
  const props = { title: 'Session flow', isFocused: false, bodyColumns: 60, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 20 }, view: {} }
  const terminal = await $.ui.mount({ plugin: 'session-flow', surface: 'terminal', component: 'Pane', props, requestId: 'session-flow' })
  expect(await terminal.drawn()).toMatchObject({ type: 'Box', props: { paddingLeft: 1, paddingRight: 2 } })
  // With no prompt yet, the empty text starts two cells in, where the rows put their ↗ column.
  expect(await terminal.drawn()).toMatchObject({ children: [{ type: 'Box', props: { paddingLeft: 2 } }] })
})

test('puts one blank line between prompts in the terminal, where the empty row already draws one', async ($, on) => {
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('session.usage', async () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  for (const turnId of ['t1', 't2']) {
    await $.turn.start({ turnId, text: 'hi' })
    await $.turn.complete({ turnId, answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer' })
  }
  const props = { title: 'Session flow', isFocused: false, bodyColumns: 60, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 20 }, view: {} }
  const terminal = await $.ui.mount({ plugin: 'session-flow', surface: 'terminal', component: 'Pane', props, requestId: 'session-flow' })
  const tree = await terminal.drawn()
  const header = ('children' in tree ? tree.children ?? [] : []).find(c => JSON.stringify(c).includes('Prompt 2'))
  expect(header).toMatchObject({ type: 'Box', props: { marginTop: 0 } })
})
