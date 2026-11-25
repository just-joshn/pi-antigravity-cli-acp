# pi-antigravity-acp

Use Google's Antigravity agent from Pi the way Zed does. **Pi is the [ACP](https://agentclientprotocol.com/) client and Antigravity is the agent.** You pick an Antigravity model in Pi's model picker and type normally. The agent keeps the conversation, runs its own tools and asks Pi's user for permission.

Pi sends the agent your words and nothing else: no Pi system prompt, no Pi tool list. Asked which harness it runs in, the model answers "Antigravity", because that is what it runs in. Pi introduces itself to the agent as `pi` in the ACP handshake.

[ARCHITECTURE.md](ARCHITECTURE.md) explains how the pieces fit. [PARITY.md](PARITY.md) compares each Antigravity ACP capability with Zed's client and records the evidence.

## Install

You need Pi 1.6 or later, Node.js 22.19 or later, and the Antigravity CLI (`agy`) on `PATH`.

From a checkout:

```sh
bun install
pi install "$PWD"
```

Pi loads a local package from its path, so keep the checkout where it is. To try it for one run without installing, use `pi -e ./src/index.ts`.

## Sign in

Sign-in belongs to the agent. Run `agy` once in a terminal and sign in there; the extension uses that sign-in and never reads a token. If the agent reports that you are signed out, Pi shows "Antigravity needs you to sign in. Run `agy` in a terminal, sign in, then try again."

## Use it

```sh
pi --model antigravity/default
```

Say hello. `antigravity/default` uses whichever model the agent is set to. After the first reply, `/model` lists the agent's own models under `antigravity`, for example `gemini-4-hydrogen` and `gemini-3.8-flash`. Pi remembers the list, so later runs can start on one directly with `--model antigravity/gemini-3.8-flash`.

| Control              | In Pi                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| Model                | `/model`, Ctrl+P, or `--model antigravity/<id>`                                                   |
| Thinking level       | Shift+Tab, or `--thinking <level>`. Pi offers only the levels the agent has for that model.       |
| Permission requests  | A dialog with the agent's own choices, such as Allow and Deny. Esc declines.                      |
| Permission mode      | `/agy mode` to choose, `/agy mode <id>` to set, `--agy-mode <id>` at launch. Shown in the footer. |
| The agent's commands | `/agy <command> [input]`, for example `/agy goal ship the fix` or `/agy compact`. Tab completes.  |
| Plan                 | While the agent works through a plan, its steps show above the editor.                            |
| Context              | Pi's footer shows the agent's context use. `/agy status` gives the exact numbers.                 |
| Stop                 | Esc cancels the agent's turn.                                                                     |

`/agy status` also shows the agent's version, the quota tier it reports for your account, and the agent session id.

The agent's tool calls appear as Pi tool rows: `read`, `edit` with the changed line counts, `$` for commands with their output. Ctrl+O expands them.

Permission modes are the agent's. `agy acp` has `default`, `accept-edits`, `auto` and `plan`. In `default` it asks before every edit and command. When Pi has nobody to ask, as in `pi -p`, requests are declined; start in a mode that does not ask if you want unattended edits.

`agy` lists its own slash commands, including its skills, and `/agy` runs them as an ordinary message so they cannot clash with Pi's commands such as `/compact`. In `pi -p`, Pi exits before a run that a command starts, so type the agent's command directly instead, for example `pi -p "/compact"`.

### Conversations

One Pi session drives one agent session. A follow-up sends only your new message. Each assistant message Pi saves carries the agent session id and position (`<session>/<turn>.<part>`), and the next request compares against it:

- **Reopening a Pi session** (`pi -c`, `/resume`, a restart or `/reload`) reopens the same agent conversation with ACP's `session/load`, if the agent still has it at the same point. Nothing is resent.
- If the agent no longer has that conversation, or it went on without this Pi session, or Pi's conversation has history the agent never saw (for example after switching from another model), Pi starts a new agent session and supplies the visible conversation as context with your message.
- **Rewinding or branching in Pi** starts a new agent session with the visible conversation as context. The one it replaces is closed.
- A message typed while the agent is working is delivered after the running tools finish. It cancels the rest of that turn.

## Configure

| Flag                 | Effect                                                     |
| -------------------- | ---------------------------------------------------------- |
| `--agy-agent <name>` | Which agent to run; see below. Default `auto`.             |
| `--agy-mode <id>`    | Permission mode for new agent sessions, such as `default`. |

| `--agy-agent`    | Agent                                                         | Notes                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli`            | `agy acp`, part of the Antigravity CLI                        | Its conversations are stored with your other `agy` conversations.                                                                                                 |
| `registry`       | Google Antigravity from the ACP registry, as Zed installs it  | Found in Zed's data directory. Reads and writes files through Pi. Modes are `default`, `auto_edit` and `yolo`. Creates `skills/system/` in the project directory. |
| `auto` (default) | `agy acp` if `agy` is on `PATH`, otherwise the registry agent |                                                                                                                                                                   |

Everything else, such as models, quota, MCP servers and rules, is configured in the agent. The extension caches the agent's models, modes and commands in `antigravity/catalog.json` under Pi's agent directory so the model picker is filled before the agent starts; deleting it is safe.

## Compatibility

Tested with Pi 1.6.1, `agy` 1.5.17 and the registry agent 1.5.2 on macOS, using ACP protocol version 1 through `@agentclientprotocol/sdk` 2.12.0. The agent is started as a subprocess without a shell, and paths are handled with Node's platform functions; Linux and Windows have not been tested.

## Troubleshooting

| Symptom                                                     | Cause and fix                                                                                                                                      |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| "agy … not found on PATH"                                   | Install the Antigravity CLI, or pass `--agy-agent registry` if Zed installed the agent.                                                            |
| "Antigravity needs you to sign in"                          | Run `agy` in a terminal and sign in.                                                                                                               |
| A reply that says "Individual quota reached"                | The agent's message about your account's quota. It says when the quota resets; another model may still have quota.                                 |
| `Model "…" not found for provider "antigravity"` at launch  | Pi has not seen that model yet. Start with `antigravity/default` once so the agent's model list is cached.                                         |
| "Antigravity does not offer … right now"                    | The model is not available to your account now. Choose another with `/model`.                                                                      |
| Tool activity appears as notices, not tool rows             | `--tools` or `--no-tools` left out the `antigravity_tool` tool.                                                                                    |
| "Summaries and other background requests are not available" | Something other than the conversation, such as a branch summary, asked these models for text. The agent keeps its own context, so this is refused. |

## Limits

- **The agent runs the tools, not Pi.** Pi's own tools, skills, context files and tool hooks do not apply to these models. The agent has its own equivalents.
- **No Pi-side summaries.** The agent manages its context, so Pi's compaction and branch summaries are skipped or refused for these models. Use `/agy compact` for the agent's own.
- When the agent writes files through Pi, as the registry agent does, Pi writes only inside the session's working directory.
- Not implemented yet: signing in from Pi, Pi's MCP servers and extra workspace directories passed to the agent, client-side terminals, structured questions (elicitation) and browsing the agent's saved sessions. [PARITY.md](PARITY.md) lists each with its status.
- Quota, model access and account policy are the agent's and Google's. Nothing here changes what your account may do.

## Develop

```sh
bun install --frozen-lockfile
bun run check            # formatter, oxlint, tsc, vitest with a per-file 80% coverage gate
bun run bench            # the extension's own overhead against the bare ACP SDK
bun run verify:package   # pack, install with pi install, prompt, restart and continue, shut down
bun run pack             # build pi-antigravity-acp-<version>.tgz
```

The tests run without a Google account: a scripted ACP agent stands in for `agy`, both in memory and as a process on `PATH` under a real Pi session.

Live checks use your signed-in agent and normal quota. They drive real Pi in RPC mode through a greeting, model and thinking-level selection, a file read, an allowed edit, a denied command, a follow-up, a mode change, the context meter, an abort, `/agy compact`, and reopening a saved session after restarting Pi:

```sh
python3 tests/live-acp.py            # agy acp; its sessions go to ~/.gemini/antigravity-scratch
python3 tests/live-acp.py registry   # the agent Zed installed; sessions join that agent's history
```
