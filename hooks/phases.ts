import type { FlowNode, FlowStatus } from '../types'

export type Phase = {
  label: string
  // A theme color for the label, by what the phase does.
  color: string
  detail: string
  // '✓', '✗', '◐', or '↻' when a later step of the phase passed after one failed.
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
  [/^AskUserQuestion$/, 'Asked you'],
  [/^TodoWrite$/, 'Planned'],
  [/^(EnterPlanMode|ExitPlanMode)$/, 'Plan'],
]
const COLOR: Record<string, string> = {
  Explored: 'suggestion',
  Researched: 'planMode',
  Edited: 'autoAccept',
  Tested: 'bashBorder',
  Ran: 'bashBorder',
  Subagent: 'merged',
  'Asked you': 'permission',
}
// Steps the engine makes for itself, which say nothing about the work.
const HIDDEN = /^ToolSearch$/
const SEARCH = /^(Grep|Glob|LSP)$/
const CHECK = /\b(test|tests|jest|vitest|pytest|tsc|lint|eslint|validate|typecheck)\b/
// mcp__<server>__<tool>; a server name such as claude_ai_Atlassian shows as its last part.
const MCP = /^mcp__(.+?)__(.+)$/

const toolOf = (node: FlowNode) => node.label.replace(/ · .*$/, '')

const phaseOf = (node: FlowNode) => {
  const tool = toolOf(node)
  if (node.kind === 'agent') return 'Subagent'
  if (tool === 'Bash') return CHECK.test(node.detail) ? 'Tested' : 'Ran'
  const mcp = MCP.exec(tool)
  if (mcp) return mcp[1]?.split('_').pop() ?? tool
  return PHASE.find(([re]) => re.test(tool))?.[1] ?? tool
}

// What a step did, in a few words: an MCP step leads with its tool name.
const stepText = (node: FlowNode) => {
  const mcp = MCP.exec(toolOf(node))
  return mcp ? [mcp[2], node.detail].filter(Boolean).join(' · ') : node.detail
}

const baseName = (path: string) => path.split('/').filter(Boolean).pop() ?? path

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

const names = (paths: readonly string[]) => {
  const unique = [...new Set(paths.map(baseName))]
  return unique.length <= 3 ? unique.join(', ') : plural(unique.length, 'file')
}

export const tokens = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`

export const duration = (ms: number) => {
  const s = ms / 1000
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`
}

export const secondsBetween = (start: number, end: number | undefined) =>
  end === undefined ? '' : duration(end - start)

// Groups the nodes by parent; a subagent's calls go under the Agent call that started it.
export const childrenOf = (list: readonly FlowNode[], aliases: Record<string, string>) => {
  const children = new Map<string, FlowNode[]>()
  for (const node of list) {
    const parent = aliases[node.parent] ?? node.parent
    children.set(parent, [...(children.get(parent) ?? []), node])
  }
  return children
}

// The count leads, so a cut at the pane's edge never hides it.
const describe = (label: string, steps: readonly FlowNode[]) => {
  const times = steps.length > 1 ? `${steps.length}× ` : ''
  if (label === 'Explored') {
    const files = steps.filter(s => !SEARCH.test(toolOf(s))).map(s => s.detail)
    const searches = steps.length - files.length
    return [files.length > 0 ? names(files) : '', searches > 0 ? plural(searches, 'search') : '']
      .filter(Boolean)
      .join(', ')
  }
  if (label === 'Edited') {
    const files = steps.map(s => s.detail)
    return `${steps.length > new Set(files).size ? times : ''}${names(files)}`
  }
  const last = steps[steps.length - 1]
  return `${times}${last === undefined ? '' : stepText(last)}`
}

const markOf = (steps: readonly FlowNode[]): [string, FlowStatus] => {
  if (steps.some(s => s.status === 'running')) return ['◐', 'running']
  if (steps[steps.length - 1]?.status === 'error') return ['✗', 'error']
  return steps.some(s => s.status === 'error') ? ['↻', 'done'] : ['✓', 'done']
}

// Turns the steps of one prompt into phases: runs of steps of one kind merge into one row; each subagent keeps a row.
export const phasesOf = (steps: readonly FlowNode[], children: Map<string, FlowNode[]>): Phase[] => {
  const runs: { label: string; steps: FlowNode[] }[] = []
  for (const step of steps) {
    if (HIDDEN.test(toolOf(step))) continue
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
    const color = COLOR[label] ?? (MCP.test(first === undefined ? '' : toolOf(first)) ? 'ide' : 'text')
    const base = { label, color, mark, status, seconds: secondsBetween(start, end), target: first?.id }
    if (label === 'Subagent' && first !== undefined) {
      const count = children.get(first.id)?.length ?? 0
      return {
        ...base,
        detail: `${first.detail}${count > 0 ? ` · ${plural(count, 'step')}` : ''}`,
        note: first.result,
        cost: first.tokensIn === undefined ? undefined : `${tokens(first.tokensIn)} in · ${tokens(first.tokensOut ?? 0)} out`,
      }
    }
    return { ...base, detail: describe(label, run) }
  })
}
