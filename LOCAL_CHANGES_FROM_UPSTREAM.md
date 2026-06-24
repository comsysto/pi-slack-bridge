# Local changes vs upstream baseline

This document summarizes the changes added on top of the last commit by the original author before the local Slack/msg-bridge work.

## Baseline

- Upstream/original-author baseline commit: `8b0c1da` — `v0.4.0 - lint/changelog`
- Current local commit: `8d0dbab` — `feat: opt-out from bridge takeover, full conversation history on handover, and fix user message extraction`

## Diff command

To reproduce the full diff:

```bash
git diff 8b0c1da..HEAD
```

To see the changed files only:

```bash
git diff --name-status 8b0c1da..HEAD
```

## Diff summary

```text
16 files changed, 3249 insertions(+), 91 deletions(-)
```

Changed files:

- `LOCAL_CHANGES_FROM_UPSTREAM.md` (this file)
- `README.md`
- `src/auth/challenge-auth.ts`
- `src/formatting.ts`
- `src/index.ts`
- `src/lock.ts`
- `src/slack-blocks.ts` (new)
- `src/tmux-connect.ts` (new)
- `src/transports/interface.ts`
- `src/transports/manager.ts`
- `src/transports/slack.ts`
- `src/types.ts`
- `src/ui/main-menu.ts`
- `tests/conversation-history-test.ts` (new)
- `tests/lock.test.ts`
- `tests/slack-blocks.test.ts` (new)

---

## Major feature additions

### 1. Slack-native formatting and chunking

Added Slack-focused rendering instead of sending plain text only.

#### What changed
- Added `src/slack-blocks.ts`
- Slack messages are now converted into Slack markdown blocks
- Large Slack messages are split more safely and more naturally
- Message splitting became content-aware in `src/formatting.ts`

#### Result
- Better rendering for headings, code blocks, lists, tables, etc.
- Fewer ugly splits in the middle of structured content
- Slack gets a larger effective chunk size than the generic 4k path

---

### 2. Forced session takeover for msg-bridge

The bridge connection is no longer tied to the first process forever.

#### What changed
- `src/lock.ts` was extended with force-acquire behavior
- `src/index.ts` now allows ownership to move between sessions
- Previous owner detects ownership loss and disconnects

#### Result
- The latest active session can take over msg-bridge
- Old session keeps running, but loses bridge ownership
- No need to kill the old pi session

---

### 3. Active desktop session owns the bridge

Ownership now follows the session the local user last interacted with.

#### What changed
- Local `input` activity triggers bridge ownership refresh
- The active session reconnects transports if necessary

#### Result
- The session you are actually using on desktop becomes the bridge owner
- Slack traffic stays attached to the actively used local pi session

---

### 4. Slack session handover notifications

When ownership moves to a different session, Slack receives an explicit handover message.

#### What changed
- On session handover, Slack gets a message containing:
  - working directory + first prompt
  - context window usage + model/provider
  - handover reason ("Switched by user request" vs "Bridge moved to the active local session")
- After that, the **full conversation history** (user + assistant interleaved) is replayed into the Slack thread

#### Result
- Easy to see which session is now active in Slack
- Easier to continue without manually reconstructing context
- Full conversation history ensures continuity, not just the last message

---

### 5. Slack per-session threads with persistent routing

Slack DM communication is now organized into per-session threads, with persistent routing that survives restarts.

#### What changed
- Slack transport gained thread-aware sending
- New session / switched session / handover starts a new Slack thread
- Later responses for that session stay inside that thread
- Thread-to-session mapping is stored persistently in `slackRouting` config (`threadsByKey`, `activeThreadBySessionChat`)
- On restart, the mapping is restored from config, so threads remain associated with the correct session
- Replies in an existing Slack thread are automatically routed to the correct pi session (even if a different session currently owns the bridge)

#### Result
- Each pi session has its own Slack thread
- Less scrolling in the main DM timeline
- Thread-to-session routing survives pi restarts
- Replying in an existing thread routes the message to the correct session, not just the current bridge owner

---

### 6. Slack footer/status line on last message only

Slack responses now carry a small footer, but only on the final message in a batch.

#### What changed
- Added a Slack `context` block footer
- Added `noFooter` option to `sendToRemoteChat()`
- Footer includes:
  - context usage, e.g. `66.6% / 400k`
  - model/provider, e.g. `(github-copilot) gpt-5.4`
  - cwd + git branch + first prompt snippet, e.g. `~/pi-messenger-bridge (master) · fix bug`
- At flush time (`agent_end`), only the last entry in the accumulated batch gets the footer; intermediate messages omit it

#### Result
- Slack DM shows current execution context at transport level
- No extra message created; footer lives inside the same Slack message
- Footer clutter reduced — intermediate turn messages are cleaner without repeating context info

---

### 7. Turn accumulation and agent_end flush

Instead of sending each turn's response to Slack immediately, the bridge now accumulates them and flushes at the end of the agent loop.

#### What changed
- Added `turnAccumulator` state — a buffer that stores each turn's response text as a separate entry
- `turn_end` handler now **appends** to the accumulator instead of sending to Slack
- Added `agent_end` handler — fires once when the entire agent loop finishes, flushes all accumulated entries as individual Slack messages back-to-back
- `pendingRemoteChat` stays alive across all turns until `agent_end`
- Working reaction stays active during accumulation, cleared at flush time
- On ownership loss or session shutdown, accumulator is cleared

#### Result
- Slack no longer receives mid-loop trickle messages during multi-turn agent loops
- All per-turn responses arrive nearly simultaneously after the agent finishes
- Each turn keeps its own message structure (not merged into one)
- The `:hourglass_flowing_sand:` reaction stays on the user's message until the final flush

---

### 8. Slack working indicator via reactions

Instead of posting status messages, Slack now uses reactions on the latest active user message.

#### What changed
- Slack transport gained reaction add/remove helpers
- The bridge adds `:hourglass_flowing_sand:` to the latest active Slack message
- When a newer Slack message arrives during follow-up/steering, the reaction moves to that latest message
- Reaction is cleared on completion, abort, shutdown, or ownership loss

#### Result
- Lightweight "working" indicator without cluttering the thread

---

### 8. Slack file upload support (thread-aware)

The bridge can now send local files into the current Slack chat, respecting the active thread.

#### What changed
- Transport interface and manager were extended for file sending
- Slack transport implements `files.uploadV2` with `thread_ts` support
- Added agent tool: `send_slack_file`
- Added local command: `/msg-bridge sendfile <path>`

#### Result
- Agent or local user can upload diffs, logs, reports, screenshots, etc. directly to Slack
- File uploads appear in the correct Slack thread instead of the main DM

---

### 9. Slack file receiving support

Files sent from Slack to the bot are now downloaded locally and forwarded into pi context deterministically.

#### What changed
- Slack `file_share` messages are no longer ignored
- Files are downloaded locally using the bot token
- Stored under:

```text
~/.pi/msg-bridge-downloads/slack/
```

- Message forwarded to pi includes filename, mimetype, size, local saved path, and optional comment text

#### Result
- Slack DM can now be used to send files into pi workflows
- Agent can read/process local saved artifacts without LLM guessing

---

### 10. Exclusive Slack claim / release behavior

After first successful auth on Slack, unknown users are silently ignored instead of restarting the 6-digit challenge flow.

#### What changed
- Added claim-open state per transport in auth config
- First successful Slack claimant closes further claims
- Unknown later Slack DM users get no challenge and no reply
- Added command:

```text
/msg-bridge releaseclaim [transport]
```

#### Result
- No more repeated challenge spam from other users
- Explicit local release is required before another user can claim the bot

---

### 11. Deterministic remote dot commands

Added a non-LLM command surface for Slack DMs and other transports.

#### Supported remote commands
- `.` — list available remote commands
- `.skill <name> [args]`
- `.prompt <name> [args]`
- `.bridge status`
- `.bridge connect`
- `.bridge disconnect`
- `.bridge new [cwd]`
- `.bridge list-sessions [number]`
- `.bridge switch <number>`
- `.bridge sendfile <path>`
- `stop` (Slack-only abort command)

#### Result
- Deterministic command discovery and invocation without going through the LLM
- Safer and more predictable remote control plane for Slack DMs

---

### 12. Remote stop command

Slack can now abort the current generation deterministically.

#### What changed
- If the user sends exactly `stop` in Slack:
  - bridge intercepts it before LLM handling
  - calls `ctx.abort()`
  - clears working reaction
  - replies with stop confirmation

#### Result
- Remote equivalent of pressing `Esc` in pi terminal

---

### 13. tmux-backed session creation and switching

Bridge session creation and switching now use a dedicated tmux + pi launch path.

#### What changed
- Added `src/tmux-connect.ts`
- `/msg-bridge new [cwd]` launches a fresh pi session in tmux and runs `/msg-bridge connect user-request`
- `/msg-bridge switch <number>` launches a tmux pi session with:

```bash
pi --session <session.jsonl>
```

- Session listing uses pi session metadata from `SessionManager.listAll()`
- Recent session rendering includes:
  - absolute cwd
  - first prompt
- Added local and remote listing/switching commands:
  - `/msg-bridge list-sessions [number]`
  - `/msg-bridge switch <number>`
  - `.bridge list-sessions [number]`
  - `.bridge switch <number>`
- tmux-connect gained `attachClient` and `cleanupOtherSessions` flags for flexible spawning (used by handoff to spawn without switching client or cleaning up)

#### Result
- Fast Slack-driven or local switching between previous pi sessions
- Session switching follows the same tmux-backed operational model as bridge session creation
- Silent session handoff can spawn sessions without disrupting the user's active tmux client

---

### 14. msg-bridge tmux session isolation and cleanup

Bridge-created tmux sessions are now isolated by name and only those are cleaned up.

#### What changed
- Bridge-created tmux sessions now use prefix:

```text
pi-slack-...
```

- Cleanup only targets other `pi-slack-*` sessions
- Unrelated tmux sessions are left untouched

#### Result
- Prevents zombie bridge tmux sessions
- Avoids killing unrelated long-lived tmux work

---

### 15. Opt-out from automatic bridge takeover

Sessions can now opt out of automatic bridge takeover when they become active.

#### What changed
- Added `/msg-bridge optout` — adds the current session to `optedOutSessions` in config
- Added `/msg-bridge optin` — removes the current session from `optedOutSessions`
- Added `/msg-bridge optout list` — shows all opted-out sessions
- `onInput` activity handler checks `optedOutSessions` before taking over
- Config stores the array persistently

#### Result
- You can keep a session running without it stealing bridge ownership when you type in it
- Useful for long-running background tasks that shouldn't interrupt Slack

---

### 16. Automatic Slack thread-to-session routing (handoff)

When a reply comes in on a Slack thread owned by a different pi session, the message is silently handed off to that session.

#### What changed
- `maybeRouteSlackMessageToMappedSession` checks if an incoming Slack reply belongs to a known thread mapped to a different session
- If so, a handoff file is written to `~/.pi/msg-bridge-handoffs/`
- A tmux pi session is spawned with `pi --session <target>` and `/msg-bridge accept-handoff <file>`
- The target session receives the message with full conversation history replay
- New `/msg-bridge accept-handoff` command processes the handoff file deterministically

#### Result
- Replying in a Slack thread routes the message to the correct pi session
- No manual session switching needed for thread continuity

---

### 17. Full conversation history on handover

Instead of sending only the last assistant message on handover, the full interleaved conversation is now replayed.

#### What changed
- Added `getConversationHistory()` — extracts all user and assistant messages in order from the branch
- Added `replayAllAssistantMessagesToSlackThread()` — sends the full history to Slack when resuming a thread
- Tracks `lastAssistantDeliveryByThread` to avoid duplicate delivery
- Used in handover notifications, thread routing handoffs, and `accept-handoff`

#### Result
- When a session takes over or a thread is resumed, Slack sees the complete conversation history
- No need to scroll up or manually reconstruct context

---

### 18. `handoverReason` tracking

The bridge now distinguishes between user-requested and automatic session handovers.

#### What changed
- `connectCurrentSession` accepts `handoverReason: "user-request" | "active-session"`
- Reason is passed through to Slack notification messages
- `/msg-bridge connect` accepts an optional reason argument
- tmux-launched sessions use `bridgeCommand: "/msg-bridge connect user-request"`

#### Result
- Slack notifications clearly show whether the handover was triggered by the user or by active-session tracking
- Better debugging of unexpected bridge ownership changes

---

### 19. `threadId` / `isThreadReply` in message types

ExternalMessage and PendingRemoteChat now carry thread context.

#### What changed
- `ExternalMessage.threadId` — transport-specific reply thread/root identifier
- `ExternalMessage.isThreadReply` — whether the message was sent as a reply inside a thread
- `PendingRemoteChat.threadId` / `isThreadReply` — forwarded for use in response routing
- Slack transport captures `message.thread_ts` and passes it through

#### Result
- Downstream handlers can make routing decisions based on thread context
- Enables automatic thread-to-session routing

---

### 20. Conversation history test

Added a test for the interleaved user/assistant conversation extraction logic.

#### What changed
- New `tests/conversation-history-test.ts`
- Tests `getConversationHistory()` with simulated branch entries
- Covers string content, array content, stopReason filtering, empty entries

#### Result
- Core handover logic has test coverage

---

### 21. Help/menu/docs updates

Help text and README were extended to reflect the new Slack-heavy workflow.

#### Added/updated command docs
- `/msg-bridge new [cwd]`
- `/msg-bridge list-sessions [number]`
- `/msg-bridge switch <number>`
- `/msg-bridge sendfile <path>`
- `/msg-bridge releaseclaim [transport]`
- `/msg-bridge optout`
- `/msg-bridge optin`
- `/msg-bridge optout list`
- remote dot command references
- `optedOutSessions` config example

---

## Implementation-oriented file-by-file summary

### `src/index.ts`
Main orchestration changes:
- active-session takeover logic
- Slack thread management (in-memory + persistent config-based routing)
- Slack footer rendering (with `noFooter` option for batch-aware footers)
- working reaction handling
- remote dot commands
- remote stop command
- session listing/new/switch commands
- handover notifications with full conversation history replay
- sendfile/releaseclaim command handling
- `handleIncomingRemoteMessage()` — centralized message handling with routing, history replay, and command processing
- `maybeRouteSlackMessageToMappedSession()` — automatic thread-to-session routing
- `replayAllAssistantMessagesToSlackThread()` — full conversation history replay
- `handoffSlackThreadToSession()` — tmux-based handoff to the owning session
- `getConversationHistory()` — interleaved user/assistant extraction
- `optedOutSessions` — opt-out from automatic takeover
- `/msg-bridge optout` / `/msg-bridge optin` / `/msg-bridge optout list` commands
- `/msg-bridge accept-handoff` command
- `handoverReason` tracking (`/msg-bridge connect user-request` / `active-session`)
- `turnAccumulator` — per-turn accumulation buffer
- `turn_end` handler — appends to accumulator instead of sending to Slack
- `agent_end` handler — flushes accumulated entries as separate Slack messages, footer only on last entry

### `src/transports/slack.ts`
Slack transport changes:
- quieter logging
- markdown-block sending
- chunk-aware threaded sending
- file upload support (with `thread_ts` for thread-aware uploads)
- file receive/download support
- reaction helpers
- `threadId` and `isThreadReply` passed through on incoming messages

### `src/slack-blocks.ts`
New Slack markdown/tokenization/chunking support.

### `src/tmux-connect.ts`
New tmux helper used for bridge session spawning and switching.
- Added `attachClient` option (default true) — set false for silent handoff spawning
- Added `cleanupOtherSessions` option (default true) — set false for handoff to avoid cleaning unrelated sessions

### `src/auth/challenge-auth.ts`
Auth/claim logic changes:
- DM chat tracking
- transport claim state
- releaseclaim behavior
- silent ignore after first claimant

### `src/lock.ts`
Forced bridge ownership transfer support.

### `src/formatting.ts`
Content-aware message splitting.

### `src/transports/interface.ts` / `src/transports/manager.ts`
Support for transport-level file sending.
- Added `threadId` to `TransportFileOptions` for thread-aware uploads

### `src/types.ts`
- Added `threadId` / `isThreadReply` to `ExternalMessage` and `PendingRemoteChat`
- Added `slackRouting` config type (threadsByKey, activeThreadBySessionChat, lastAssistantDeliveryByThread)
- Added `optedOutSessions` config field

### `tests/conversation-history-test.ts`
New tests for interleaved user/assistant conversation extraction.

### `tests/slack-blocks.test.ts`
New tests for Slack block splitting/rendering.

### `tests/lock.test.ts`
Expanded lock/takeover coverage.

---

## Net effect of the local feature set

Compared to the upstream `8b0c1da` baseline, the software has effectively been extended from a generic multi-messenger bridge into a much more Slack-optimized remote control surface for pi, with:

- better Slack rendering
- deterministic remote command entry points
- file send/receive workflows
- session-aware threading with persistent routing
- session switching and spawning
- transport ownership following active use
- full conversation history on handover
- automatic thread-to-session routing
- opt-out from automatic takeover
- handover reason tracking
- turn accumulation and agent_end flush (no mid-loop trickle)
- batch-aware footers (only on last message)

This is the main local feature delta added after the original-author baseline commit.
