import { atom, read, update } from 'claude-code'
import type { Register, TurnUsage } from 'claude-code'

import type { FlowNode, FlowStatus } from '../types'

import { childrenOf, phasesOf } from './phases'

const PANE = 'session-flow'
const nodes = atom({ plugin: 'session-flow', key: 'nodes' } as const, [])
const alias = atom({ plugin: 'session-flow', key: 'alias' } as const, {})
// ponytail: keeps the last 5000 calls; each write copies the whole list, so move to a StateFamily per turn if long sessions get slow.
const MAX_NODES = 5000
const turn = atom({ plugin: 'session-flow', key: 'turn' } as const, '')
const promptRow = atom({ plugin: 'session-flow', key: 'promptRow' } as const, '')

// The first of these arguments that holds a string is the detail of a tool call.
const DETAIL_KEYS = ['command', 'description', 'file_path', 'path', 'pattern', 'url', 'query', 'skill', 'prompt']
const COLOR: Record<FlowStatus, string> = { running: 'warning', done: 'success', error: 'error' }

const oneLine = (text: string, max = 60) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

// The first line of an answer that holds words, without Markdown marks.
export const firstLine = (text: string) =>
  oneLine(text.split('\n').map(line => line.replace(/[*_`#>|]/g, '').trim()).find(Boolean) ?? '', 100)

export const detailOf = (input: object) => {
  const args = Object.fromEntries(Object.entries(input))
  const key = DETAIL_KEYS.find(k => typeof args[k] === 'string' && args[k] !== '')
  return key === undefined ? '' : oneLine(String(args[key]))
}

type Row = {
  prefix: string
  label: string
  detail: string
  mark?: string
  status?: FlowStatus
  seconds?: string
  color?: string
  target?: string
  cost?: string
}

// One row per line: each prompt, its phases, a subagent's answer under its row, and Claude's answer last.
export const rowsOf = (list: readonly FlowNode[], aliases: Record<string, string>): Row[] => {
  const children = childrenOf(list, aliases)
  const rows: Row[] = []
  for (const prompt of children.get('') ?? []) {
    if (rows.length > 0) rows.push({ prefix: '', label: '', detail: '' })
    const steps = children.get(prompt.id) ?? []
    rows.push({ prefix: '', label: 'You', detail: prompt.detail, color: 'suggestion', target: prompt.row ?? steps[0]?.id,
      cost: prompt.usd === undefined ? undefined : `$${prompt.usd.toFixed(2)}` })
    for (const phase of phasesOf(steps, children)) {
      rows.push({ prefix: '├─ ', ...phase })
      if (phase.note) rows.push({ prefix: `│${' '.repeat(15)}`, label: '', detail: `“${phase.note}”`, target: phase.target })
    }
    const answer =
      prompt.status === 'running' ? 'working…' : prompt.result ?? (prompt.status === 'error' ? 'stopped' : '')
    rows.push({ prefix: '└─ ', label: 'Claude', detail: answer, color: 'claude', target: prompt.answerRow })
  }
  // ponytail: calls of a subagent whose spawn never reported its id stay hidden; add an "orphans" group if that shows up.
  return rows
}

const addUsage = (node: FlowNode, usage: TurnUsage | undefined): FlowNode =>
  usage === undefined
    ? node
    : {
        ...node,
        tokensIn: (node.tokensIn ?? 0) + usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens,
        tokensOut: (node.tokensOut ?? 0) + usage.output_tokens,
      }

const finish = (id: string, status: FlowStatus) => (list: FlowNode[]) =>
  list.map(n => (n.id === id ? { ...n, status, endedAt: Date.now() } : n))

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'flow', description: 'Show this session as a live flow of prompts, phases and subagents' })
    void $.ui.open({ id: PANE, title: 'Session flow' }).then(() => $.ui.scroll({ in: PANE, to: 'end' }))

    return next(e)
  })

  on('command.run', { command: 'flow' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Session flow' })
    await $.ui.scroll({ in: PANE, to: 'end' })

    return { text: 'Session flow pane opened.' }
  })

  on('turn.start', async ($, e, next) => {
    // Subagent turns may also start here: a main turn is one that starts while no main turn runs.
    if ((await read($, turn)) === '') {
      await update($, turn, () => e.turnId)
      const row = (await read($, promptRow)) || undefined
      await update($, promptRow, () => '')
      const node: FlowNode = {
        id: e.turnId, parent: '', kind: 'turn', label: 'Prompt',
        detail: oneLine(e.text) || '(no text)', status: 'running', startedAt: Date.now(), row,
        usdAtStart: (await $.session.usage()).cost?.usd,
      }
      await update($, nodes, list => [...list, node].slice(-MAX_NODES))
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = firstLine(e.answer)
    if (e.agentId !== undefined) {
      const id = (await read($, alias))[`agent:${e.agentId}`]
      if (id !== undefined) {
        await update($, nodes, list => list.map(n => (n.id === id ? { ...addUsage(n, e.usage), result } : n)))
      }
    } else if ((await read($, turn)) === e.turnId) {
      const usdNow = (await $.session.usage()).cost?.usd
      await update($, nodes, list =>
        finish(e.turnId, e.reason === 'answer' ? 'done' : 'error')(list).map(n =>
          n.id === e.turnId
            ? { ...n, result, usd: usdNow === undefined || n.usdAtStart === undefined ? undefined : usdNow - n.usdAtStart }
            : n,
        ),
      )
      await update($, turn, () => '')
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const id = e.tool_use_id ?? crypto.randomUUID()
    const parent = e.agentId === undefined ? await read($, turn) : `agent:${e.agentId}`
    const node: FlowNode = {
      id, parent, kind: e.tool === 'Agent' ? 'agent' : 'tool', label: e.tool,
      detail: detailOf(e), status: 'running', startedAt: Date.now(),
    }
    await update($, nodes, list => [...list, node].slice(-MAX_NODES))
    const ran = await next(e)
    await update($, nodes, finish(id, ran.deny !== undefined || ran.isError === true ? 'error' : 'done'))

    return ran
  })

  // Keeps the transcript row ids a click jumps to: the person's prompt and Claude's text replies on the main loop.
  on('session.append', async ($, e, next) => {
    const isPrompt = e.door === 'prompt'
    const isReply = e.door === 'response' && e.message.content.some(block => block.type === 'text')
    if (e.agentId === undefined && (isPrompt || isReply)) {
      const current = await read($, turn)
      const node = (await read($, nodes)).find(n => n.id === current)
      if (isReply && node !== undefined) {
        await update($, nodes, list => list.map(n => (n.id === current ? { ...n, answerRow: e.uuid } : n)))
      } else if (isPrompt && node !== undefined && node.row === undefined) {
        await update($, nodes, list => list.map(n => (n.id === current ? { ...n, row: e.uuid } : n)))
      } else if (isPrompt) {
        await update($, promptRow, () => e.uuid)
      }
    }

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const ran = await next(e)
    if (ran.agentId !== undefined) {
      const agentId = ran.agentId
      await update($, alias, map => ({ ...map, [`agent:${agentId}`]: e.tool_use_id }))
      await update($, nodes, list =>
        list.map(n => (n.id === e.tool_use_id ? { ...n, label: `Agent · ${e.subagentType}` } : n)),
      )
    }

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    // ponytail: the desktop app refuses to scroll the conversation ("transcript not scrollable here"), so only the terminal gets clickable rows; drop this check once a build allows it.
    const canJump = e.surface === 'terminal'
    const jump = async (target: string) => {
      const moved = await $.ui.scroll({ to: { requestId: target }, block: 'start' })
      if (moved.deny !== undefined) $.ui.toast(`Cannot jump there: ${moved.deny}`)
    }
    const rows = rowsOf(await read($, nodes), await read($, alias))

    return (
      <Box flexDirection="column">
        {rows.length === 0 && <Text dimColor>Nothing yet. Send a prompt.</Text>}
        {rows.map(row => (
          <Box>
            <Text dimColor>{row.prefix}</Text>
            {row.mark !== undefined && row.status !== undefined && (
              <Text color={COLOR[row.status]}>{row.mark} </Text>
            )}
            {canJump && row.target !== undefined ? (
              <Box flexGrow={1} flexShrink={1}>
                <Button plain key={`${row.target}:${row.label}`} onPress={() => jump(row.target ?? '')}>
                  {`${row.label.padEnd(row.label === '' ? 0 : row.mark === undefined ? 7 : 11)}${row.detail}`}
                </Button>
              </Box>
            ) : (
              <>
                {row.label !== '' && (
                  <Text bold color={row.color}>{row.label.padEnd(row.mark === undefined ? 7 : 11)}</Text>
                )}
                <Box flexGrow={1} flexShrink={1}>
                  <Text dimColor={row.color === undefined} wrap="truncate">{row.detail}</Text>
                </Box>
              </>
            )}
            {row.cost ? <Text dimColor> {row.cost}</Text> : null}
            {row.seconds ? <Text dimColor> {row.seconds}</Text> : null}
          </Box>
        ))}
      </Box>
    )
  })
}
