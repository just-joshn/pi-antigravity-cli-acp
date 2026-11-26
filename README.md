# pi-antigravity-acp

Talk to Google's Antigravity helper from inside Pi.

## What is this?

Pi is a program. You type to an AI in it, and the AI writes back.

Antigravity is an AI helper made by Google. It can read your files, change them and run commands.

This package connects the two. You chat in Pi. Antigravity does the thinking and the work. Pi shows you what Antigravity does, and asks you first before Antigravity does something risky.

The two programs talk using a shared language called [ACP](https://agentclientprotocol.com/). The Zed code editor uses the same language to talk to Antigravity. So Antigravity in Pi works the way it does in Zed.

## How the pieces fit

1. You type a message in Pi.
2. Pi sends your message to Antigravity.
3. Antigravity thinks, reads files and runs tools.
4. Pi shows you each step and the answer.

Pi sends only your message. It does not send its own instructions or its own tools. If you ask the helper what program it runs in, it says "Antigravity".

Do you want to know how it works inside? Read [ARCHITECTURE.md](ARCHITECTURE.md). Do you want to see what works and how it was checked? Read [PARITY.md](PARITY.md).

## What you need

- Pi, version 1.6 or newer.
- Node.js, version 22.19 or newer.
- Antigravity. You can get it one of two ways.
  - The Antigravity command-line program, called `agy`.
  - The Antigravity helper that Zed installs for you.

## Set it up

The package is not on npm yet. You install it from a copy of this repository.

1. Get a copy of the code.

   ```sh
   git clone https://github.com/just-joshn/pi-antigravity-cli-acp.git
   cd pi-antigravity-cli-acp
   ```

2. Get the parts the code needs.

   ```sh
   bun install
   ```

3. Add the package to Pi.

   ```sh
   pi install "$PWD"
   ```

Pi loads the package from this folder. Keep the folder where it is.

Do you only want to try it once? Run `pi -e ./src/index.ts` instead of step 3.

## Sign in

Antigravity needs your Google account. Antigravity keeps your sign-in, not Pi. This package never reads your password or your token.

1. Open a terminal.
2. Run `agy`.
3. Follow the steps to sign in.

What if you forget? Pi notices when Antigravity says you are signed out. Pi then shows you Antigravity's ways to sign in. For `agy`, these are Google, Gemini Enterprise, a Gemini API key and Agent Platform. Pick one, and Pi asks Antigravity to sign you in.

| To do this                   | Type this     |
| ---------------------------- | ------------- |
| Sign in at any time          | `/agy login`  |
| Sign out. Pi asks you first. | `/agy logout` |

Pi cannot show you a sign-in choice when it has no screen, as in `pi -p`. Then it tells you to run `agy` in a terminal and sign in.

## Start chatting

Run this:

```sh
pi --model antigravity/default
```

Now say hello.

`antigravity/default` uses the model that Antigravity is set to. After the first answer, Pi knows all of Antigravity's models. Type `/model` to see them, for example `gemini-4-hydrogen` and `gemini-3.8-flash`.

Pi remembers that list. Next time, you can start on one model right away.

```sh
pi --model antigravity/gemini-3.8-flash
```

## Things you can do

| I want to…                        | Do this                                                                                |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| Pick a model                      | Type `/model`, press Ctrl+P, or start Pi with `--model antigravity/<model>`.           |
| Make it think harder or less      | Press Shift+Tab, or start Pi with `--thinking <level>`.                                |
| Stop the helper                   | Press Esc.                                                                             |
| See how much the helper remembers | Look at the bottom of Pi's screen. `/agy status` shows the exact numbers.              |
| See the version and my quota      | Type `/agy status`.                                                                    |
| Change how often it asks me       | Type `/agy mode`. Read [Modes](#modes) below.                                          |
| Use one of Antigravity's commands | Type `/agy` and the command, for example `/agy compact`. Press Tab to finish the word. |
| Open an old Antigravity chat      | Type `/agy sessions`, then pick a chat.                                                |
| See more of a tool step           | Press Ctrl+O.                                                                          |

Thinking levels need a real model. `antigravity/default` has none. Pick one of Antigravity's models first. Pi shows only the levels that model has.

## Watching the helper work

Each thing Antigravity does shows up in Pi as a row.

- `read` means it read a file.
- `edit` means it changed a file. The row says how many lines changed.
- `$` means it ran a command. The row shows what the command printed, up to 20,000 characters.

Sometimes Antigravity makes a plan. Then Pi shows the steps above the box where you type. `agy` 1.5.17 does not send plans yet.

Sometimes Antigravity has a question for you. Then Pi asks it one part at a time. You can skip a part that is optional by picking **No answer**. Press Esc to cancel.

## When the helper asks first

Before some steps, Antigravity asks if it may go ahead. Pi shows you the choices, such as **Allow** and **Deny**. Pressing Esc says no.

If nobody is there to answer, as in `pi -p`, the answer is always no.

## Modes

A mode decides how often Antigravity asks you first. The modes belong to Antigravity.

`agy` has four modes. They are `default`, `accept-edits`, `auto` and `plan`. In `default`, it asks before every edit and every command.

- Type `/agy mode` to pick a mode from a list.
- Type `/agy mode auto` to set the mode named `auto`.
- Start Pi with `--agy-mode auto` to begin in that mode.

Pi shows the mode at the bottom of the screen.

Do you want Antigravity to change files while nobody watches, as in `pi -p`? Then start it in a mode that does not ask.

## Antigravity's own commands

Antigravity has its own slash commands and skills. To keep them apart from Pi's commands, you type `/agy` in front of them. For example, `/agy compact` shrinks Antigravity's memory of the chat, and `/compact` is Pi's own command.

A few names are taken by `/agy` itself. These are `status`, `mode`, `sessions`, `login` and `logout`. To run Antigravity's command with one of those names, type it without `/agy`, for example `/status`.

`pi -p` closes before an `/agy` command finishes. There, type Antigravity's command directly, for example `pi -p "/compact"`.

## Coming back to a chat

One Pi chat goes with one Antigravity chat. When you send another message, Pi sends only the new one. Antigravity already remembers the rest.

**You open an old Pi chat again.** This happens with `pi -c`, `/resume`, a restart or `/reload`. Pi asks Antigravity to open the same chat. Nothing is sent twice.

**Antigravity cannot continue that chat.** Maybe it forgot the chat. Maybe the chat went on without Pi. Maybe you talked to another model in Pi first. Then Pi starts a new Antigravity chat and gives it the old messages to read.

**You go back to an earlier point in Pi.** Pi starts a new Antigravity chat and gives it the messages up to that point. Pi closes the old Antigravity chat.

**You type while Antigravity is working.** Pi waits for the running tool rows to finish. Then it stops the rest of Antigravity's turn and sends your new message.

**Something breaks after Antigravity got your message.** For example, the Antigravity program stops. Pi does not send the message again by itself, because Pi cannot know what Antigravity already did. Send it again yourself if you need to.

When Pi gives old messages to a new chat, it sends only the newest 24,000 characters. Each tool result in them is cut to 600 characters.

## Settings

You add these when you start Pi.

| Setting              | What it does                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| `--agy-agent <name>` | Picks which Antigravity to use. Read the next table.                                                   |
| `--agy-mode <mode>`  | Picks the mode for new Antigravity chats.                                                              |
| `--agy-dir <dirs>`   | Lets Antigravity work in more folders. Separate them the way `PATH` does, with `:` on macOS and Linux. |
| `--agy-mcp`          | Gives Antigravity the MCP servers you set up in Pi. Read [MCP servers](#mcp-servers) below.            |

| `--agy-agent` | Which Antigravity                                                              |
| ------------- | ------------------------------------------------------------------------------ |
| `auto`        | `agy` if Pi can find it, otherwise the one Zed installed. This is the default. |
| `cli`         | `agy acp`. Its chats are saved with your other `agy` chats.                    |
| `registry`    | The one Zed installed.                                                         |

The one Zed installed works a little differently.

- It reads and writes files through Pi.
- Its modes are `default`, `auto_edit` and `yolo`.
- It makes a `skills/system/` folder in your project.
- It gives chats no titles, and it has no `/compact`.

You set everything else inside Antigravity. That includes models, quota, MCP servers and rules.

Pi saves Antigravity's list of models, modes and commands in `antigravity/catalog.json` in Pi's agent folder. Then the model list is ready before Antigravity starts. You can delete that file. Pi makes it again.

### MCP servers

An MCP server gives an AI more tools. With `--agy-mcp`, Pi passes its MCP servers to Antigravity. `agy` takes only servers that run as a local program.

Pi skips a server it cannot pass on, and it tells you which one and why. Pi skips a server in these cases.

- It needs an OAuth sign-in, or a value that starts with `!`.
- It uses a `${VAR}` that is not set, or it sets `cwd`.
- It uses SSE.
- Pi does not allow its name, or Pi hides it or its tools.
- It is an HTTP server, and this Antigravity takes no HTTP servers.

If you signed in to an HTTP server with `/mcp`, Antigravity gets that server without your sign-in. Servers that other Pi extensions add are not passed on, because Pi has no way to read them.

## Where it was tested

- Tested by hand on macOS with Pi 1.6.1 and `agy` 1.5.17.
- The one Zed installed, version 1.5.2, was also tested by hand.
- It uses ACP version 1 through `@agentclientprotocol/sdk` 2.12.0.
- The automatic tests also pass on Linux. Nobody has tried it on Linux or Windows with the real Antigravity.

## If something goes wrong

| You see                                                       | What to do                                                                                                  |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| "agy … not found on PATH"                                     | Install the Antigravity command-line program. Or, if Zed installed Antigravity, add `--agy-agent registry`. |
| "Antigravity needs you to sign in"                            | Run `agy` in a terminal and sign in.                                                                        |
| An answer that says "Individual quota reached"                | Your account used up its quota. The message says when it comes back. Another model may still have quota.    |
| `Model "…" not found for provider "antigravity"` at the start | Pi has not seen that model yet. Start once with `antigravity/default`, so Pi learns the model list.         |
| "Antigravity does not offer … right now"                      | Your account cannot use that model now. Pick another one with `/model`.                                     |
| Tool steps show up as messages, not rows                      | `--tools` or `--no-tools` turned off the `antigravity_tool` tool. Pi needs it for the rows.                 |
| "Summaries and other background requests are not available"   | Something in Pi asked these models for a summary. Antigravity keeps its own memory, so Pi says no.          |

## What it cannot do

- **Pi's tools do not run.** Antigravity uses its own tools. Pi's tools, skills, context files and tool hooks do nothing for these models.
- **Pi does not shrink the chat.** Antigravity keeps its own memory. Use `/agy compact` to shrink it.
- **Files stay inside your folders.** When Antigravity writes files through Pi, Pi writes only in your project folder and the folders you gave with `--agy-dir`.
- **Helpers of the helper show up as normal steps.** `agy` 1.5.17 shows the work of its smaller helpers, called subagents, as ordinary tool rows.
- **Old chats come back as text.** `/agy sessions` brings back the words of an old chat, not its tool steps.
- **Google decides the rest.** Quota, which models you can use and your account rules come from Antigravity and Google.

[PARITY.md](PARITY.md) lists every feature, if it works, and how it was checked.

## For people who change the code

These commands check your work.

```sh
bun install --frozen-lockfile
bun run check            # format, lint, type check, and tests that must cover 80% of each file
bun run bench            # how much time this package adds compared with plain ACP
bun run verify:package   # pack it, install it in Pi, chat, restart, continue, and close
bun run pack             # make pi-antigravity-acp-<version>.tgz
```

The tests do not need a Google account. A pretend Antigravity answers them instead.

The live checks use your real Antigravity and your real quota. `live-acp.py` takes about ten minutes. They drive a real Pi through chats, models, thinking levels, files, edits, commands, modes, plans, questions, restarts and more.

```sh
python3 tests/live-acp.py            # uses agy acp. Its chats go to ~/.gemini/antigravity-scratch.
python3 tests/live-acp.py registry   # uses the one Zed installed. Its chats join that one's history.
python3 tests/live-probe.py          # finds out which ACP features agy uses
```

## How checks and new versions work

GitHub runs three jobs for this repository by itself.

| File                  | When it runs                   | What it does                                                                                                   |
| --------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `ci.yml`              | On every pull request          | Checks format, lint and types. Runs the tests and `verify:package` on Node 22.19.0, 24 and 26.                 |
| `release.yml`         | On every push to `main`        | Runs the same checks. Then, if npm does not have this version yet, it publishes it and makes a GitHub release. |
| `verify-lockfile.yml` | On pull requests and on `main` | Checks that `actions.lock` still matches the workflows.                                                        |

The live checks need a signed-in Antigravity, so GitHub only checks that they are valid Python.

To make a new version, follow these steps.

1. Change `version` in `package.json` in a pull request.
2. Merge the pull request.

Do not make the tag or the release by hand. The release job never changes a tag that already exists. It stops if the tag exists but npm does not have the version.

If the release job fails after npm took the version, press **Re-run all jobs**. The job then skips npm and makes the missing tag and release.

npm trusts this repository's `release.yml` and its `npm` environment, so no secret is needed. Only `main` can publish.

`actions.lock` pins each GitHub action to one exact commit. When you add or change a `uses:` line, run `gh actions-lock` and commit the result. Dependabot suggests new action versions once a week.

GitHub formats with Bun 1.4.5. If you format with a newer Bun, change `BUN_VERSION` in `ci.yml` too.
