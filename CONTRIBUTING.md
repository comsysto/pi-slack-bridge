# Contributing to pi-slack-bridge

Thank you for your interest in contributing! 

## Development Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/comsysto/pi-slack-bridge.git
   cd pi-slack-bridge
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Build the project**
   ```bash
   npm run build
   ```

4. **Test locally**
   ```bash
   # Set up your Slack tokens (see README.md for details)
   export PI_SLACK_BOT_TOKEN="xoxb-your-slack-bot-token"
   export PI_SLACK_APP_TOKEN="xapp-your-slack-app-token"
   
   # Option A: Install in pi
   pi install /path/to/pi-slack-bridge
   pi
   /slk-bridge connect
   
   # Option B: Load directly from source (faster for development)
   pi -e src/bridge/index.ts
   /slk-bridge connect
   ```

## Project Structure

```
src/
├── bridge/
│   ├── index.ts              # Main entry point (event handlers, commands)
│   └── commands.ts           # Command definitions and dispatch
├── slack/
│   ├── client.ts             # Slack Socket Mode client connection
│   ├── routing.ts            # Message routing between Slack and pi
│   ├── formatting.ts         # Markdown-to-Block-Kit formatting
│   └── blocks.ts             # Block Kit message builders
├── session/
│   ├── tmux.ts               # tmux-backed session management
│   ├── handlers.ts           # Session switching and handoff logic
│   └── lock.ts               # Single-instance lock guard
├── auth/
│   └── challenge.ts          # Challenge-based user authentication
├── config/
│   └── index.ts              # Config loading and validation
├── types/
│   └── index.ts              # TypeScript interfaces and types
└── ui/
    ├── status-widget.ts      # Terminal status display widget
    └── main-menu.ts          # Interactive configuration menu
```

## Code Style

- Use TypeScript strict mode
- Follow existing naming conventions
- Add JSDoc comments for public APIs
- Keep functions focused and testable

## Testing

Run the test suite:

```bash
npm run test
```

Manual testing checklist:
- [ ] Bridge connects successfully via Socket Mode
- [ ] Challenge codes appear in terminal when new user messages
- [ ] Authentication works (correct code)
- [ ] Authentication fails properly (wrong code, too many attempts, expiry)
- [ ] Messages are sent and received correctly
- [ ] Slack Block Kit markdown formatting renders properly
- [ ] File uploads and downloads work
- [ ] Session management works (new, list-sessions, switch)
- [ ] Opt in/out of bridge takeover works
- [ ] Widget displays correct status
- [ ] Deterministic dot commands work (`.bridge`)

## Pull Request Process

1. **Fork** the repository
2. **Create a branch** for your feature (`git checkout -b feature/amazing-feature`)
3. **Make your changes** and commit (`git commit -m 'Add amazing feature'`)
4. **Push** to your fork (`git push origin feature/amazing-feature`)
5. **Open a Pull Request** with:
   - Clear description of changes
   - Why the change is needed
   - Any breaking changes
   - Testing performed

## Commit Messages

Follow conventional commits:

- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation changes
- `refactor:` Code refactoring
- `test:` Adding tests
- `chore:` Maintenance tasks

Examples:
```
feat: add file upload support from Slack
fix: handle empty message blocks in formatting
docs: update README with new session commands
```

## Reporting Issues

When reporting bugs, include:

- pi version (`pi --version`)
- Extension version (see `package.json`)
- Operating system
- Steps to reproduce
- Expected vs actual behavior
- Error messages (if any)

## Feature Requests

Open an issue with:

- Clear use case
- Why it's valuable
- Proposed implementation (if you have ideas)

## Questions?

Open a discussion or issue. We're here to help!

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
