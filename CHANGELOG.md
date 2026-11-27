# Changelog

## 0.2.0 (Unreleased)

### Breaking changes

- Use Node.js 22.23.5 or later in the 22 series, 24.22.3 or later in the 24 series, or 26.13.1 or later in the 26 series. Upgrade Node before installing this version if you used an older version.
- Source checkouts now use npm instead of Bun. Run `npm ci --ignore-scripts` to install the locked dependencies, then `npm run verify` to run the checks.

### Changed

- Use Biome, TypeScript, and Vitest for local and CI checks. The package smoke test installs the tarball in a clean directory and loads the extension with Pi 1.6.1.
- CI checks pull requests and `main` but no longer publishes automatically to npm.
- Reuse session lookup tables and early-update queues without changing their limits, eviction order, or replay results.
- On Windows, give the agent a chance to exit when its input closes before forcing termination. Refuse device paths in the Windows device namespace before opening them.

## 0.1.0 (2026-11-26)

NEW FEATURES:

- A native Pi extension that runs Google's Antigravity agent over ACP, as Zed does. Pi is the ACP client, and `agy acp` or the agent Zed installs from the ACP registry is the agent. Pi sends the agent your message and nothing of its own system prompt or tools.
- An `antigravity` provider. `antigravity/default` uses the agent's current model, and after the first reply `/model` lists the agent's own models with the thinking levels each one has. The list is cached in `antigravity/catalog.json` under Pi's agent directory, so later runs can start on a model directly.
- The agent's tool calls show as Pi tool rows through the `antigravity_tool` tool: `read`, `edit` with changed line counts, and `$` with a command's output up to 20,000 characters.
- The agent's permission requests use a Pi dialog with the agent's own choices, and Esc picks its reject choice. Without a UI, as in `pi -p`, requests are declined.
- The agent's structured questions are asked field by field with Pi's dialogs, and an optional choice can be left with No answer.
- The agent's plans show above the editor, and Pi's footer shows the agent's context use and permission mode.
- `/agy status`, `/agy mode [id]`, `/agy sessions`, `/agy login`, `/agy logout` and `/agy <command> [input]`, which runs the agent's own commands, such as `/agy compact`, without clashing with Pi's.
- Reopening a Pi session with `pi -c`, `/resume`, a restart or `/reload` reopens the same agent conversation with ACP's `session/load`, and nothing is resent. When the agent cannot continue it, Pi starts a new agent session and sends the visible conversation, up to its last 24,000 characters, as context.
- `/agy sessions` opens one of the agent's saved conversations for this directory as a new Pi session that continues it.
- When the agent reports that you are signed out, Pi offers the agent's own sign-in methods and asks the agent to sign in with the one you pick. The extension never reads a token.
- The flags `--agy-agent` (`auto`, `cli` or `registry`), `--agy-mode`, `--agy-dir` and `--agy-mcp`. `--agy-mcp` is opt-in and passes Pi's MCP servers to the agent, skipping with a notice any server it cannot pass.
- Pi restricts ACP file writes to the session's working directory and the `--agy-dir` directories. ACP reads can use any absolute path. Pi rejects special files and refuses writes through a symlink or to a file with more than one hard link. Agent terminals run through Pi and stop with the agent.
- npm package named `pi-antigravity-acp`.

ADDED:

- [PARITY.md](PARITY.md) compares each Antigravity ACP capability with Zed's client: 22 verified by a test and a live run, 16 implemented and tested but not yet seen live, and 2 not applicable. [ARCHITECTURE.md](ARCHITECTURE.md) explains the design.
- Vitest tests against a scripted ACP agent, in memory and as a process under Pi. Coverage checks statements, branches, functions, and lines for each file in `src/`.
- A package smoke test that packs the extension, installs it through Pi, and exercises a conversation and session continuation with a scripted agent.
- A benchmark that compares the extension with the bare ACP SDK.
- Live checks in `tests/live-acp.py` and `tests/live-probe.py`, which drive real Pi against a signed-in `agy` or the registry agent. They passed on macOS with Pi 1.6.1, `agy` 1.5.17 and the registry agent 1.5.2.
- GitHub Actions checks formatting, lint, types, tests, coverage, package installation, and repository history for secrets. At the time of this release, a separate workflow published new versions to npm.
