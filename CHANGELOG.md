# Changelog

## [Unreleased]

### Added
- **Terminal-to-Slack handover** — `/slk-bridge handover` pushes the active terminal session into Slack and continues the conversation there
- **Connect/handover test coverage** — added tests for `connect` and `handover` flows
- **Behavioral test harness** — `tests/helpers/bridge-harness.ts` drives the bridge lifecycle via captured `pi.on` handlers and asserts on what is actually pushed to Slack; covers FLOW-002 (handover) and FLOW-003 (continuation) in `tests/bridge/`

### Changed
- **Single trusted user routing** — notification delivery and handover targeting now use one remembered trusted Slack user/DM instead of arrays of notification chat IDs
- **Session takeover flow** — connecting from another session now performs a cleaner handover of the active Slack connection
- **Resume semantics** — `list-sessions`/`switch` replaced by `resume`; `.bridge resume` lists recent 10, `.bridge resume list [number]` lists more, and `.bridge resume <number>` resumes a session (same global-index behavior as the old `switch`)

### Fixed
- **Handover robustness** — improved behavior around takeover/connect sequencing and session ownership transitions
- **Handover final-message duplication** — a busy handover (`/slk-bridge handover` during an agent loop) no longer posts the final assistant message twice: `getConversationHistory` already includes it, so the separate final-response send is skipped when it equals the last pushed message
- **Busy handover blocks next message** — `agent_end` no longer awaits the whole sequential history push; the replay is backgrounded (header awaited so the thread is remembered immediately), so pi can process the next Slack message without waiting for dozens of Slack API calls. The background closure captures `chatId` locally so it survives `handoverPending` being nulled
- **Slow startup** — `session_start` no longer blocks pi readiness on the Slack connection: auto-connect now runs as a background task (lock is still acquired synchronously), and `SlackClient.connect()` fails fast after a 10s timeout instead of hanging on an unreachable Slack (the underlying socket-mode client retries `apps.connections.open` with exponential backoff)

## [0.2.0] - 2026-07-16

### Added
- **Session replay module** — extracted reusable replay logic into `src/session/replay.ts`; `.bridge replay` command replays full conversation history into Slack thread
- **Toggle Tool Calls** — `/slk-bridge toggletools` and `.bridge toggletools` to hide/show tool call summaries in remote messages; replaces the old Widget toggle in the main menu
- **Toggle Auto Connect** — `/slk-bridge autoconnect` subcommand and menu option to disable automatic bridge takeover on session switch
- **Message count in session list** — `.bridge list-sessions` and `/slk-bridge list-sessions` now show message count per session

### Changed
- **Single trusted user** — `trustedUsers[]` array replaced by single `trustedUser` string; `adminUserId` removed; claim system simplified to one trusted user at a time
- **Main menu** — Widget toggle replaced by Toggle Tool Calls; added Toggle Auto Connect, Opt out, Opt in, and Help options
- **Remote command list** — `.bridge toggletools` listed in available commands
- **Trusted user display** — now shows Slack display name instead of raw user ID in status, `/trusted`, `/revoke`, and menu

### Fixed
- **Menu configure flow** — no longer leaves bridge `slackClient` null after configuration
- **`.bridge replay`** — no longer sends a header message count — just replays the messages
- **Challenge prompt wording** — rephrased from "provided by the bot admin" to "provided in your active Pi terminal session" so users know where to look for the 6-digit code
- **Unused imports** — cleaned across all source files; redundant switch cases removed

## [0.1.0] - 2026-07-14

### Added
- **Pure Slack fork** — removed all non-Slack transports (Telegram, WhatsApp, Discord, Matrix) and their interface/manager abstractions
- **Slack Block Kit formatting** — `src/slack/blocks.ts` converts markdown to Slack's native markdown blocks with smart splitting that keeps tables, code blocks, and lists intact
- **tmux-backed session management** — `src/session/tmux.ts` spawns new pi sessions; `list-sessions`/`switch` commands navigate recent sessions; each session gets its own Slack thread
- **Thread-to-session routing** — `src/slack/routing.ts` persists thread↔session mapping in config so continuing a Slack thread resumes the right session
- **Bridge takeover with opt-out** — sessions can opt in/out of automatic bridge takeover; force-acquire mechanism for manual override
- **Claim management** — after first auth, new DM claims stay closed until `/slk-bridge releaseclaim` is called; user chats remembered for notification routing
- **Turn response accumulation** — messages accumulate during a turn and flush at `agent_end`, avoiding fragmented Slack messages
- **Session handoff with replay** — handoff files in `~/.pi/slk-bridge-handoffs/`, background replay that doesn't block pi input, full conversation history on handover
- **Status footer** — simplified bridge status shown in pi's footer line via `setStatus` instead of a widget block
- **Dot commands** — `.bridge` remote commands for skills, prompt templates, and native bridge commands
- **File upload/download** — Slack files saved to `~/.pi/slk-bridge-downloads/slack/`, file uploads from bridge to Slack
- **New commands**: `/slk-bridge new [path]`, `/slk-bridge list-sessions [number]`, `/slk-bridge switch <number>`, `/slk-bridge optout`, `/slk-bridge optin`, `/slk-bridge releaseclaim`, `/slk-bridge accept-handoff`

### Changed
- **Command namespace**: `/msg-bridge` → `/slk-bridge`
- **Config file**: `~/.pi/msg-bridge.json` → `~/.pi/slk-bridge.json`
- **Environment variables**: `MSG_BRIDGE_DEBUG` → `SLK_BRIDGE_DEBUG`
- **Project structure**: flat multi-transport layout → DDD structure (`bridge/`, `slack/`, `session/`, `auth/`, `config/`, `types/`, `ui/`)
- **Auth**: simplified from transport-scoped claim maps to a single `claimOpen` boolean; user IDs no longer namespaced
- **Lock guard**: moved to `src/session/lock.ts` with force-acquire and ownership timer
- **Status widget**: simplified from widget block to footer line via `setStatus`
- **Config persistence**: added `slackRouting` state (thread mappings, delivery tracking)

### Removed
- All non-Slack transports (Telegram, WhatsApp, Discord, Matrix) and their interface/manager abstractions
- `src/formatting.ts`, `src/lock.ts`, `src/types.ts`, `src/index.ts` — replaced by Slack-specific equivalents
- `transport` abstraction layer — all transport parameters, branching checks, and namespacing removed
- 12000-char pre-split optimization — `sendMessageInThread` handles splitting natively
- Legacy `msg-bridge` fallback paths and dead code

### Fixed
- `slk-bridge` command registration (was still `msg-bridge` in source after rename)
- Session handover replay now fires as background task to unblock pi input processing
- Context window token formatting consistent with pi TUI footer
- Remaining `msg-bridge` references renamed across all source files

[unreleased]: https://github.com/comsysto/pi-slack-bridge/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/comsysto/pi-slack-bridge/releases/tag/v0.2.0
[0.1.0]: https://github.com/comsysto/pi-slack-bridge/releases/tag/v0.1.0
