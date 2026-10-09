export type FlowStatus = 'running' | 'done' | 'error'

export type FlowNode = {
  id: string
  // A node id, or `agent:<agentId>` for a call made inside a subagent.
  parent: string
  kind: 'turn' | 'tool' | 'agent'
  label: string
  detail: string
  status: FlowStatus
  startedAt: number
  endedAt?: number
  // The first line of the answer: Claude's for a turn, the subagent's for an Agent call.
  result?: string
  // Transcript row ids of a turn: the prompt, and Claude's last text reply.
  row?: string
  answerRow?: string
  // A turn: the session's dollar total when it started, and what the turn cost, subagents included.
  usdAtStart?: number
  usd?: number
  // A subagent: its tokens, summed over its turns. Input counts the cache reads and writes too.
  tokensIn?: number
  tokensOut?: number
}

declare module 'claude-code' {
  interface PluginState {
    'session-flow': {
      nodes: FlowNode[]
      // `agent:<agentId>` -> the id of the Agent tool call that started it.
      alias: Record<string, string>
      // The id of the main turn that runs now, '' between turns.
      turn: string
      // The id of a prompt row stored before its turn started, '' when none waits.
      promptRow: string
    }
  }
}
