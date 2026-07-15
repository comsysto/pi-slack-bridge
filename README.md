# pi-slack-bridge

![markdown formatting screenshot](media/markdown-formatting-screenshot.png)

A **pi extension** that connects your [Pi agent harness](https://github.com/earendil-works/pi-coding-agent) terminal session to Slack via Socket Mode.

This is a fork of [tintinweb/pi-messenger-bridge](https://github.com/tintinweb/pi-messenger-bridge) which purely focusses on the integration of Slack. It provides opinionated Quality-of-Life features like Markdown formatting via the [Slack Block Kit API](https://docs.slack.dev/reference/block-kit/blocks/markdown-block/), tmux-backed Session Management (create new or switch to former Pi Session) and more.

Summarized featureset:
- Send messages, receive responses with pi from Slack
- Run deterministic remote commands (`/slk-bridge ...` in pi's terminal, `.bridge ...` in Slack DMs)
- Upload/download files between Slack and pi
- Manage multiple pi sessions per Slack thread (each session gets its own thread)
- Switch between sessions, spawn new ones, and hand off seamlessly
- Session message replay - when resuming a session, prior conversation history is replayed into the Slack thread
- Opt sessions in/out of automatic bridge takeover

Currently only one terminal session at a time can be bridged to Slack.




## Setup
### 1. Install

```bash
pi install npm:pi-slack-bridge
```

Or install from local path:

```bash
pi install /path/to/pi-slack-bridge
```

### 2. Configure Slack

Create a Slack app with **Socket Mode** in `Settings > Socket Mode` enabled. You need both tokens:

- **Bot Token** (`xoxb-...`) — in **Settings > Install App**
- **App-Level Token** (`xapp-...`) — create one in **Settings > Basic Information > App-Level Tokens** with the `connections:write` scope

In `Features > App Home` enable `Messages Tab` so you can interface with the App via DMs.

Following Bot Token scopes (in `Features > OAuth & Permissions`) need to be enabled for the Slack Bridge to function fully:

- `chat:write` - for exchanging Messages to/from Pi
- `files:read` - for File sending to Pi
- `files:write` - for File receiving from Pi
- `im:history` - for viewing message history with Slack user
- `im:read` - for saving metadata for session management
- `reactions:write` - to show the User via ⏳ reaction that prompt is processing
- `user:read` - to correctly identify user for authentication

Configure the Slack Bridge via the interactive menu:

```bash
/slk-bridge
# Select "Configure"
# Enter bot token
# Enter app token
```

Or via CLI:

```bash
/slk-bridge configure <bot-token> <app-token>
```

Or set environment variables:

```bash
export PI_SLACK_BOT_TOKEN="xoxb-your-slack-bot-token"
export PI_SLACK_APP_TOKEN="xapp-your-slack-app-token"
```

### 3. Connect

```bash
/slk-bridge connect
```

The bridge automatically connects on next pi launch if `autoConnect` is set in the `~/.pi/slk-bridge.json`.

### 4. Authenticate Users

When a Slack user messages the bot for the first time, they receive a 6-digit challenge code. The code appears in their pi terminal.

The user then enters the code in the bot chat to become a trusted user.

> After the first successful claim, unknown users are silently ignored. To re-open claiming: call `/slk-bridge releaseclaim` in a Pi terminal session

## Main deviations from pi-messenger-bridge

### Slack as first-class transport

- **Change of semantics** - `msg-bridge` -> `slk-bridge` 
- **File Upload and Receive** - send and receive Files over Slack to/from your Pi Agent session
- **Markdown Formatting** - Slack messages are now properly formatted with Markdown Blocks
- **stop** - send `stop` in Slack to abort an agent turn. Inspired by [badlogic/pi-telegram](https://github.com/badlogic/pi-telegram)
- **Reflect pi status in Slack message footer** - each latest message has a Slack footer annotation which reflects the state of your Pi agent (current path, model, context window,...)

### tmux-backed Session Management

The goal is to pick up your Pi session from Slack or from the terminal whenever you want.
For this, `tmux` is used as the backbone to create new Pi sessions, switch to older ones or list previous ones.
Only one `tmux` session can exist at time to function as a container for a newly created or switched-to Pi session.

There are 3 main commands introduced:

- `/slk-bridge new [path]` - kill current Pi session and start a new one inside a tmux session. Include `path` as an optional argument to start the session in a path on your OS
- `/slk-bridge list-sessions [number]` - list the recent 10 sessions of your Pi agent. Include an optional `number` argument to list the last `number` sessions.
- `/slk-bridge switch <number>` - switch to a session denoted by the number in the `list-sessions` command. The old tmux session (if it exists) gets used for switching the Pi terminal session.

Each command is implemented in a deterministic fashion inside the Pi Agent harness so that no LLM call is triggered.
To optout/optin a local terminal session being bridged to Slack, use `/slk-bridge optout` or `/slk-bridge optin` respectively.

Whenever a session is switched, it gets assigned its own new thread in the DM with the Slack App bridged to your Pi agent. A user can also switch to a session by continuing the respective thread in Slack.

### Deterministic Dot Commands

The user can use `.bridge` as a sort-of replacement to trigger some `/` commands to Pi. Currently only supports `skills` and `prompt templates` next to pi-slack-bridge native commands.
To list all available commands, send `.` in Slack.

![dot commands screenshot](media/dot-commands-screenshot.png)

## Security

- Config file: `~/.pi/slk-bridge.json` (chmod 600 — owner read/write only)
- Config directory: `~/.pi/` (chmod 700 — owner only)
- Downloads: `~/.pi/slk-bridge-downloads/slack/`
- Handoffs: `~/.pi/slk-bridge-handoffs/`
- Environment variables take precedence over file config
- Challenge-based authentication (6-digit code, 3 attempts, 2-minute expiry)
- Transport-namespaced user IDs prevent impersonation
- After first successful claim to the Slack app, unknown users are silently ignored until the user manually releases claim via `/slk-bridge releaseclaim`

## Troubleshooting

Enable debug mode to see detailed logs:

```bash
export SLK_BRIDGE_DEBUG=true
```

Or set in config:

```json
{ "debug": true }
```

### Common Issues

- **"Another instance is connected"** — the single-instance guard prevents duplicate Slack connections. Use `/slk-bridge connect` in the active session or force-acquire by typing in the target session.
- **No Slack messages received** — verify Socket Mode is enabled in your Slack app configuration and both tokens are correct.
- **Handoff not working** — ensure tmux is installed and `pi` is in your PATH. Handoff spawns `pi --session <target>` in tmux.

## Development

```bash
git clone https://github.com/comsysto/pi-slack-bridge.git
cd pi-slack-bridge
npm install
npm run build        # compile TypeScript
npm run typecheck    # type-check without emitting
npm run test         # run vitest suite
npm run lint         # biome lint
npm run lint:fix     # biome lint with auto-fix
```

### Load directly from source (faster for development)

```bash
pi -e src/bridge/index.ts
/slk-bridge connect
```

### Test suite

```bash
npm run test
```

Covers config loading, lock acquisition, Slack block splitting, conversation history extraction, and formatting.

## Acknowledgements

First of all, thanks to the tremendously useful Pi project by Earendil.

Thanks to [@tintinweb](https://github.com/tintinweb) for providing the `pi-messenger-bridge` extension this builds upon.
Furthermore thanks to [@badlogic](https://github.com/badlogic) and [@llblab](https://github.com/llblab) for their `pi-telegram-bridge` implementations that inspired some features in this extension like Markdown formatting.

Finally, thanks to [@antirez](https://github.com/antirez) for providing the `ds4` inference engine that enabled substantial development with a local `deepseek-v4-flash`.

## Transparency about coding agent use

This project used the Pi Agent Harness with the `gpt-5.4` model in the beginning to establish the Slack-only focus. Later, new features, refinements and refactors heavily took advantage of a locally hosted `deepseek-v4-flash` via [antirez/ds4](https://github.com/antirez/ds4) on a Macbook Pro M3 Max.

## License

MIT
