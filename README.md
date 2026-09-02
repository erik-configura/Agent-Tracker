# AgentTracker

AgentTracker is a VS Code extension for measuring Jira work and agent-assisted development usage. It keeps one local JSON file for all tracked issues and stores the Jira API token in VS Code's encrypted secret storage.

## Development

The project requires Node.js and npm. In this folder, install dependencies and compile:

```sh
npm install
npm run compile
```

Press `F5` in VS Code to launch an Extension Development Host. The extension can later be packaged with `npm run package` after installing the `vsce` dependency.

## Use

1. Open the AgentTracker view from the activity bar (or run `AgentTracker: Sign in to Jira` from the Command Palette to focus it).
2. Sign in with the inline form: Jira base URL, optional account email, and API token. For Jira Cloud, enter the account email so the extension can use Basic authentication; leaving the email empty uses a Bearer token for Jira Server/Data Center. The token is never written to the tracker JSON.
3. Once signed in, AgentTracker automatically lists every issue assigned to you with a Jira status in the "In Progress" category — there's no manual add-issue step. The list refreshes on open and whenever you click the refresh button.
4. Start and stop tracking independently for each issue. Multiple issues can remain in the list and retain their own sessions.
5. When you click Stop tracking, AgentTracker attempts to export the current Copilot chat transcript to a temporary file and parse request-level usage fields from the export (`promptTokens`, `completionTokens`, `copilotCredits`). If automatic export is not available, the extension asks you to pick an exported `chat.json` file manually.
6. AgentTracker applies usage as a delta from the session baseline: only requests after the Start marker are counted. For a first-time tracked issue with no baseline yet, AgentTracker treats the baseline as `0`, so the first stop can immediately populate totals from the exported chat.
7. Use "Add note" in the AgentTracker view to capture decisions or blockers manually.

Data is written to VS Code's global storage directory as `tracker.json`. Each issue records Jira metadata, timestamps, work sessions, total time, iteration count, token totals, Copilot credit totals, prompt notes, changed-file placeholders, and blocker placeholders. Issues stay in this file even after they leave "In Progress" so history isn't lost; they simply drop out of the visible list.

### About automatic tracking

Usage updates now run only when Stop tracking is clicked. AgentTracker does not watch log files and does not increment token counters during live chat events.

The extension reads exported chat requests and uses explicit request-level usage fields when present:

- `promptTokens` as input tokens
- `completionTokens` as output tokens
- `copilotCredits` as credits spent
- model from `response[0].metadata.modelId`, then fallback to `result.metadata.resolvedModel`

If `completionTokens` is missing but nested `outputTokens` metadata exists, AgentTracker uses it as a fallback and marks accounting as partial. If explicit usage fields are missing, AgentTracker marks usage as unavailable and does not fabricate totals.

If a newer export contains fewer requests than the stored baseline (for example, a new chat thread), AgentTracker treats that as a reset and restarts delta calculation from `0` for that stop so usage can still be applied.

## Next extensions

The current foundation is intentionally local and provider-neutral. Natural next additions are automatic Git file/change collection, an agent telemetry adapter, export to CSV, and Jira transition controls.