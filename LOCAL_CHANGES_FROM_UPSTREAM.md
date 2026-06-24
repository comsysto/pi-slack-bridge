# Local changes vs upstream baseline

This document summarizes the changes added on top of the last commit by the original author before the local Slack/msg-bridge work.

## Baseline

- Upstream/original-author baseline commit: `8b0c1da` — `v0.4.0 - lint/changelog`
- Current local commit: `1b11846` — `feat: expand Slack bridge UX, session control, and transport handling`

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
14 files changed, 2194 insertions(+), 90 deletions(-)
```

Changed files:

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
  - working directory
  - first prompt of the session
  - context window usage
- After that, the last assistant message is also forwarded

#### Result
- Easy to see which session is now active in Slack
- Easier to continue without manually reconstructing context

---

### 5. Slack per-session threads

Slack DM communication is now organized into per-session threads.

#### What changed
- Slack transport gained thread-aware sending
- New session / switched session / handover starts a new Slack thread
- Later responses for that session stay inside that thread

#### Result
- Each pi session has its own Slack thread
- Less scrolling in the main DM timeline
- Better separation between independent session contexts

---

### 6. Slack footer/status line on each sent message

Slack responses now carry a small footer in the same Slack message.

#### What changed
- Added a Slack `context` block footer
- Footer includes:
  - context usage, e.g. `66.6% / 400k`
  - model/provider, e.g. `(github-copilot) gpt-5.4`
  - cwd + git branch, e.g. `~/pi-messenger-bridge (master)`

#### Result
- Slack DM always shows current execution context at transport level
- No extra message created; footer lives inside the same Slack message

---

### 7. Slack working indicator via reactions

Instead of posting status messages, Slack now uses reactions on the latest active user message.

#### What changed
- Slack transport gained reaction add/remove helpers
- The bridge adds `:hourglass_flowing_sand:` to the latest active Slack message
- When a newer Slack message arrives during follow-up/steering, the reaction moves to that latest message
- Reaction is cleared on completion, abort, shutdown, or ownership loss

#### Result
- Lightweight "working" indicator without cluttering the thread

---

### 8. Slack file upload support

The bridge can now send local files into the current Slack chat.

#### What changed
- Transport interface and manager were extended for file sending
- Slack transport implements `files.uploadV2`
- Added agent tool: `send_slack_file`
- Added local command: `/msg-bridge sendfile <path>`

#### Result
- Agent or local user can upload diffs, logs, reports, screenshots, etc. directly to Slack

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
- `/msg-bridge new [cwd]` launches a fresh pi session in tmux and runs `/msg-bridge connect`
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

#### Result
- Fast Slack-driven or local switching between previous pi sessions
- Session switching follows the same tmux-backed operational model as bridge session creation

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

### 15. Help/menu/docs updates

Help text and README were extended to reflect the new Slack-heavy workflow.

#### Added/updated command docs
- `/msg-bridge new [cwd]`
- `/msg-bridge list-sessions [number]`
- `/msg-bridge switch <number>`
- `/msg-bridge sendfile <path>`
- `/msg-bridge releaseclaim [transport]`
- remote dot command references

---

## Implementation-oriented file-by-file summary

### `src/index.ts`
Main orchestration changes:
- active-session takeover logic
- Slack thread management
- Slack footer rendering
- working reaction handling
- remote dot commands
- remote stop command
- session listing/new/switch commands
- handover notifications and last-assistant forwarding
- sendfile/releaseclaim command handling

### `src/transports/slack.ts`
Slack transport changes:
- quieter logging
- markdown-block sending
- chunk-aware threaded sending
- file upload support
- file receive/download support
- reaction helpers

### `src/slack-blocks.ts`
New Slack markdown/tokenization/chunking support.

### `src/tmux-connect.ts`
New tmux helper used for bridge session spawning and switching.

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
- session-aware threading
- session switching and spawning
- transport ownership following active use
- more practical Slack UX during handovers and long-running work

This is the main local feature delta added after the original-author baseline commit.
