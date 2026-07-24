# Claude Code Sessions

A Raycast extension to browse, search, and manage your local Claude Code sessions: the ones you started from the terminal, from Claude Desktop, or from Conductor.

Not affiliated with Anthropic. This is a personal, unofficial extension.

## What it does

It finds every Claude Code session on your machine and shows them in one list, no matter where you started them:

- **CLI**: sessions you ran with `claude` in a terminal
- **Claude Desktop**: sessions opened or imported into the desktop app
- **Conductor**: sessions running inside a Conductor workspace

The extension figures out which surface each session lives on by itself. You don't need to tell it anything. It reads what's already on disk (your `~/.claude/projects` transcripts, Claude Desktop's own session records, and Conductor's local database) and puts it all together.

## Features

- Lists your sessions, newest first, grouped by project (or by date if you switch the grouping with ⌘G).
- Searches by title, slug, git branch, or project name.
- Filters by project with a dropdown, and by status (Active / All / Archived) with ⌘⇧A. The status filter mirrors what Claude Desktop's own sidebar shows as "active", including hiding scheduled-task runs like daily planner sessions.
- Shows a detail panel (⌘D) with the first prompt, the last few messages, and metadata like branch, worktree, message count, size on disk, and how full the context window is (e.g. `47% · 94k / 200k`, read straight from the session's latest turn).
- Renames a session (just a local label, it doesn't touch your transcript) and deletes one (moves the file to Trash, never a permanent delete).
- Copies a resume command (`cd <dir> && claude --resume <id>`) so you can jump back into a session from your terminal.
- Colors each project's icon so you can tell projects apart at a glance, and tags each row with where the session lives (Claude, Conductor, or CLI).

## Usage command

There's a second command, **Usage**, that adds up token usage and estimated cost from your transcripts:

- Overview by period: last 5 hours, today, last 7 days, last 30 days, and all time.
- Breakdown by model and by project (all time).
- A breakdown panel (⌘D) per row with input / output / cache-write / cache-read tokens and the estimated cost.

Cost is an estimate from list prices, not a bill. When a model has no price in the table (a brand-new model, say), its tokens still count but its cost shows as `n/a`, and any total that includes it is marked with `≥` to show it's a floor.

This is not the same as the "usage limits" popover in Claude Code (the 5-hour and weekly limits). Those numbers aren't stored anywhere on disk, they come live from the server, so this command can't show them. What it shows is your own consumption, computed locally.

## How it works

Everything runs locally, straight from files already on your Mac:

- It reads `~/.claude/projects/**/*.jsonl`. For the list it only needs the head and tail of each file (title, metadata, last few messages); the Usage command streams the whole file to add up tokens. Either way it reads in fixed-size chunks and never holds a whole file, or even a whole line, in memory. Some transcripts get huge (50MB+, with single lines many MB wide), so this keeps memory flat no matter how big they get.
- It reads Claude Desktop's session records (`~/Library/Application Support/Claude/claude-code-sessions`) to know if a session was also opened in the desktop app, and whether it's archived there.
- It reads Conductor's local sqlite database (read-only) to know about Conductor workspaces and their session titles.
- Everything is read-only except renaming (stored in Raycast's own local storage) and deleting (which moves the file to Trash, so you can still recover it).

It doesn't need an API key and it doesn't make network calls. The `claude://` and `conductor://` links it can open are handled locally by those apps.

## Install

This isn't on the Raycast Store yet ([the submission](https://github.com/raycast/extensions/pull/29627) is under review), so for now you run it from source:

```bash
git clone git@github.com:luiseugenio/raycast-claude-sessions.git
cd raycast-claude-sessions
npm install
npm run dev
```

`npm run dev` opens the extension in Raycast in dev mode. Press `⌘+Enter` in Raycast (or just start typing "Claude Code Sessions") to try it.

## Keyboard shortcuts

| Action | Shortcut |
| --- | --- |
| Open in Claude Desktop / Conductor | `↵` |
| Toggle detail panel | `⌘D` |
| Group by project / date | `⌘G` |
| Import into Claude Desktop | `⌘⇧I` |
| Open session in Claude Desktop (experimental) | `⌘⇧E` |
| Copy resume command | `⌘⇧C` |
| Rename session | `⌘R` |
| Open project folder | `⌘O` |
| Reveal transcript in Finder | `⌘⇧F` |
| Cycle status filter (Active / All / Archived) | `⌘⇧A` |
| Refresh | `⌘⇧R` |
| Delete session | `⌃X` |

## A few notes

- "Import into Claude Desktop" always works, but if Desktop already tracks that session under a different internal ID, the import can create a second untitled copy there. That's a Claude Desktop quirk, not something this extension can avoid yet. It's also why Enter just focuses Claude Desktop: the default action should never surprise you.
- The "(experimental)" open-session action tries a deep link found by digging into how the desktop app routes URLs. It isn't confirmed to work on every build, so it's opt-in and labeled as such.
