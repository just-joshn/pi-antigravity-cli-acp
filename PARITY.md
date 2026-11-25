# Parity with Zed's Antigravity integration

This matrix compares each capability of Antigravity's ACP server with Zed's client and with this extension. It is the implementation checklist and the record of evidence.

**This extension does not have 100% parity.** The summary counts statuses; details follow.

## How it was established

| Source                                                  | Version or date                   | What was checked                                                                                                                                                            |
| ------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agy acp` (Antigravity CLI)                             | 1.5.17                            | Raw JSON-RPC probes (`initialize`, `session/new`, `load`, `resume`, `list`, `close`, prompts): what it advertises and sends. Scripts were in `/tmp/probe` during this work. |
| Zed source, `crates/agent_servers`, `crates/acp_thread` | `main` at 8aeb64f (2026-11-25)    | Client capabilities Zed sends, session lifecycle calls, plan, command, elicitation and auth handling.                                                                       |
| ACP SDK                                                 | `@agentclientprotocol/sdk` 2.12.0 | Methods, schema types and capability fields.                                                                                                                                |
| Pi                                                      | 1.6.1                             | Extension, provider, command, widget, session and retry APIs, from the installed package's docs and source.                                                                 |

`agy` 1.5.17 advertises `loadSession`, `sessionCapabilities` {`load`, `resume`, `list`, `close`, `additionalDirectories`}, image and embedded-context prompts, `auth.logout`, four auth methods (`oauth-personal`, `oauth-business`, `gemini-api-key`, `agent-platform`) and `_meta.antigravity` {`tier`, `systemPrompt.append`}. Its sessions report `model`, `thought_level` and `mode` config options, `available_commands_update`, `usage_update`, `session_info_update`, `config_option_update` and `current_mode_update`.

Zed (8aeb64f) advertises to agents: `fs` read and write, `terminal`, `auth.terminal`, form and URL `elicitation`, `plan`, `subagents`, boolean config options, compaction and notices, and `_meta` `terminal_output` and `terminal-auth`. It calls `session/load`, `session/resume`, `session/list` and, when offered, `session/close`.

### Statuses

`verified` needs an automated test **and** a run against the real `agy`. A capability tested only with the scripted agent is `implemented_unverified`. Live testing stopped partway through this work because the account's quota ran out ("Individual quota reached … Resets in 123h"), which left several items unverified.

| Status                 | Count |
| ---------------------- | ----- |
| verified               | 15    |
| implemented_unverified | 17    |
| not_started            | 7     |
| not_applicable         | 1     |
| upstream_blocked       | 0     |

## Summary

| ID      | Capability                               | Status                 |
| ------- | ---------------------------------------- | ---------------------- |
| PROTO-1 | Initialization and version negotiation   | verified               |
| PROTO-2 | Client capability advertisement          | verified               |
| PROTO-3 | JSON-RPC framing and request correlation | verified               |
| PROTO-4 | Malformed messages and metadata          | implemented_unverified |
| PROTO-5 | Protocol errors and recovery             | implemented_unverified |
| SESS-1  | Create a session                         | verified               |
| SESS-2  | Reopen a saved session (`session/load`)  | verified               |
| SESS-3  | `session/resume`                         | not_applicable         |
| SESS-4  | List saved sessions                      | not_started            |
| SESS-5  | Close a session                          | implemented_unverified |
| SESS-6  | Prompt and streamed updates              | verified               |
| SESS-7  | Cancellation                             | verified               |
| SESS-8  | Steering mid-turn                        | implemented_unverified |
| SESS-9  | Model, thinking level and mode           | verified               |
| AUTH-1  | Use the existing sign-in                 | implemented_unverified |
| AUTH-2  | Sign in, choose a method, log out        | not_started            |
| AG-1    | Account-specific models                  | verified               |
| AG-2    | The agent's slash commands               | verified               |
| AG-3    | Reasoning (thoughts)                     | implemented_unverified |
| AG-4    | Execution plans                          | implemented_unverified |
| AG-5    | Conversation titles                      | implemented_unverified |
| AG-6    | Interactive questions (elicitation)      | not_started            |
| TOOL-1  | Tool calls, progress, results and errors | verified               |
| TOOL-2  | File reads and writes through the client | implemented_unverified |
| TOOL-3  | Diffs and edit previews                  | implemented_unverified |
| TOOL-4  | Terminal commands and output             | implemented_unverified |
| TOOL-5  | Client-side terminals                    | not_started            |
| TOOL-6  | Permission requests                      | verified               |
| CTX-1   | Images                                   | implemented_unverified |
| CTX-2   | Embedded resources                       | implemented_unverified |
| CTX-3   | Workspace directory                      | verified               |
| CTX-4   | Additional workspace directories         | not_started            |
| CTX-5   | MCP servers                              | not_started            |
| CTX-6   | Skills and rules                         | implemented_unverified |
| CTX-7   | Subagents                                | not_started            |
| CTX-8   | Usage and session metadata               | verified               |
| LIFE-1  | Process lifecycle, reload and shutdown   | verified               |
| LIFE-2  | No repeated turns after a failure        | implemented_unverified |
| PKG-1   | Install through Pi's package mechanism   | implemented_unverified |
| PERF-1  | Measured extension overhead              | implemented_unverified |

Not all applicable capabilities are verified, so parity is not claimed.

## Details

Each entry gives the reference behavior and its source, whether it applies, the ACP methods and Pi APIs involved, the implementation, the acceptance criteria, how it was checked, its status, the evidence and any upstream limitation.

### PROTO-1 Initialization and version negotiation

- **Reference:** Zed sends `initialize` with its capabilities and checks the agent's protocol version. Source: Zed `agent_servers/src/acp/v1.rs`; ACP spec.
- **Applies:** yes. **ACP:** `initialize`. **Pi:** none.
- **Implementation:** `AcpClient.connect` sends protocol version 1 and `clientInfo` {name `pi`, title `Pi`, Pi's version}; a different version closes the connection with an error.
- **Acceptance:** handshake succeeds with `agy`; a mismatched version is refused with a clear message.
- **Verification:** `tests/client-handshake.test.ts`, `tests/client.test.ts`; live greeting in `tests/live-acp.py`.
- **Status:** verified. **Evidence:** suite passes; live run on `agy` 1.5.17 passed all 12 steps. **Limits:** none.

### PROTO-2 Client capability advertisement

- **Reference:** Zed advertises fs, terminal, auth, elicitation, plan and subagents (see above).
- **Applies:** yes, limited to what this client implements. **ACP:** `initialize.clientCapabilities`.
- **Implementation:** advertises `fs.readTextFile` and `fs.writeTextFile`, and `terminal: false`. Nothing else, because nothing else is implemented.
- **Acceptance:** every advertised capability is implemented.
- **Verification:** `tests/client.test.ts` ("the client introduces itself as Pi and offers file access but no terminal").
- **Status:** verified. **Evidence:** test plus live runs. **Limits:** see TOOL-5, AG-6, CTX-7.

### PROTO-3 JSON-RPC framing and request correlation

- **Reference:** newline-delimited JSON-RPC 2.0 over stdio. Source: ACP spec.
- **Applies:** yes. **ACP:** all. **Pi:** none.
- **Implementation:** the official SDK (`ndJsonStream`, `client()`), over the agent's stdin and stdout; stderr is discarded.
- **Acceptance:** concurrent requests and notifications in both directions are matched correctly.
- **Verification:** every client and extension test; live runs with permission requests during prompts.
- **Status:** verified. **Evidence:** suite and live runs. **Limits:** none.

### PROTO-4 Malformed messages and metadata

- **Reference:** the SDK validates messages against the schema.
- **Applies:** yes. **ACP:** all.
- **Implementation:** schema validation by the SDK; Antigravity's untyped extras (`_meta.antigravity.tier`, `models.availableModels`) are read through type guards and ignored when malformed. Saved catalogs are validated the same way.
- **Acceptance:** malformed extras and files never break a session.
- **Verification:** `tests/client-handshake.test.ts` ("a tier or per-level model list of the wrong shape is ignored"), `tests/catalog.test.ts`.
- **Status:** implemented_unverified: malformed JSON-RPC frames are left to the SDK and not tested here. **Limits:** none known.

### PROTO-5 Protocol errors and recovery

- **Reference:** Zed maps ACP errors to UI states, including an auth-required state.
- **Applies:** yes. **ACP:** error `-32000` (auth required), `-32002` (not found), closed connections.
- **Implementation:** auth required becomes "Antigravity needs you to sign in…"; other failures name the action and the reason; a closed connection fails the turn and the next message starts a new agent process; a missing saved session falls back to a new one.
- **Acceptance:** each failure ends the turn with an actionable message and the next message works.
- **Verification:** `tests/client-handshake.test.ts`, `tests/restore.test.ts` (agent process dies mid-turn).
- **Status:** implemented_unverified: a crash of the real agent was not induced. **Limits:** none.

### SESS-1 Create a session

- **Reference:** `session/new` with the workspace and MCP servers.
- **Applies:** yes. **ACP:** `session/new`. **Pi:** provider stream.
- **Implementation:** on the first message, in Pi's working directory, with `mcpServers: []`.
- **Acceptance:** one agent session per Pi session; settings, usage and commands sent before the reply are kept.
- **Verification:** `tests/client.test.ts`, `tests/index.test.ts`; the live greeting step in `tests/live-acp.py`.
- **Status:** verified. **Limits:** see CTX-5.

### SESS-2 Reopen a saved session

- **Reference:** Zed reopens threads with `session/load` or `session/resume`.
- **Applies:** yes; `agy` advertises `loadSession`. **ACP:** `session/load`. **Pi:** saved sessions, `session_start`, `responseId`.
- **Implementation:** each assistant message carries `<agent session>/<turn>.<part>`. When Pi reopens a session, the extension loads the named agent session, counts the prompts the agent replays and continues only if the count matches. Otherwise it closes the loaded session and starts a new one with the visible history. Nothing is resent.
- **Acceptance:** after restarting Pi, `--continue` reaches the same agent conversation without resending history; a mismatch never mixes conversations.
- **Verification:** `tests/restore.test.ts` (reopen, missing, diverged, no load support, reload, fresh session); `tests/client-handshake.test.ts`; live `restore()` step in `tests/live-acp.py`; `bun run verify:package`.
- **Status:** verified. **Evidence:** live run reopened agent session `32087d80…` and recalled the code word; a manual `pi -p` then `pi -c -p` run stamped turns 1 and 2 on the same agent session. **Limits:** the check compares turn counts, not prompt text. Two Pi processes continuing the same saved agent session at the same time could both pass it and interleave their prompts there.

### SESS-3 `session/resume`

- **Reference:** Zed uses `session/resume` when it has the thread already.
- **Applies:** no. `session/resume` restores without replaying (probe: only `available_commands_update` and `session_info_update` arrive), so the client cannot check that the agent is at the point Pi's transcript expects. `session/load` gives the replay to count, at a measured cost of 0.69 s against 0.49 s for resume.
- **Status:** not_applicable. **Evidence:** probe of `agy` 1.5.17.

### SESS-4 List saved sessions

- **Reference:** Zed lists agent sessions in its history view (`session/list`).
- **Applies:** yes; `agy` returns sessions with `cwd`, `title` and `updatedAt`. **Pi:** a command with a selector, then a new Pi session.
- **Implementation:** none. Opening an agent session that Pi has no transcript for would need Pi messages built from the replay.
- **Status:** not_started. **Limits:** none known.

### SESS-5 Close a session

- **Reference:** Zed closes sessions it drops when the agent offers `session/close`.
- **Applies:** yes. **ACP:** `session/close`.
- **Implementation:** a session replaced by a rewind, or loaded and rejected, is closed when offered. Closing is best effort.
- **Verification:** `tests/index.test.ts` (rewind closes one), `tests/restore.test.ts`, `tests/client-handshake.test.ts`.
- **Status:** implemented_unverified: `agy` answered a probe `session/close` with `{}`, but the extension's close was not run live.

### SESS-6 Prompt and streamed updates

- **Reference:** Zed renders message, thought, tool and plan updates as they arrive.
- **Applies:** yes. **ACP:** `session/prompt`, `session/update`. **Pi:** provider stream events.
- **Implementation:** only new user messages are sent; updates are relayed in order as Pi text, thinking and tool-call events.
- **Verification:** `tests/client.test.ts`, `tests/stream.test.ts`; the live greeting and harness-question steps in `tests/live-acp.py`.
- **Status:** verified.

### SESS-7 Cancellation

- **Reference:** Zed sends `session/cancel` and waits for the turn to end.
- **Applies:** yes. **ACP:** `session/cancel`. **Pi:** abort signal, Esc.
- **Implementation:** cancel, abort open permission dialogs, wait up to 5 s; if the agent does not confirm, stop the process.
- **Verification:** `tests/stream-halt.test.ts`, `tests/index.test.ts`; live abort step.
- **Status:** verified. **Evidence:** live abort, then the same agent session answered.

### SESS-8 Steering mid-turn

- **Reference:** Zed queues a message typed during a turn.
- **Applies:** yes. **Pi:** steering and follow-up messages.
- **Implementation:** a message Pi delivers during a turn cancels the rest of that turn and is sent next.
- **Verification:** `tests/stream.test.ts` ("a message typed during a turn stops that turn and is sent next").
- **Status:** implemented_unverified: not run live.

### SESS-9 Model, thinking level and mode

- **Reference:** Zed shows the agent's config options as pickers.
- **Applies:** yes. **ACP:** `session/set_config_option`, `config_option_update`, `current_mode_update`. **Pi:** model picker, thinking levels, `/agy mode`, footer status.
- **Implementation:** models become Pi models; Pi's thinking levels map to the agent's per model; modes through `/agy mode` and `--agy-mode`.
- **Verification:** `tests/catalog.test.ts`, `tests/index.test.ts`; live model, thinking and mode steps.
- **Status:** verified.

### AUTH-1 Use the existing sign-in

- **Reference:** Zed starts the agent, which uses its stored sign-in.
- **Applies:** yes. **Implementation:** the extension starts `agy acp` and never touches credentials.
- **Verification:** all live steps ran on the existing sign-in. **Status:** implemented_unverified: no automated test checks that credentials are never read.

### AUTH-2 Sign in, choose a method, log out

- **Reference:** Zed offers the agent's auth methods and runs terminal sign-in (`auth.terminal`, `terminal-auth`).
- **Applies:** yes; `agy` lists four methods and `auth.logout`. **ACP:** `authenticate`, logout. **Pi:** selector dialog.
- **Implementation:** none; an auth-required error tells the user to sign in with `agy`.
- **Status:** not_started. Testing it needs a signed-out account, and signing out the operator's account was not done without consent.

### AG-1 Account-specific models

- **Applies:** yes. **ACP:** `model` config option and Antigravity's per-level `models` list.
- **Implementation:** the catalog learns each session's models and levels and registers them as Pi models.
- **Verification:** `tests/catalog.test.ts`; live model list.
- **Status:** verified. **Evidence:** live list `gemini-4-hydrogen`, `gemini-3.8-flash`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`.

### AG-2 The agent's slash commands

- **Reference:** Zed lists `available_commands_update` in its prompt's command menu.
- **Applies:** yes. **ACP:** `available_commands_update`; commands run as prompt text `/name input`. **Pi:** `registerCommand` completions, `sendUserMessage`.
- **Implementation:** `/agy <command> [input]` with completions and descriptions; the commands are cached for later sessions until the agent lists others. Routing through `/agy` avoids clashes with Pi's own commands; agent commands named `status` or `mode` are left out of `/agy` and typed directly.
- **Verification:** `tests/commands.test.ts`; live `/agy compact` step; the cached list after a live run had 24 commands.
- **Status:** verified. **Limits:** in `pi -p`, Pi does not wait for a run a command starts (Pi `print-mode.js`), so there the command must be typed directly.

### AG-3 Reasoning (thoughts)

- **Implementation:** `agent_thought_chunk` becomes Pi thinking blocks. **Verification:** `tests/client.test.ts`.
- **Status:** implemented_unverified: live thoughts were not asserted.

### AG-4 Execution plans

- **Reference:** Zed renders plan entries (`PlanUpdate`).
- **Applies:** if the agent sends them. **ACP:** `session/update` `plan`. **Pi:** `ui.setWidget`.
- **Implementation:** the latest plan shows above the editor while any entry is unfinished.
- **Verification:** `tests/plan.test.ts`.
- **Status:** implemented_unverified: whether `agy` 1.5.17 sends plan updates is unknown; the probe in plan mode hit the quota.

### AG-5 Conversation titles

- **Implementation:** `session_info_update` titles show in `/agy status`. **Verification:** `tests/index.test.ts`.
- **Status:** implemented_unverified: the live title was seen in probes, not asserted through the extension.

### AG-6 Interactive questions (elicitation)

- **Reference:** Zed handles form and URL elicitation.
- **Applies:** unknown; `agy` did not request it in probes, which were cut short by the quota.
- **Status:** not_started.

### TOOL-1 Tool calls, progress, results and errors

- **Reference:** Zed shows tool cards with status, content and locations.
- **Applies:** yes. **ACP:** `tool_call`, `tool_call_update`. **Pi:** the `antigravity_tool` mirror tool and its renderers.
- **Implementation:** each agent tool call becomes a Pi tool call that waits for the agent's result; nothing runs twice.
- **Verification:** `tests/tool.test.ts`, `tests/index.test.ts`; live read, edit and declined-command steps.
- **Status:** verified.

### TOOL-2 File reads and writes through the client

- **Applies:** yes for agents that use them; `agy acp` reads and writes files itself, the registry agent uses the client.
- **ACP:** `fs/read_text_file`, `fs/write_text_file`.
- **Implementation:** reads by absolute path, refusing devices, pipes and files over 16 MB; writes only inside the session's directory, checked after resolving links and again for the real parent after creating it, without following a link at the file.
- **Verification:** `tests/fs.test.ts`, `tests/client.test.ts`.
- **Status:** implemented_unverified: `python3 tests/live-acp.py registry` was not run on this branch.

### TOOL-3 Diffs and edit previews

- **Reference:** Zed shows full diffs with a review UI.
- **Implementation:** edit rows show `+N -M` per file; expanded, the changed lines. **Verification:** `tests/render.test.ts`.
- **Status:** implemented_unverified. **Discrepancy:** no side-by-side review or per-hunk accept; Pi has no such component.

### TOOL-4 Terminal commands and output

- **Implementation:** command calls render as `$ command` rows with their output. **Verification:** `tests/render.test.ts`, live declined command.
- **Status:** implemented_unverified: output of a command that ran was not asserted live.

### TOOL-5 Client-side terminals

- **Reference:** Zed advertises `terminal` and runs commands the agent asks for.
- **Applies:** unknown whether `agy` uses it; the probe with `terminal: true` hit the quota.
- **Status:** not_started; the extension advertises `terminal: false`.

### TOOL-6 Permission requests

- **Reference:** Zed shows the agent's options as buttons.
- **ACP:** `session/request_permission`. **Pi:** `ui.select`.
- **Implementation:** a dialog with the agent's own options, one at a time; no UI means the reject option; a turn ending closes open dialogs.
- **Verification:** `tests/session.test.ts`, `tests/index.test.ts`; live Allow and Deny steps.
- **Status:** verified.

### CTX-1 Images

- **Implementation:** Pi image attachments become ACP image blocks when the agent accepts images; otherwise a clear error.
- **Verification:** `tests/stream.test.ts`. **Status:** implemented_unverified: no live image prompt.

### CTX-2 Embedded resources

- **Implementation:** conversation the agent has not seen is sent as an embedded `resource` when accepted, otherwise as text.
- **Verification:** `tests/stream.test.ts`, `tests/restore.test.ts`. **Status:** implemented_unverified live.

### CTX-3 Workspace directory

- **Implementation:** `cwd` of `session/new` and `session/load` is Pi's working directory, and the process starts there.
- **Verification:** `tests/index.test.ts`; live marker-file read. **Status:** verified.

### CTX-4 Additional workspace directories

- **Reference:** Zed passes extra worktrees when `additionalDirectories` is offered.
- **Applies:** `agy` offers it; Pi has one working directory and no API for more.
- **Status:** not_started. A flag could pass extra directories; none exists yet.

### CTX-5 MCP servers

- **Reference:** Zed passes its configured context servers in `mcpServers`.
- **Applies:** partly: `agy` uses its own MCP configuration; passing Pi's would need Pi's MCP server list.
- **Status:** not_started; `mcpServers` is `[]`.

### CTX-6 Skills and rules

- **Implementation:** the agent applies its own skills and rules; its skills appear among its commands and run through `/agy`.
- **Verification:** live command list included `find-docs`, `twg` and other skills. **Status:** implemented_unverified: running a skill was not tested live.

### CTX-7 Subagents

- **Reference:** Zed advertises `subagents`.
- **Applies:** unknown for `agy`. **Status:** not_started.

### CTX-8 Usage and session metadata

- **Implementation:** `usage_update` feeds Pi's context meter; the tier from `_meta.antigravity.tier` shows in `/agy status`.
- **Verification:** `tests/client.test.ts`; live context meter step.
- **Status:** verified.

### LIFE-1 Process lifecycle, reload and shutdown

- **Implementation:** start on need, reuse, restart after exit, stop on `session_shutdown` with SIGKILL after 1 s; reload continues the conversation through `session/load`.
- **Verification:** `tests/agent.test.ts`, `tests/restore.test.ts` (reload), `bun run verify:package` (no agent process outlives Pi); live runs.
- **Status:** verified.

### LIFE-2 No repeated turns after a failure

- **Reference:** spec requirement: no silent repeats of non-idempotent operations.
- **Implementation:** a user message whose turn failed after reaching the agent is never sent again automatically; Pi's auto-retry gets a non-retryable explanation instead.
- **Verification:** `tests/restore.test.ts` (agent dies mid-turn), `tests/stream-halt.test.ts` (message checked against Pi's retry classifier).
- **Status:** implemented_unverified: not induced against the real agent. **Limits:** Pi gives extensions no way to veto a retry; this relies on Pi's classifier not matching the message.

### PKG-1 Install through Pi's package mechanism

- **Implementation:** package `pi-antigravity-acp` with a `pi.extensions` manifest; `zod`, a required peer of the ACP SDK, is a dependency because Pi does not install peers.
- **Verification:** `bun run verify:package` packs, installs with `pi install`, prompts, restarts and continues, and shuts down, with the scripted agent.
- **Status:** implemented_unverified: the installed package was driven by the scripted agent, not the real one. **Limits:** not published to npm, so `pi install npm:pi-antigravity-acp` is untested; `pi install npm:<tarball path>` did not load the package in Pi 1.6.1.

### PERF-1 Measured extension overhead

- **Implementation:** `bun run bench` compares the bare SDK with the extension on the same exchange.
- **Evidence:** about 1 µs per streamed chunk and 20 µs per 200 KB tool result, from two local runs; see [ARCHITECTURE.md](ARCHITECTURE.md#performance). Not compared with Zed, and not measured against the real agent.
- **Status:** implemented_unverified.
