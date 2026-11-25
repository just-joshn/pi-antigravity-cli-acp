# Antigravity in Pi over ACP

Use Google's Antigravity agent from Pi the way Zed does. **Pi is the [ACP](https://agentclientprotocol.com/) client and Antigravity is the agent.** You pick an Antigravity model in Pi's model picker and type normally. The agent keeps the conversation, runs its own tools and asks Pi's user for permission.

Pi sends the agent your words and nothing else: no Pi system prompt, no Pi tool list. Asked which harness it runs in, the model answers "Antigravity", because that is what it runs in. Pi introduces itself to the agent as `pi` in the ACP handshake. Sign-in stays with the agent; this extension never reads a token.

## Try it

1. Run `agy` once in a terminal and check it answers a question. Sign in there if asked.
2. From this checkout:

   ```sh
   bun install
   pi -e ./src/index.ts --model antigravity/default
   ```

3. Say hello. `antigravity/default` uses whichever model the agent is set to.

After the first reply, `/model` lists the agent's own models under `antigravity`, for example `gemini-4-hydrogen` and `gemini-3.8-flash`. Pi remembers the list, so later runs can start on one directly:

```sh
pi -e ./src/index.ts --model antigravity/gemini-3.8-flash
```

To have the models in every project, install the checkout once with `pi install "$PWD"` and keep it at that path.

## Controls

| Control             | In Pi                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| Model               | `/model`, Ctrl+P, or `--model antigravity/<id>`                                                   |
| Thinking level      | Shift+Tab, or `--thinking <level>`. Pi offers only the levels the agent has for that model.       |
| Permission requests | A dialog with the agent's own choices, such as Allow and Deny. Esc declines.                      |
| Permission mode     | `/agy mode` to choose, `/agy mode <id>` to set, `--agy-mode <id>` at launch. Shown in the footer. |
| Context             | Pi's footer shows the agent's context use. `/agy status` gives the exact numbers.                 |
| Stop                | Esc cancels the agent's turn.                                                                     |

`/agy status` also shows the agent's version, the quota tier it reports for your account, and the agent session id.

The agent's tool calls appear as Pi tool rows: `read`, `edit` with the changed line counts, `$` for commands with their output. Ctrl+O expands them.

Permission modes are the agent's. `agy acp` has `default`, `accept-edits`, `auto` and `plan`. In `default` it asks before every edit and command. When Pi has nobody to ask, as in `pi -p`, requests are declined; start in a mode that does not ask if you want unattended edits.

## Which agent runs

| `--agy-agent`    | Agent                                                         | Notes                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli`            | `agy acp`, part of the Antigravity CLI                        | Its conversations are stored with your other `agy` conversations.                                                                                                 |
| `registry`       | Google Antigravity from the ACP registry, as Zed installs it  | Found in Zed's data directory. Reads and writes files through Pi. Modes are `default`, `auto_edit` and `yolo`. Creates `skills/system/` in the project directory. |
| `auto` (default) | `agy acp` if `agy` is on `PATH`, otherwise the registry agent |                                                                                                                                                                   |

Both were tested. They speak the same protocol and differ in models, modes and where they keep data.

## How a conversation maps to Pi

One Pi session drives one agent session. A follow-up sends only your new message. Each assistant message Pi stores carries the agent session's position, and the next request compares against it:

- If Pi's conversation has history the agent has not seen, for example after switching from another model or resuming a saved Pi session, Pi supplies that history as context with your message.
- If you rewind or branch in Pi, the agent session no longer matches. Pi starts a new agent session and supplies the visible conversation as context.
- A message typed while the agent is working is delivered after the running tools finish. It cancels the rest of that turn.

## Limits

- **The agent runs the tools, not Pi.** Pi's own tools, skills, context files and tool hooks do not apply to these models. The agent has its own equivalents.
- **No Pi-side summaries.** The agent manages its context, so Pi's compaction and branch summaries are skipped or refused for these models.
- **A resumed Pi session gets a new agent session.** The agent sees the earlier conversation as text, not its original internal state.
- When the agent writes files through Pi, as the registry agent does, Pi writes only inside the session's working directory.
- Tool rows need the `antigravity_tool` tool. If you restrict tools with `--tools` or `--no-tools` and leave it out, tool activity is shown as notices instead.
- Not passed through: Pi's MCP servers, the agent's plan panel and slash-command list, and client-side terminals.
- Quota, model access and account policy are the agent's and Google's. Nothing here changes what your account may do, and using ACP is not a guarantee about enforcement.

## Verify

```sh
bun install --frozen-lockfile
bun run typecheck:provider
bun run lint
bun run test
```

The tests run without a Google account: a scripted ACP agent stands in for `agy`, both in memory and as a process on `PATH` under a real Pi session.

Live checks use your signed-in agent and normal quota. They drive real Pi in RPC mode through a greeting, model and thinking-level selection, a file read, an allowed edit, a denied command, a follow-up, a mode change, the context meter and an abort:

```sh
python3 tests/live-acp.py            # agy acp; its sessions go to ~/.gemini/antigravity-scratch
python3 tests/live-acp.py registry   # the agent Zed installed; sessions join that agent's history
```

Tested with Pi 1.6.0, `agy` 1.5.17 and the registry agent 1.5.2 on macOS.
