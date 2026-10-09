import type { FlowNode, FlowStatus } from '../types'

export type Phase = {
  label: string
  detail: string
  // '✓', '✗', '◐', or '✗ → ✓' when a later step of the phase passed after one failed.
  mark: string
  status: FlowStatus
  seconds: string
  // A subagent's first line of its answer.
  note?: string
  // The transcript row a click jumps to: the phase's first tool call.
  target?: string
  // A subagent's tokens.
  cost?: string
}

const PHASE: [RegExp, string][] = [
  [/^(Read|Glob|Grep|LS|LSP|NotebookRead)$/, 'Explored'],
  [/^(WebFetch|WebSearch)$/, 'Researched'],
  [/^(Edit|Write|MultiEdit|NotebookEdit)$/, 'Edited'],
]
const SEARCH = /^(Grep|Glob|LSP)$/
const CHECK = /\b(test|tests|jest|vitest|pytest|tsc|lint|eslint|validate|typecheck)\b/

const toolOf = (node: FlowNode) => node.label.replace(/ · .*$/, '')

const phaseOf = (node: FlowNode) => {
  const tool = toolOf(node)
  if (node.kind === 'agent') return 'Subagent'
  if (tool === 'Bash') return CHECK.test(node.detail) ? 'Tested' : 'Ran'
  return PHASE.find(([re]) => re.test(tool))?.[1] ?? tool
}

const baseName = (path: string) => path.split('/').filter(Boolean).pop() ?? path

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

const names = (paths: readonly string[]) => {
  const unique = [...new Set(paths.map(baseName))]
  return unique.length <= 3 ? unique.join(', ') : plural(unique.length, 'file')
}

export const tokens = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`

export const secondsBetween = (start: number, end: number | undefined) =>
  end === undefined ? '' : `${((end - start) / 1000).toFixed(1)}s`

// Groups the nodes by parent; a subagent's calls go under the Agent call that started it.
export const childrenOf = (list: readonly FlowNode[], aliases: Record<string, string>) => {
  const children = new Map<string, FlowNode[]>()
  for (const node of list) {
    const parent = aliases[node.parent] ?? node.parent
    children.set(parent, [...(children.get(parent) ?? []), node])
  }
  return children
}

const describe = (label: string, steps: readonly FlowNode[]) => {
  const last = steps[steps.length - 1]?.detail ?? ''
  const times = steps.length > 1 ? ` ×${steps.length}` : ''
  if (label === 'Explored') {
    const files = steps.filter(s => !SEARCH.test(toolOf(s))).map(s => s.detail)
    const searches = steps.length - files.length
    return [files.length > 0 ? names(files) : '', searches > 0 ? plural(searches, 'search') : '']
      .filter(Boolean)
      .join(', ')
  }
  if (label === 'Edited') {
    const files = steps.map(s => s.detail)
    return `${names(files)}${steps.length > new Set(files).size ? times : ''}`
  }
  return `${cut(last, 48)}${times}`
}

const markOf = (steps: readonly FlowNode[]): [string, FlowStatus] => {
  if (steps.some(s => s.status === 'running')) return ['◐', 'running']
  if (steps[steps.length - 1]?.status === 'error') return ['✗', 'error']
  return steps.some(s => s.status === 'error') ? ['✗ → ✓', 'done'] : ['✓', 'done']
}

// Turns the steps of one prompt into phases: runs of steps of one kind merge into one row; each subagent keeps a row.
export const phasesOf = (steps: readonly FlowNode[], children: Map<string, FlowNode[]>): Phase[] => {
  const runs: { label: string; steps: FlowNode[] }[] = []
  for (const step of steps) {
    const label = phaseOf(step)
    const run = runs[runs.length - 1]
    if (run !== undefined && run.label === label && label !== 'Subagent') run.steps.push(step)
    else runs.push({ label, steps: [step] })
  }

  return runs.map(({ label, steps: run }) => {
    const [mark, status] = markOf(run)
    const start = Math.min(...run.map(s => s.startedAt))
    const end = status === 'running' ? undefined : Math.max(...run.map(s => s.endedAt ?? s.startedAt))
    const first = run[0]
    if (label === 'Subagent' && first !== undefined) {
      const count = children.get(first.id)?.length ?? 0
      return {
        label, mark, status, seconds: secondsBetween(start, end),
        detail: `${first.detail}${count > 0 ? ` · ${plural(count, 'step')}` : ''}`,
        note: first.result,
        target: first.id,
        cost: first.tokensIn === undefined ? undefined : `${tokens(first.tokensIn)} in · ${tokens(first.tokensOut ?? 0)} out`,
      }
    }
    return { label, mark, status, seconds: secondsBetween(start, end), detail: describe(label, run), target: first?.id }
  })
}
