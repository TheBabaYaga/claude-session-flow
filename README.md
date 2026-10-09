# session-flow

A Claude Code mod that shows the current session in a pane: each prompt, the work Claude did for it in phases, each subagent with its answer, and what the prompt cost. Use it to review a long session without scrolling back through the conversation.

```text
You     make it a real SVG flow chart                    $0.84  84.2s
├─ ✓ Explored   types.d.ts, 4 searches                         9.8s
├─ ✓ Edited     chart.ts, register.tsx ×4                      2.1s
├─ ✗ → ✓ Tested claude plugin test … ×3                       14.0s
├─ ✓ Subagent   Review the tests · 3 steps  212k in · 4k out   41.0s
│               "Tests cover only the helpers"
└─ Claude  I rebuilt the pane as a real flow chart.
```

## Install

Type this at the Claude Code prompt in a terminal session:

```text
/plugin install session-flow --marketplace TheBabaYaga/claude-session-flow
```

Answer `y` to add the marketplace, then select a scope. The mod is on in the current session and in each session after it.

## Use

The pane opens when a session starts. In the terminal it opens only when the window is 144 columns or wider. Type `/flow` to open it at any width.

| Row | What it shows |
| --- | --- |
| `You` | Your prompt and what it cost in dollars, subagents included. |
| A phase | A run of tool calls of one kind: Explored (read and search), Edited, Tested (a shell command with test, tsc, lint or validate in it), Ran (other shell commands), Researched (web). Other tools keep their own name. |
| `Subagent` | The task of a subagent, its step count and its tokens. The first line of its answer is below it. |
| `Claude` | The first line of Claude's answer, or `working…` while it runs. |

Status marks: `✓` done, `✗` failed or denied, `◐` running. `✗ → ✓` means a step failed and a later step in the same phase passed.

In the terminal, click a row to move the conversation to that point.

## Limits

- The mod uses the Claude Code function hooks API. That API is early access and can change between releases, so an update can break the mod. Where function hooks are off, the mod does not load.
- Click-to-jump works in the terminal only. The desktop app does not let a mod scroll the conversation, so its rows do not respond to a click.
- The dollar cost of a prompt is the change in the session total while the prompt ran. Other work that costs money in that time, such as a background agent, counts too.
- A subagent shows tokens, not dollars. Its input count includes cache reads and writes, so it is much larger than what you pay for it.
- Phase rows show no cost. The tokens go to the model request that asks for the tool calls, and one request often asks for several calls.
- The mod keeps the last 5000 tool calls of a session. It keeps nothing after the session ends.

## Develop

Run Claude Code with the mod loaded from your clone. Edits reload while the session runs.

```bash
claude --plugin-dir /path/to/claude-session-flow
```

In the desktop app, put the folder path in `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`.

Check the mod and run its tests:

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

| File | What it holds |
| --- | --- |
| `hooks/register.tsx` | The hooks that record the session, and the pane. |
| `hooks/phases.ts` | The grouping of tool calls into phases. |
| `types/index.d.ts` | The types of the values the mod keeps in session state. |
| `tests/flow.test.ts` | The tests. |
