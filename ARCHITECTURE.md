# Architecture

pi-antigravity-acp makes Pi an ACP client of the Antigravity agent. This page explains who owns what, how a prompt travels, and how processes and sessions live and end. [PARITY.md](PARITY.md) lists the capabilities; the code is in `src/`.

## Who owns what

| Part                    | Owns                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Antigravity (`agy acp`) | The agent loop, models, sign-in, quota, tools, reasoning, permission policy, settings and the conversation itself, saved on disk.    |
| Pi                      | The terminal UI, the transcript the user sees, model selection, dialogs and the session files.                                       |
| This extension          | The ACP connection, the agent process, the mapping between a Pi session and an agent session, and showing agent activity in Pi's UI. |

The extension registers an `antigravity` provider, because Pi's model picker, thinking levels and streaming only exist for providers. It does not treat the agent as a model API: it sends the user's new message, plus earlier conversation as context only when the agent session has not seen it, never Pi's system prompt or tools, and Pi never executes the agent's tools. The agent runs one turn per prompt; Pi's agent loop only displays it.

## Modules

| File                     | Role                                                                                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`               | Entry point. Registers flags, the mirror tool, Pi event handlers and `/agy`.                                                                        |
| `antigravity.ts`         | `Antigravity`: the link to one agent process and its live session; registers the provider; status line, plan widget, permission dialogs.            |
| `agent.ts`               | Finds the agent (`agy acp` or the ACP registry agent Zed installed) and starts it as a subprocess.                                                  |
| `client.ts`              | `AcpClient`: the ACP connection. Handshake, `session/new`, `load`, `list` and `close`, `authenticate` and `logout`, and the agent's requests to Pi. |
| `session.ts`             | `AcpSession`: one agent session's settings, usage, title, commands, plan, tool calls and the turn in progress.                                      |
| `conversation.ts`        | `Conversation`: an agent session as the current Pi session sees it; its position (anchor) and the Pi ids of mirrored tool calls.                    |
| `stream.ts`              | The provider's stream: decides what the agent has not seen, sends it, and turns agent events into one Pi assistant message.                         |
| `tool.ts`, `render.ts`   | The mirror tool `antigravity_tool`, which shows the agent's tool calls as Pi tool rows, and how those rows render.                                  |
| `catalog.ts`             | The agent's models, modes and commands as Pi models, cached in `antigravity/catalog.json` under Pi's agent directory.                               |
| `command.ts`             | `/agy status`, `mode`, `sessions`, `login`, `logout` and `/agy <agent command>`.                                                                    |
| `guards.ts`              | `isRecord`, which narrows untyped agent data such as its metadata and tool output.                                                                  |
| `fs.ts`                  | The agent's file requests: reads by absolute path, writes only inside the session's directory and its `--agy-dir` directories.                      |
| `flags.ts`               | The extension's flags, read through one zod schema.                                                                                                 |
| `workspace.ts`, `mcp.ts` | `--agy-dir` and `--agy-mcp`: the extra directories and Pi's MCP servers each session gets.                                                          |
| `inbox.ts`               | Updates for sessions not open yet: the replay of a reopened session, counted and optionally kept as text, and early settings and usage.             |
| `sessions.ts`            | `/agy sessions`: a saved agent conversation as a new Pi session.                                                                                    |
| `sign-in.ts`             | Offers the agent's sign-in methods and has it authenticate.                                                                                         |
| `elicit.ts`              | The agent's structured questions, asked with Pi's dialogs.                                                                                          |
| `terminal.ts`            | Commands the agent runs through Pi (ACP terminals).                                                                                                 |
| `plan.ts`                | The agent's plan from `plan`, `plan_update` and `plan_removed`, and the widget's lines.                                                             |
| `draft.ts`               | `Draft`: one Pi assistant message built as the agent's events arrive, and the events Pi streams for it.                                             |
| `pick.ts`                | Shows a select dialog and returns the item behind the chosen label.                                                                                 |
| `occurrences.ts`         | Each item's place among items that share a key, so permission options that share a name can show their kind.                                        |
| `labels.ts`              | Numbers labels that repeat, so the choices in a dialog stay distinct and picking one finds it.                                                      |
| `immutable.ts`           | Copy-on-write maps and `Registry`, which hold sessions and tool calls without editing shared state.                                                 |

## A prompt, end to end

1. The user types. Pi calls the provider's stream with the whole transcript.
2. `stream.ts` finds the last assistant message this provider wrote. Its `responseId` is the anchor `<agent session>/<turn>.<part>`: where the agent was when Pi saved it.
3. If the live agent session is at that anchor, only the user messages after it are sent. Otherwise the transcript and the agent have diverged: the extension reopens the agent session named by the anchor if it is still at that point, or starts a new one and sends the visible conversation as an embedded resource with the prompt.
4. The extension applies Pi's model and thinking level with `session/set_config_option`, then sends `session/prompt`.
5. Agent updates arrive in order on one queue per turn. Text and thoughts become Pi text and thinking blocks. A tool call ends the current Pi message with a call to `antigravity_tool`; Pi runs that tool, which waits for the agent's own tool call to finish and shows its updates. Pi then calls the stream again, which continues the same agent turn.
6. The turn's end stamps the last message with the new anchor and the usage the agent reported.

The mirror tool is why the agent's tool calls look like Pi's own: Pi renders, collapses and expands them, and the tool result in the transcript is what the agent's tool returned.

## Process and session lifetime

- **Start on need.** The agent process starts with the first message to an antigravity model, or the first `/agy` command that needs it. One process serves the Pi session; a second request while it starts waits for the same start.
- **Restart on exit.** If the process exits, the next message starts a new one and reopens the conversation by its anchor.
- **Stop with Pi.** On Pi's `session_shutdown` (quit, `/reload`, `/new`, `/resume`, fork), the extension closes the connection and terminates the process, with SIGKILL after one second if it has not exited. A new Pi session gets a new process.
- **Reopen by anchor.** `session/load` replays the saved conversation as updates. The client counts the replayed prompt turns and accepts the session only when the count equals the anchor's turn. Anything else means the agent has prompts this transcript never saw, so the loaded session is closed and a new one starts. A load is never followed by resending history to the same session, so a prompt cannot reach the agent twice.
- **Close what is replaced.** A rewind replaces the agent session; the old one is closed with `session/close` when the agent offers it.

## Cancellation

Esc aborts Pi's request. The extension sends `session/cancel`, aborts any open permission dialog, and waits up to five seconds for the agent to end the turn. If the agent does not confirm, the extension stops that process rather than let it work unseen; the next message starts a new one. When Pi ends a run while mirrored tool calls are still open, the same cancel runs.

## Security

- The agent starts without a shell, with its stderr discarded, so output cannot be mistaken for protocol messages.
- The extension never sees the agent's sign-in: tokens and quota stay in the agent. The one exception is `--agy-mcp`, below, which passes the MCP servers' configured credentials on.
- Permission requests always reach the user as a dialog with the agent's own options. With no UI, the request is answered with the agent's reject-once option, or cancelled if it has none; a reject-always option is never chosen for the user. A dialog still open when its turn ends is closed and the request cancelled. Nothing is approved without the user.
- Writes requested by the agent go only inside the session's working directory and the directories given with `--agy-dir`. The path is checked after resolving symbolic links, the real parent directory is checked again after it is created, and a symbolic link at the file itself is not followed.
- Reads requested by the agent take any absolute path, as an editor's would, but refuse devices, pipes and files over 16 MiB.
- What the user supplies is validated with zod schemas: the flags, `mcp.json`, typed answers to the agent's questions, and the files the extension reads back (its catalog and Zed's registry listing). Untyped fields the agent sends, such as its metadata and raw tool output, are narrowed with type guards before use.
- What the agent sends is bounded: plans to 100 entries of 500 characters, commands to 200 with descriptions and hints of 500, session titles to 200 characters, tool output shown to 20,000 characters, and updates held for not-yet-known sessions to 64 each for the newest 16 sessions.
- The agent process inherits Pi's environment, because `agy` needs it to find its sign-in. Do not run Pi with secrets in its environment that the agent should not see.
- Commands the agent runs through Pi's terminals start without a shell in their own process group, report at most 1 MiB of output whatever the agent asks (holding up to twice that between trims), and are stopped with everything they started when released or when their session or the connection closes. Pi runs what the agent asks; whether to ask the user first is the agent's permission policy, as for its own tools.
- Structured questions are cancelled without a UI, and close with their turn like permission dialogs.
- `--agy-mcp` passes the MCP servers' configured environment and headers to the agent, credentials included; it is off by default.
- Nothing is logged.

## Performance

`bun run bench` runs the same exchange with the bare ACP SDK, which only counts the updates, and through the extension into Pi's provider events, with a scripted agent in the same process instead of a model. Before timing, it checks that both did the whole exchange. Two runs of `bun run bench` at commit `e8c54c9` on an otherwise idle Apple M2 Max with Node 24.22, mean time per exchange:

| Workload                               | Bare SDK           | Extension to Pi events |
| -------------------------------------- | ------------------ | ---------------------- |
| 1,000 streamed text chunks             | 5.00 and 5.30 ms   | 6.00 and 6.15 ms       |
| A tool call with 200 KB of output      | 0.168 and 0.172 ms | 0.178 and 0.194 ms     |
| Reopening a saved session of 500 turns | n/a                | 4.70 and 4.71 ms       |

The extension, including building Pi's events and assistant message, adds about 1 µs per streamed chunk and 10 to 22 µs for a 200 KB tool result. On a busy machine every number rises and varies more; compare the two columns of one run, not runs on different machines. Updates are handled as they arrive, without polling or batching, except that tool calls the agent starts within 25 ms of each other are shown together.
