# Architecture

pi-antigravity-acp makes Pi an ACP client of the Antigravity agent. This page explains who owns what, how a prompt travels, and how processes and sessions live and end. [PARITY.md](PARITY.md) lists the capabilities; the code is in `src/`.

## Who owns what

| Part                    | Owns                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Antigravity (`agy acp`) | The agent loop, models, sign-in, quota, tools, reasoning, permission policy, settings and the conversation itself, saved on disk.    |
| Pi                      | The terminal UI, the transcript the user sees, model selection, dialogs and the session files.                                       |
| This extension          | The ACP connection, the agent process, the mapping between a Pi session and an agent session, and showing agent activity in Pi's UI. |

The extension registers an `antigravity` provider, because Pi's model picker, thinking levels and streaming only exist for providers. It does not treat the agent as a model API: it sends only the user's new words, never Pi's system prompt or tools, and Pi never executes the agent's tools. The agent runs one turn per prompt; Pi's agent loop only displays it.

## Modules

| File                   | Role                                                                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`             | Entry point. Registers flags, the mirror tool, Pi event handlers and `/agy`.                                                             |
| `antigravity.ts`       | `Antigravity`: the link to one agent process and its live session; registers the provider; status line, plan widget, permission dialogs. |
| `agent.ts`             | Finds the agent (`agy acp` or the ACP registry agent Zed installed) and starts it as a subprocess.                                       |
| `client.ts`            | `AcpClient`: the ACP connection. Handshake, `session/new`, `session/load`, `session/close`, and the agent's requests to Pi.              |
| `session.ts`           | `AcpSession`: one agent session's settings, usage, title, commands, plan, tool calls and the turn in progress.                           |
| `conversation.ts`      | `Conversation`: an agent session as the current Pi session sees it; its position (anchor) and the Pi ids of mirrored tool calls.         |
| `stream.ts`            | The provider's stream: decides what the agent has not seen, sends it, and turns agent events into one Pi assistant message.              |
| `tool.ts`, `render.ts` | The mirror tool `antigravity_tool`, which shows the agent's tool calls as Pi tool rows, and how those rows render.                       |
| `catalog.ts`           | The agent's models, modes and commands as Pi models, cached in `antigravity/catalog.json` under Pi's agent directory.                    |
| `command.ts`           | `/agy status`, `/agy mode` and `/agy <agent command>`.                                                                                   |
| `fs.ts`                | The agent's file requests: reads by absolute path, writes only inside the session's working directory.                                   |

## A prompt, end to end

1. The user types. Pi calls the provider's stream with the whole transcript.
2. `stream.ts` finds the last assistant message this provider wrote. Its `responseId` is the anchor `<agent session>/<turn>.<part>`: where the agent was when Pi saved it.
3. If the live agent session is at that anchor, only the user messages after it are sent. Otherwise the transcript and the agent have diverged: the extension reopens the agent session named by the anchor if it is still at that point, or starts a new one and sends the visible conversation as an embedded resource with the prompt.
4. The extension applies Pi's model and thinking level with `session/set_config_option`, then sends `session/prompt`.
5. Agent updates arrive in order on one queue per turn. Text and thoughts become Pi text and thinking blocks. A tool call ends the current Pi message with a call to `antigravity_tool`; Pi runs that tool, which waits for the agent's own tool call to finish and shows its updates. Pi then calls the stream again, which continues the same agent turn.
6. The turn's end stamps the last message with the new anchor and the usage the agent reported.

The mirror tool is why the agent's tool calls look like Pi's own: Pi renders, collapses and expands them, and the tool result in the transcript is what the agent's tool returned. Nothing runs twice; the agent already ran it.

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
- The extension never sees credentials. Sign-in, tokens and quota stay in the agent.
- Permission requests always reach the user as a dialog with the agent's own options. With no UI, the request is answered with the agent's reject option, or cancelled if it has none. A dialog still open when its turn ends is closed and the request cancelled. Nothing is approved without the user.
- Writes requested by the agent go only inside the session's working directory, after resolving symbolic links.
- Nothing is logged.

## Performance

`bun run bench` runs the same exchange with the bare ACP SDK and through the extension, with a scripted agent in the same process instead of a model. On an Apple M2 Max with Node 24.22:

| Workload                               | Bare SDK | Extension to Pi events |
| -------------------------------------- | -------- | ---------------------- |
| 1,000 streamed text chunks             | 4.78 ms  | 5.70 ms                |
| A tool call with 200 KB of output      | 0.164 ms | 0.178 ms               |
| Reopening a saved session of 500 turns | n/a      | 4.52 ms                |

The extension adds about 0.9 µs per streamed chunk. Updates are handled as they arrive, without polling or batching, except that tool calls the agent starts within 25 ms of each other are shown together. Updates that arrive before their session exists are kept, at most 64 per session.
