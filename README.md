# BOBO — The AI-Native Browser

**Your Browser. Your AI Buddy.**

A privacy-first, Chromium-based desktop browser for Windows 10/11, built on Electron.
It aims to be a genuine browser product — not a webpage in a window — with an
integrated AI assistant, intelligent tabs and research tools arriving in later
milestones. No paid AI API and no API key is required to run it.

This repository is also a feature-based scaffold designed to be worked on by
**multiple AI coding agents at once** — OpenCode, Cursor, Codex, Grok, Antigravity,
Claude Code, Copilot — while enforcing hard boundaries on what those agents may do.

---

## Running BOBO

Prerequisites: Node.js 20+ and npm on Windows. Dependencies are installed by the
project owner, never by an agent.

```powershell
Set-Location "E:\github\BOBO — The AI-Native Browser"
npm install          # only if a lockfile exists and you have approved it
npm start            # launches BOBO
```

Other scripts:

| Command | What it does |
|---------|--------------|
| `npm start` | Runs the browser in development mode (`electron .`) |
| `npm test` | Runs the unit checks (plain Node, no dependencies needed) |
| `npm run smoke` | Three hidden-Electron suites: branding (every local page, Arctic Frost colours), tabs (create/switch/cycle/close), and tools (services, screenshot capture, clipboard, notes, reader, search setting, UI). Writes screenshots to `tests/e2e/screenshots/` |
| `npm run package` | Packages the app into an unpacked executable folder |
| `npm run make` | Builds the Windows installer / zip (requires Electron Forge) |

---

## Status

| Milestone | Scope | State |
|-----------|-------|-------|
| **1 — Functional browser** | Launch, address bar, tabs, navigation, new tab page, security | **Delivered (core)** |
| 2 — Browser essentials | Bookmarks, history, downloads, settings, themes, persistence | **In progress** — search, settings and personal-tool storage done; bookmarks/history/downloads planned |
| 3 — AI integration | Assistant sidebar, summarisation, contextual actions | Not started |

Personal Tools (Phase 3) were delivered ahead of the milestone order because they only
needed the settings and storage groundwork. The remaining Milestone 2 work is planned in
[`docs/PHASE-3.5-AUDIT.md`](./docs/PHASE-3.5-AUDIT.md).

### Delivered in the source tree

- Electron project bootstrapped with `main` / `preload` / `renderer` processes.
- `WebContentsView`-based tab engine (no deprecated `BrowserView`, no `<webview>`).
- Address bar that separates URLs from search queries, defaulting to Google
  (DuckDuckGo is available in Settings → Search engine).
- Custom local new-tab page and local navigation-error page.
- Back / forward / reload / stop / home, loading spinner and progress bar.
- Tab create, switch, close (✕ and middle-click), Ctrl+Tab cycling, Ctrl+Shift+T.
- Light and dark themes, collapsible BOBO panel, responsive layout.
- Official BOBO Arctic Frost branding: window/taskbar ICO, header and sidebar
  emblem, new-tab hero emblem, local-page favicons, and palette tokens.
- Hardened security: sandbox, context isolation, sender-validated IPC, scheme
  allow-listing, popups routed into tabs, all web permissions denied.
- Personal Tools built into the chrome: Screenshot (visible tab, preview, copy, save PNG),
  Quick Notes (autosave, page link, search, export) and Page Reader (on-request
  extraction, font controls, copy/save), with enable/pin switches in Settings.
- Search engine choice (Google default, DuckDuckGo alternative) used by the address bar and
  the New Tab page, persisted locally and preserved when tool data is cleared.
- Tool preferences and notes stored as local JSON under the app's `userData` folder, with
  atomic writes and corrupt-file quarantine.

### Verification status

- `npm test` — 105 unit checks pass with no dependencies installed.
- `npm run smoke` — three suites pass with exit 0:
  - **branding** — every BOBO-owned page renders its images at real pixel size and applies
    the Arctic Frost accent in both themes;
  - **tabs** — create, switch, cycle, close and last-tab recovery in the real tab engine;
  - **tools** — tool services, a real screenshot capture, clipboard round-trip, notes
    persistence, reader refusals, the search setting, and the panel UI including reload
    and restart persistence.
- The app has been launched with `npm start`: the window opens on the BOBO
  new-tab page and creates its first tab.
- **Not yet verified:** navigation to live sites and real Google/DuckDuckGo result pages
  (the agent runs offline), and manual-only interactions such as free-form typing into the
  address bar. See `docs/SECURITY-CONFIG.md`.

---

## Architecture

```text
src/
  main/                     # Electron main process (privileged)
    main.js                 # window, IPC boundary, shortcuts, context menu
    tabs.js                 # WebContentsView tab manager
    navigation.js           # URL vs. search policy + local-URL trust boundary (pure)
    search.js               # search-engine catalogue and default (pure)
    security.js             # sender validation, session/WebContents hardening
    tools/                  # screenshot, notes, reader, settings, storage, tool IPC
  preload/
    preload.js              # the ONLY bridge pages get; allow-listed channels
  renderer/
    index.html  styles.css  app.js   # BOBO chrome (tab strip, toolbar, panel)
    tools.js                        # Personal Tools panel + Settings
    newtab.html newtab.js           # local new-tab page
    error.html  error.js            # local navigation-error page
  assets/
    logo/BOBO_Arctic_Frost/         # official pack: PNG sizes, Windows ICO, palette
tests/
  unit/                      # runs with `npm test`, no dependencies
  e2e/                       # runs with `npm run smoke` (hidden Electron window, no network)
```

Design decisions worth knowing:

- **The chrome page draws only the chrome.** The website is a `WebContentsView`
  layered over an empty `#viewport` element; its bounds are measured in the
  renderer and pushed to the main process, so content tracks window, sidebar and
  toolbar changes exactly.
- **Nothing is painted over the content area.** Child views always render above the
  window's own DOM, so app-level controls live in the chrome and the BOBO panel,
  and right-click menus use a native popup window.
- **The main process owns everything.** Tabs, navigation and permissions are
  controlled there; pages get a narrow, allow-listed bridge and every message is
  checked against the sender's URL.

### AI extension point (Milestone 3)

No AI code exists yet and none is needed to run BOBO. The seam is already in place:

1. Add an `ai` channel group to the allow-lists in `src/preload/preload.js`.
2. Handle it in `src/main/main.js` behind the same `assertTrusted` sender check.
3. Put the logic in `src/ai/` and the UI in the BOBO panel (the sidebar's AI card is
   the reserved entry point).

Any future agent action must ask for user confirmation before touching credentials,
private data or anything irreversible — the bridge never exposes raw Node/Electron
APIs to a page, and remote sites are already rejected at the sender check.

---

## TL;DR — the three rules that matter

1. **Stay inside this folder.** Agents never read, write, or execute outside the repo root.
2. **No network.** No internet, no external APIs, no dependency downloads, no telemetry.
3. **Nothing leaves this PC.** No uploading, transmitting, or sharing of any data.

Every agent reads these from one file: **[`AGENTS.md`](./AGENTS.md)**. Enforcement is
layered so it holds even when a hook is unavailable. Full policy: [`docs/SECURITY.md`](./docs/SECURITY.md).

---

## Project structure

```
.
├── AGENTS.md                    # ← SINGLE SOURCE OF TRUTH for all agent rules
├── opencode.json                # OpenCode native permission enforcement (deny/ask)
├── CLAUDE.md                    # thin pointer → AGENTS.md (Claude Code)
├── GEMINI.md                    # thin pointer → AGENTS.md (Gemini CLI / Antigravity)
├── .cursor/rules/security.mdc   # thin pointer → AGENTS.md (Cursor, alwaysApply)
├── .github/copilot-instructions.md  # thin pointer → AGENTS.md (Copilot)
├── .claude/settings.json        # Claude Code PreToolUse hook → agent-guard.ps1
├── .githooks/pre-commit         # git secret/size scan (activate: see below)
├── package.json  forge.config.js  .editorconfig  .gitattributes  .gitignore
│
├── src/
│   ├── main/                     # Electron main process (window, IPC, tabs, security)
│   ├── preload/                  # the allow-listed bridge exposed to pages
│   ├── renderer/                 # BOBO chrome UI, new tab page, error page
│   ├── assets/                   # logo and other static assets
│   ├── app/  features/<feature>/  shared/   # reserved for Milestone 2+ features
├── tests/  unit/  e2e/
├── docs/  SECURITY.md  DEVELOPMENT.md
└── scripts/hooks/agent-guard.ps1   # the protective guard used by agent hooks
```

### Feature-based layout (Milestone 2+)

Browser features that arrive later (bookmarks, history, downloads, settings) live in
`src/features/<name>/` and expose only what they need through a public `index.ts`.
Features never reach into each other's internals. The full convention (rules for
adding a feature, what goes in `shared/`, testing layout) is in
[`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md).

---

## Security policy (summary)

| Boundary | Rule |
|----------|------|
| Filesystem | No read/write/list/execute outside the repo root. |
| Network | No internet, no APIs, no `install`, no `git push`, no web fetch/search. |
| Data | Nothing is uploaded, transmitted, or shared off this machine. |
| Consent | Any violation → **stop and ask the human.** Silence is not consent. |

**Fail-safe behaviour:** if a hook, permission block, or config is missing, disabled, or
bypassed, the rules in `AGENTS.md` still apply and the unsafe action must still be blocked
by the agent asking first. Hooks are defence-in-depth, never the only control.

---

## Agent configuration (cross-agent, no duplication)

`AGENTS.md` is the only file that contains rules. Every other agent-specific file is a
**thin pointer** that says "read AGENTS.md, it wins on conflict" — so there is nothing to
drift out of sync.

| Agent | Config file it reads | What it finds |
|-------|---------------------|---------------|
| OpenCode | `AGENTS.md` + `opencode.json` | rules + native permission deny/ask |
| Cursor | `.cursor/rules/security.mdc` + `AGENTS.md` | pointer rule (always on) + rules |
| Codex | `AGENTS.md` | rules |
| Grok | `AGENTS.md` | rules |
| Antigravity / Gemini CLI | `GEMINI.md` → `AGENTS.md` | pointer + rules |
| Claude Code | `CLAUDE.md` → `AGENTS.md`, `.claude/settings.json` | pointer + PreToolUse hook |
| GitHub Copilot | `.github/copilot-instructions.md` → `AGENTS.md` | pointer + rules |

To onboard another agent: point it at `AGENTS.md`. Do **not** copy rules into a new file.

---

## Hooks & enforcement layers

Each layer is independent and must hold even if another fails:

1. **Behavioural contract** — `AGENTS.md` section 0. Applies even with zero hooks.
2. **OpenCode permission engine** — `opencode.json` denies `external_directory` and all
   network/`install` commands; web fetch/search require approval. This is OpenCode's
   native enforcement, so no plugin is required.
3. **Claude Code hook** — `.claude/settings.json` runs `scripts/hooks/agent-guard.ps1` on
   every file/shell tool call and denies out-of-root paths and network commands.
4. **Git hook** — `.githooks/pre-commit` refuses commits containing secret-shaped content
   or files > 1 MiB.
5. **Cursor** — `security.mdc` is always attached so the pointer is never out of context.

### Activate the git hook

```sh
git config core.hooksPath .githooks
```

---

## Development

See [`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md) for the feature-folder convention, how
to add a feature, and the working agreements agents follow (read-before-edit, smallest
root-cause diff, one runnable check for non-trivial logic).

## Notes

- Responses and code are in **English**.
- Requirement 12 in the original setup request was left blank; nothing was implemented for
  it. Add it here when defined.
