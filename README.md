# Claude Sessions

A Raycast extension to browse, search, and manage your local Claude Code sessions — the ones you started from the terminal, from Claude Desktop, or from Conductor.

Not affiliated with Anthropic. This is a personal, unofficial extension.

## What it does

It finds every Claude Code session on your machine and shows them in one list, no matter where you started them from:

- **CLI** — sessions you ran with `claude` in a terminal
- **Claude Desktop** — sessions opened or imported into the desktop app
- **Conductor** — sessions running inside a Conductor workspace

The extension figures out which surface each session lives on by itself. You don't need to tell it anything — it reads what's already on disk (your `~/.claude/projects` transcripts, Claude Desktop's own session records, and Conductor's local database) and puts it all together.

## Features

- **Lists your sessions**, newest first, grouped by project (or by date, if you switch the grouping — ⌘G).
- **Searches** by title, slug, git branch, or project name.
- **Filters by project** with a dropdown, and by status (Active / All / Archived) with ⌘⇧A — this mirrors what Claude Desktop's own sidebar shows as "active," including hiding scheduled-task runs like daily planner sessions.
- **Shows a detail panel** (⌘D) with the first prompt, the last few messages, and metadata like branch, worktree, message count, and size on disk.
- **Renames** a session (just a local label, doesn't touch your actual transcript) and **deletes** one (moves the file to Trash, never a permanent delete).
- **Copies a resume command** (`cd <dir> && claude --resume <id>`) so you can jump back into a session from your terminal.
- Colors each project's icon so you can tell them apart at a glance, and tags each row with where the session lives (Claude, Conductor, or CLI).

## How it works

Everything runs locally, straight from files already on your Mac:

- Reads `~/.claude/projects/**/*.jsonl` — but only the head and tail of each file, never the whole thing. Some session transcripts get huge (50MB+), so we stream just enough bytes to get the title, metadata, and last few messages.
- Reads Claude Desktop's own session records (`~/Library/Application Support/Claude/claude-code-sessions`) to know if a session was also opened in the desktop app, and whether it's archived there.
- Reads Conductor's local sqlite database (read-only) to know about Conductor workspaces and their session titles.
- Everything is read-only except renaming (stored in Raycast's own local storage) and deleting (moves the file to Trash — you can still recover it).

No API key. No network calls except opening `claude://` or `conductor://` links when you ask it to. 100% local.

## Install

This isn't on the Raycast Store yet, so you'll need to run it from source:

```bash
git clone git@github.com:luiseugenio/raycast-claude-sessions.git
cd raycast-claude-sessions
npm install
npm run dev
```

`npm run dev` opens the extension in Raycast in dev mode. Press `⌘+Enter` in Raycast (or just start typing "Claude Sessions") to try it.

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

- "Import into Claude Desktop" always works, but if Desktop already has a session open under a different internal ID, it can create a second, untitled copy there — that's a Claude Desktop quirk we can't fully avoid yet, not a bug in this extension. Enter just focuses Claude Desktop instead, so it never does anything surprising by default.
- The "(experimental)" open-session action tries a deep link we found by digging into how Claude Desktop's app works. It's not confirmed to always work, so it's opt-in and clearly labeled.
- Screenshots for the Raycast Store still need to be taken with Raycast's own screenshot tool (`⌘⇧⌥+S` while browsing the extension in the Store submission flow) — that's a TODO for whoever submits this, not something we can generate here.
