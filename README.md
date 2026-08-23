# AgentTracker

AgentTracker is a VS Code extension for measuring Jira work and the cost of agent-assisted development. It keeps one local JSON file for all tracked issues and stores the Jira API token in VS Code's encrypted secret storage.

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
5. Chat with `@agenttracker` in the Chat view (type `@` in the chat box to find it) for tracked agent work. Default Copilot Chat activity isn't observable by other extensions, so `@agenttracker` proxies your prompt to the selected language model and logs one iteration plus real input/output token counts against whichever tracked issue currently has an active timer. Use "Add note" in the AgentTracker view to capture decisions or blockers manually.

Data is written to VS Code's global storage directory as `tracker.json`. Each issue records Jira metadata, timestamps, work sessions, total time, iteration count, token totals, prompt notes, changed-file placeholders, and blocker placeholders. Issues stay in this file even after they leave "In Progress" so history isn't lost; they simply drop out of the visible list. The rough cost estimate is derived from the `agenttracker.inputTokenPricePerMillion` and `agenttracker.outputTokenPricePerMillion` settings (dollars per 1,000,000 tokens, matching how most model providers publish pricing); both default to 0.

### About automatic tracking

Iteration and token counts are only recorded for prompts sent through `@agenttracker`. This is a deliberate limitation: VS Code doesn't expose an API for one extension to observe another extension's chat activity, so default Copilot Chat's own prompts, responses, and token usage aren't visible to AgentTracker (an earlier attempt at parsing Copilot Chat's internal, undocumented local session transcripts turned out to only apply to a specific internal chat flow, not everyday Copilot Chat use, so it was removed). Token counts from `@agenttracker` come from the language model's own `countTokens`, so they're real figures, not estimates.

## Next extensions

The current foundation is intentionally local and provider-neutral. Natural next additions are automatic Git file/change collection, an agent telemetry adapter, export to CSV, and Jira transition controls.