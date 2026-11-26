# Parity with Zed's Antigravity integration

This matrix compares each capability of Antigravity's ACP server with Zed's client and with this extension. It is the implementation checklist and the record of evidence.

**This extension does not have 100% parity.** The summary counts statuses; details follow.

## How it was established

| Source                                                  | Version or date                   | What was checked                                                                                                                                                                                                        |
| ------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agy acp` (Antigravity CLI)                             | 1.5.17                            | Raw JSON-RPC probes (`initialize`, `session/new`, `load`, `resume`, `list`, `close`, prompts): what it advertises and sends. The probes were one-off scripts; `tests/live-probe.py` repeats the feature-request probes. |
| Zed source, `crates/agent_servers`, `crates/acp_thread` | `main` at 8aeb64f (2026-11-25)    | Client capabilities Zed sends, session lifecycle calls, plan, command, elicitation and auth handling.                                                                                                                   |
| ACP SDK                                                 | `@agentclientprotocol/sdk` 2.12.0 | Methods, schema types and capability fields.                                                                                                                                                                            |
| Pi                                                      | 1.6.1                             | Extension, provider, command, widget, session and retry APIs, from the installed package's docs and source.                                                                                                             |

`agy` 1.5.17 advertises `loadSession`, `sessionCapabilities` {`load`, `resume`, `list`, `close`, `additionalDirectories`}, image and embedded-context prompts, `auth.logout`, four auth methods (`oauth-personal`, `oauth-business`, `gemini-api-key`, `agent-platform`) and `_meta.antigravity` {`tier`, `systemPrompt.append`}. Its sessions report `model`, `thought_level` and `mode` config options, `available_commands_update`, `usage_update`, `session_info_update`, `config_option_update` and `current_mode_update`.

Zed (8aeb64f) advertises to agents: `fs` read and write, `terminal`, `auth.terminal`, form and URL `elicitation`, `plan`, `subagents`, boolean config options, compaction and notices, and `_meta` `terminal_output` and `terminal-auth`. It calls `session/load`, `session/resume`, `session/list` and, when offered, `session/close`.

### Statuses

`verified` needs an automated test **and** a run against the real `agy`. A capability tested only with the scripted agent is `implemented_unverified`.

The last live runs were on 2026-11-25: `python3 tests/live-probe.py`, `python3 tests/live-acp.py` (19 steps passed) and `python3 tests/live-acp.py registry` (all steps passed, with notes that the registry agent titles no sessions and lists no `/compact`). In one earlier full run, the first prompt after restarting Pi was refused with "No API key found for the selected model"; it did not recur in nine more restarts, and the live script now reports Pi's restored model if it does.

| Status                 | Count |
| ---------------------- | ----- |
| verified               | 22    |
| implemented_unverified | 16    |
| not_started            | 0     |
| not_applicable         | 2     |
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
| SESS-4  | List saved sessions                      | verified               |
| SESS-5  | Close a session                          | implemented_unverified |
| SESS-6  | Prompt and streamed updates              | verified               |
| SESS-7  | Cancellation                             | verified               |
| SESS-8  | Steering mid-turn                        | implemented_unverified |
| SESS-9  | Model, thinking level and mode           | verified               |
| AUTH-1  | Use the existing sign-in                 | implemented_unverified |
| AUTH-2  | Sign in, choose a method, log out        | implemented_unverified |
| AG-1    | Account-specific models                  | verified               |
| AG-2    | The agent's slash commands               | verified               |
| AG-3    | Reasoning (thoughts)                     | implemented_unverified |
| AG-4    | Execution plans                          | implemented_unverified |
| AG-5    | Conversation titles                      | verified               |
| AG-6    | Interactive questions (elicitation)      | verified               |
| TOOL-1  | Tool calls, progress, results and errors | verified               |
| TOOL-2  | File reads and writes through the client | verified               |
| TOOL-3  | Diffs and edit previews                  | implemented_unverified |
| TOOL-4  | Terminal commands and output             | verified               |
| TOOL-5  | Client-side terminals                    | implemented_unverified |
| TOOL-6  | Permission requests                      | verified               |
| CTX-1   | Images                                   | verified               |
| CTX-2   | Embedded resources                       | implemented_unverified |
| CTX-3   | Workspace directory                      | verified               |
| CTX-4   | Additional workspace directories         | verified               |
| CTX-5   | MCP servers                              | implemented_unverified |
| CTX-6   | Skills and rules                         | implemented_unverified |
| CTX-7   | Subagents                                | not_applicable         |
| CTX-8   | Usage and session metadata               | verified               |
| LIFE-1  | Process lifecycle, reload and shutdown   | verified               |
| LIFE-2  | No repeated turns after a failure        | implemented_unverified |
| PKG-1   | Install through Pi's package mechanism   | implemented_unverified |
| PERF-1  | Measured extension overhead              | implemented_unverified |

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
- **Implementation:** advertises `fs.readTextFile`, `fs.writeTextFile`, `terminal`, `elicitation` (form and URL) and `plan`. The SDK adds `auth.terminal: false`. Not `subagents` (CTX-7).
- **Acceptance:** every advertised capability is implemented.
- **Verification:** `tests/client.test.ts` ("the client introduces itself as Pi and offers files, terminals, questions and nothing else").
- **Status:** verified. **Evidence:** both agents accepted this set: the live run on 2026-11-25 (`agy` 1.5.17, `python3 tests/live-acp.py`, 19 steps passed) answered a structured question, and the registry run on 2026-11-25 (agent 1.5.2, `python3 tests/live-acp.py registry`, all steps passed) read and edited files through Pi. **Limits:** see CTX-7.

### PROTO-3 JSON-RPC framing and request correlation

- **Reference:** newline-delimited JSON-RPC 2.0 over stdio. Source: ACP spec.
- **Applies:** yes. **ACP:** all. **Pi:** none.
- **Implementation:** the official SDK (`ndJsonStream`, `client()`), over the agent's stdin and stdout; stderr is discarded.
- **Acceptance:** concurrent requests and notifications in both directions are matched correctly.
- **Verification:** every client and extension test; live runs with permission requests during prompts.
- **Status:** verified. **Evidence:** suite and live runs. **Limits:** none.

### PROTO-4 Malformed messages and metadata

- **Reference:** the SDK validates `initialize` against the schema and forwards later messages as they are.
- **Applies:** yes. **ACP:** all.
- **Implementation:** the fields the extension reads are narrowed before use: Antigravity's untyped extras (`_meta.antigravity.tier`, `models.availableModels`) through type guards, ignored when malformed; the saved catalog through a zod schema.
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
- **Implementation:** on the first message, in Pi's working directory, with the MCP servers from `--agy-mcp` (none by default) and the directories from `--agy-dir` when the agent accepts them.
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
- **Applies:** yes; `agy` offers `session/list` and returns sessions with `cwd`, `title` and `updatedAt`. **Pi:** a command, a selector, `ctx.newSession`.
- **Implementation:** `/agy sessions` lists this directory's sessions (up to five pages) by title and date. Opening one reads its text from the `session/load` replay, closes it, and starts a new Pi session holding the conversation; each reply carries the agent session's position, so the next message reopens it through SESS-2.
- **Acceptance:** the new Pi session shows the conversation and its next message continues the same agent session without resending anything.
- **Verification:** `tests/sessions.test.ts`; the `/agy sessions` step of `features()` in `tests/live-acp.py`.
- **Status:** verified. **Evidence:** in the live run on 2026-11-25 (`agy` 1.5.17, `python3 tests/live-acp.py`, 19 steps passed) and the registry run on 2026-11-25 (agent 1.5.2, `python3 tests/live-acp.py registry`, all steps passed), the opened session answered with a marker from the earlier conversation, on the same agent session. **Limits:** only text is carried over; the agent's tool calls in the replay are not shown in Pi.

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
- **Applies:** yes; `agy` lists four methods and `auth.logout`. **ACP:** `authenticate`, `logout`. **Pi:** selector and confirm dialogs.
- **Implementation:** when a session needs sign-in, Pi offers the agent's methods and asks it to authenticate with the chosen one, then starts the session again. `/agy login` does the same on request; `/agy logout` asks for confirmation, then signs out and drops the agent process. Terminal methods are left out, since Pi does not advertise terminal sign-in.
- **Verification:** `tests/auth.test.ts`.
- **Status:** implemented_unverified: a live test needs a signed-out account, and the operator's account was not signed out. How `agy` completes `oauth-personal` from ACP (for example by opening a browser) is unknown.

### AG-1 Account-specific models

- **Applies:** yes. **ACP:** `model` config option and Antigravity's per-level `models` list.
- **Implementation:** the catalog learns each session's models and levels and registers them as Pi models.
- **Verification:** `tests/catalog.test.ts`; live model list.
- **Status:** verified. **Evidence:** live list `gemini-4-hydrogen`, `gemini-3.8-flash`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`.

### AG-2 The agent's slash commands

- **Reference:** Zed lists `available_commands_update` in its prompt's command menu.
- **Applies:** yes. **ACP:** `available_commands_update`; commands run as prompt text `/name input`. **Pi:** `registerCommand` completions, `sendUserMessage`.
- **Implementation:** `/agy <command> [input]` with completions and descriptions; the commands are cached for later sessions until the agent lists others. Routing through `/agy` avoids clashes with Pi's own commands; agent commands named like `/agy`'s own subcommands (`status`, `mode`, `sessions`, `login`, `logout`) are left out of `/agy` and typed directly.
- **Verification:** `tests/commands.test.ts`; live `/agy compact` step; the cached list after a live run had 24 commands.
- **Status:** verified. **Limits:** in `pi -p`, Pi does not wait for a run a command starts (Pi `print-mode.js`), so there the command must be typed directly.

### AG-3 Reasoning (thoughts)

- **Implementation:** `agent_thought_chunk` becomes Pi thinking blocks. **Verification:** `tests/client.test.ts`.
- **Status:** implemented_unverified: at thinking level low, neither agent sent thoughts in the live runs.

### AG-4 Execution plans

- **Reference:** Zed renders plan entries and markdown plans (`plan`, `plan_update`, `plan_removed`) and advertises `plan`.
- **Applies:** if the agent sends them. **ACP:** `session/update` `plan`, `plan_update`, `plan_removed`. **Pi:** `ui.setWidget`.
- **Implementation:** `src/plan.ts`. A list of steps shows above the editor while any step is unfinished; a markdown plan shows its first 20 lines until the agent removes it.
- **Verification:** `tests/plan.test.ts`; the plan step of `features()` in `tests/live-acp.py` reports what appears.
- **Status:** implemented_unverified: neither `agy` 1.5.17 nor the registry agent sent a plan, even in `/plan` mode (`tests/live-probe.py` and both live runs).

### AG-5 Conversation titles

- **Implementation:** `session_info_update` titles show in `/agy status`. **Verification:** `tests/index.test.ts`.
- **Status:** verified. **Evidence:** in the live run on 2026-11-25 (`agy` 1.5.17, `python3 tests/live-acp.py`, 19 steps passed), `/agy status` showed the agent's title for the session. **Limits:** the registry agent sends no titles.

### AG-6 Interactive questions (elicitation)

- **Reference:** Zed handles form and URL elicitation.
- **Applies:** yes; `agy` 1.5.17 asks with a form of `oneOf` choices plus an optional free-form field (`tests/live-probe.py`). **ACP:** `elicitation/create`, `elicitation/complete`. **Pi:** select and input dialogs.
- **Implementation:** `src/elicit.ts`. A form offers Answer or Decline, then asks each field with Pi's dialogs (choices for enums and yes/no, with No answer for an optional one; text for strings and numbers within their limits; comma-separated multi-select within its item count and uniqueness), asking again after a wrong answer, at most three times in all; Esc cancels. A URL question shows the link with Continue or Decline. Questions share the permission dialogs' queue and close with their turn; without a UI they are cancelled.
- **Verification:** `tests/elicit.test.ts`; the question step of `features()` in `tests/live-acp.py`.
- **Status:** verified. **Evidence:** in the live run on 2026-11-25 (`agy` 1.5.17, `python3 tests/live-acp.py`, 19 steps passed), the agent's question was answered in Pi's dialogs (Answer, Blue, the optional field left blank) and the agent replied "Blue". **Limits:** Pi does not open the link itself.

### TOOL-1 Tool calls, progress, results and errors

- **Reference:** Zed shows tool cards with status, content and locations.
- **Applies:** yes. **ACP:** `tool_call`, `tool_call_update`. **Pi:** the `antigravity_tool` mirror tool and its renderers.
- **Implementation:** each agent tool call becomes a Pi tool call that waits for the agent's result; nothing runs twice.
- **Verification:** `tests/tool.test.ts`, `tests/index.test.ts`; live read, edit and declined-command steps.
- **Status:** verified.

### TOOL-2 File reads and writes through the client

- **Applies:** yes for agents that use them; `agy acp` reads and writes files itself, the registry agent uses the client.
- **ACP:** `fs/read_text_file`, `fs/write_text_file`.
- **Implementation:** reads by absolute path, refusing devices, pipes and files over 16 MiB; writes only inside the session's directory and its `--agy-dir` directories, checked after resolving links and again for the real parent after creating it, without following a link at the file. A path that cannot be resolved, such as one through a link loop, a file with more than one hard link, and anything that is not a regular file, such as a pipe, are refused.
- **Verification:** `tests/fs.test.ts`, `tests/client.test.ts`.
- **Status:** verified. **Evidence:** in the registry run on 2026-11-25 (agent 1.5.2, `python3 tests/live-acp.py registry`, all steps passed), the agent read `marker.txt` (`client_view_file`) and, after Allow, edited `notes.txt` (`client_edit_file`) through Pi.

### TOOL-3 Diffs and edit previews

- **Reference:** Zed shows full diffs with a review UI.
- **Implementation:** edit rows show `+N -M` per file; expanded, the changed lines. **Verification:** `tests/render.test.ts`.
- **Status:** implemented_unverified. **Discrepancy:** no side-by-side review or per-hunk accept; Pi has no such component.

### TOOL-4 Terminal commands and output

- **Implementation:** command calls render as `$ command` rows with their output, from the agent's own output or from a client terminal the call embeds (TOOL-5).
- **Verification:** `tests/render.test.ts`, `tests/terminal.test.ts`; the terminal step of `features()` in `tests/live-acp.py`.
- **Status:** verified. **Evidence:** in the live run on 2026-11-25 (`agy` 1.5.17, `python3 tests/live-acp.py`, 19 steps passed) and the registry run on 2026-11-25 (agent 1.5.2, `python3 tests/live-acp.py registry`, all steps passed), the output of `echo TERMINAL-…` showed in its Pi tool row.

### TOOL-5 Client-side terminals

- **Reference:** Zed advertises `terminal` and runs commands the agent asks for.
- **Applies:** if the agent uses it; `agy` 1.5.17 runs commands itself and never asked for a client terminal (`tests/live-probe.py`). **ACP:** `terminal/create`, `output`, `wait_for_exit`, `kill`, `release`.
- **Implementation:** `src/terminal.ts`. Commands run without a shell in the session's directory or another absolute one, with the agent's environment additions; output is kept up to the agent's byte limit, at most 1 MiB, cut from the start. Kill signals the command's process group (SIGTERM, then SIGKILL after a second), so what it started stops too; an exit is reported within a second even if a process it left behind keeps the output open. A session reaches only its own terminals; closing a session or the connection releases them, including when the agent process dies.
- **Verification:** `tests/terminal.test.ts`.
- **Status:** implemented_unverified: no live agent has used it.

### TOOL-6 Permission requests

- **Reference:** Zed shows the agent's options as buttons.
- **ACP:** `session/request_permission`. **Pi:** `ui.select`.
- **Implementation:** a dialog with the agent's own options, one at a time; no UI means the reject option; a turn ending closes open dialogs.
- **Verification:** `tests/session.test.ts`, `tests/index.test.ts`; live Allow and Deny steps.
- **Status:** verified.

### CTX-1 Images

- **Implementation:** Pi image attachments become ACP image blocks when the agent accepts images; otherwise a clear error.
- **Verification:** `tests/stream.test.ts`; the image step of `features()` in `tests/live-acp.py`.
- **Status:** verified. **Evidence:** in the live run on 2026-11-25 (`agy` 1.5.17, `python3 tests/live-acp.py`, 19 steps passed) and the registry run on 2026-11-25 (agent 1.5.2, `python3 tests/live-acp.py registry`, all steps passed), both agents named the color of a red image attachment.

### CTX-2 Embedded resources

- **Implementation:** conversation the agent has not seen is sent as an embedded `resource` when accepted, otherwise as text.
- **Verification:** `tests/stream.test.ts`, `tests/restore.test.ts`. **Status:** implemented_unverified live.

### CTX-3 Workspace directory

- **Implementation:** `cwd` of `session/new` and `session/load` is Pi's working directory, and the process starts there.
- **Verification:** `tests/index.test.ts`; live marker-file read. **Status:** verified.

### CTX-4 Additional workspace directories

- **Reference:** Zed passes extra worktrees when `additionalDirectories` is offered.
- **Applies:** yes; `agy` offers it. **Pi:** one working directory, so a flag.
- **Implementation:** `--agy-dir` lists directories separated like `PATH`, resolved from the workspace; missing ones are reported. They go to `session/new` and `session/load` only for agents that offer the capability.
- **Verification:** `tests/workspace.test.ts`, `tests/client-handshake.test.ts`; the `--agy-dir` step of `features()` in `tests/live-acp.py`.
- **Status:** verified. **Evidence:** in the live run on 2026-11-25 (`agy` 1.5.17, `python3 tests/live-acp.py`, 19 steps passed) and the registry run on 2026-11-25 (agent 1.5.2, `python3 tests/live-acp.py registry`, all steps passed), both agents read a marker file in a directory outside the workspace given with `--agy-dir`.

### CTX-5 MCP servers

- **Reference:** Zed passes its configured context servers in `mcpServers`.
- **Applies:** yes, opt-in: `agy` has its own MCP configuration, and Pi's servers would otherwise run twice.
- **Implementation:** `--agy-mcp` passes Pi's configured servers. Pi does not export its loader, so `src/mcp.ts` reads `mcp.json` in the documented format (the user file, then a trusted project's), expanding `${VAR}` and `~/`. Skipped with a notice: `!command` values, OAuth servers, a `cwd` (ACP cannot pass one) and SSE. HTTP servers go only to agents that accept them; `agy` 1.5.17 advertises no `mcpCapabilities`, so it gets stdio servers only.
- **Verification:** `tests/mcp.test.ts`, `tests/workspace.test.ts`.
- **Status:** implemented_unverified: not run against the real agent.

### CTX-6 Skills and rules

- **Implementation:** the agent applies its own skills and rules; its skills appear among its commands and run through `/agy`.
- **Verification:** live command list included `find-docs`, `twg` and other skills. **Status:** implemented_unverified: running a skill was not tested live.

### CTX-7 Subagents

- **Reference:** Zed advertises `subagents` and shows child sessions.
- **Applies:** no, for `agy` 1.5.17. Offered `subagents` by `tests/live-probe.py` and asked to use one, it sent no `subagent_update`; the subagent's tool calls arrived as ordinary tool calls in the same session, with ids of the form `<subagent>:call_…`, and its permission requests as ordinary requests. Those already show as Pi tool rows and dialogs. **ACP:** `subagent_update`.
- **Implementation:** nothing beyond ordinary tool calls; `subagents` is not advertised.
- **Status:** not_applicable, until an agent sends `subagent_update`.

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
- **Status:** implemented_unverified: the installed package was driven by the scripted agent, not the real one. **Limits:** not published to npm, so `pi install npm:pi-antigravity-acp` is untested; Pi installs `npm:` sources by registry name, so a tarball path cannot stand in for the published package.

### PERF-1 Measured extension overhead

- **Implementation:** `bun run bench` compares the bare SDK with the extension on the same exchange.
- **Evidence:** about 1 µs per streamed chunk and 10 to 22 µs to receive a tool call carrying 200 KB of output (not mirrored into a tool row), from two local runs; see [ARCHITECTURE.md](ARCHITECTURE.md#performance). Not compared with Zed, and not measured against the real agent.
- **Status:** implemented_unverified.
