import * as vscode from 'vscode';
import { Buffer } from 'buffer';

type AccountingStatus = 'exact' | 'partial' | 'unavailable';

interface WorkSession {
  startedAt: string;
  stoppedAt?: string;
  durationSeconds?: number;
  baselineRequestCount?: number;
  usageAppliedAtStop?: boolean;
}

interface IssueRecord {
  key: string;
  summary: string;
  url?: string;
  status?: string;
  originalEstimateSeconds?: number;
  sessions: WorkSession[];
  totalTimeSeconds: number;
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  copilotCredits: number;
  accountingStatus: AccountingStatus;
  accountingNotes: string[];
  modelUsageBreakdown: Record<string, number>;
  lastProcessedRequestCount?: number;
  promptNotes: string[];
  filesChanged: string[];
  blockers: string[];
  createdAt: string;
  updatedAt: string;
}

interface TrackerData {
  selectedKey?: string;
  issues: Record<string, IssueRecord>;
}

const storageFile = 'tracker.json';
const tokenSecret = 'agenttracker.jiraToken';
const emailSecret = 'agenttracker.jiraEmail';

export function activate(context: vscode.ExtensionContext): void {
  const tracker = new TrackerStore(context);
  const provider = new DashboardProvider(context, tracker);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('agenttracker.dashboard', provider),
    vscode.commands.registerCommand('agenttracker.configureJira', () => vscode.commands.executeCommand('agenttracker.dashboard.focus')),
    vscode.commands.registerCommand('agenttracker.refresh', () => provider.refresh()),
    createChatParticipant(context, tracker)
  );
}

function createChatParticipant(context: vscode.ExtensionContext, tracker: TrackerStore): vscode.ChatParticipant {
  const handler: vscode.ChatRequestHandler = async (request, _chatContext, stream, token) => {
    await tracker.ready();
    const activeKey = tracker.activeIssueKey();
    if (!activeKey) {
      stream.markdown('_No AgentTracker issue has an active timer. Start tracking a Jira issue in the AgentTracker view before using @agenttracker._');
      return;
    }

    try {
      const response = await request.model.sendRequest([vscode.LanguageModelChatMessage.User(request.prompt)], {}, token);
      for await (const fragment of response.text) {
        stream.markdown(fragment);
      }
    } catch (error) {
      stream.markdown(`Request failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  };

  const participant = vscode.chat.createChatParticipant('agenttracker.assistant', handler);
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'activity.svg');
  return participant;
}

class TrackerStore {
  private data: TrackerData = { issues: {} };
  private readonly file: vscode.Uri;
  private loaded: Promise<void>;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.file = vscode.Uri.joinPath(context.globalStorageUri, storageFile);
    this.loaded = this.load();
  }

  async ready(): Promise<void> { await this.loaded; }

  async load(): Promise<void> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.file);
      this.data = JSON.parse(new TextDecoder().decode(bytes)) as TrackerData;
      this.normalizeData();
    } catch { this.data = { issues: {} }; }
  }

  get snapshot(): TrackerData { return structuredClone(this.data); }

  async save(): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
    await vscode.workspace.fs.writeFile(this.file, new TextEncoder().encode(JSON.stringify(this.data, null, 2)));
  }

  async syncIssues(fetched: Array<{ key: string; summary: string; url: string; status?: string; originalEstimateSeconds?: number }>): Promise<void> {
    for (const details of fetched) {
      const existing = this.data.issues[details.key];
      this.data.issues[details.key] = existing ? { ...this.ensureIssueDefaults(existing), ...details, updatedAt: new Date().toISOString() } : {
        ...details, sessions: [], totalTimeSeconds: 0, iterations: 0, inputTokens: 0, outputTokens: 0,
        copilotCredits: 0, accountingStatus: 'unavailable', accountingNotes: [], modelUsageBreakdown: {},
        promptNotes: [], filesChanged: [], blockers: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      };
    }
    if (fetched.length && (!this.data.selectedKey || !this.data.issues[this.data.selectedKey])) this.data.selectedKey = fetched[0].key;
    await this.save();
  }

  async mutate(key: string, operation: (issue: IssueRecord) => void): Promise<void> {
    const issue = this.data.issues[key];
    if (!issue) return;
    operation(issue);
    issue.updatedAt = new Date().toISOString();
    await this.save();
  }

  async select(key: string): Promise<void> { this.data.selectedKey = key; await this.save(); }

  async remove(key: string): Promise<void> {
    delete this.data.issues[key];
    if (this.data.selectedKey === key) this.data.selectedKey = Object.keys(this.data.issues)[0];
    await this.save();
  }

  getIssue(key: string): IssueRecord | undefined {
    const issue = this.data.issues[key];
    return issue ? structuredClone(issue) : undefined;
  }

  activeIssueKey(): string | undefined {
    const selected = this.data.selectedKey;
    if (selected && this.data.issues[selected]?.sessions.some(session => !session.stoppedAt)) return selected;
    return Object.values(this.data.issues).find(issue => issue.sessions.some(session => !session.stoppedAt))?.key;
  }

  private normalizeData(): void {
    if (!this.data || typeof this.data !== 'object') this.data = { issues: {} };
    if (!this.data.issues || typeof this.data.issues !== 'object') this.data.issues = {};
    for (const [key, issue] of Object.entries(this.data.issues)) {
      this.data.issues[key] = this.ensureIssueDefaults(issue);
    }
  }

  private ensureIssueDefaults(issue: IssueRecord): IssueRecord {
    const normalized: IssueRecord = {
      ...issue,
      sessions: Array.isArray(issue.sessions) ? issue.sessions.map(session => ({
        ...session,
        usageAppliedAtStop: session.stoppedAt ? (session.usageAppliedAtStop ?? true) : false
      })) : [],
      totalTimeSeconds: Number.isFinite(issue.totalTimeSeconds) ? issue.totalTimeSeconds : 0,
      iterations: Number.isFinite(issue.iterations) ? issue.iterations : 0,
      inputTokens: Number.isFinite(issue.inputTokens) ? issue.inputTokens : 0,
      outputTokens: Number.isFinite(issue.outputTokens) ? issue.outputTokens : 0,
      copilotCredits: Number.isFinite(issue.copilotCredits) ? issue.copilotCredits : 0,
      accountingStatus: issue.accountingStatus ?? 'unavailable',
      accountingNotes: Array.isArray(issue.accountingNotes) ? issue.accountingNotes : [],
      modelUsageBreakdown: issue.modelUsageBreakdown && typeof issue.modelUsageBreakdown === 'object' ? issue.modelUsageBreakdown : {},
      promptNotes: Array.isArray(issue.promptNotes) ? issue.promptNotes : [],
      filesChanged: Array.isArray(issue.filesChanged) ? issue.filesChanged : [],
      blockers: Array.isArray(issue.blockers) ? issue.blockers : [],
      createdAt: issue.createdAt ?? new Date().toISOString(),
      updatedAt: issue.updatedAt ?? new Date().toISOString()
    };
    if (!Number.isFinite(normalized.lastProcessedRequestCount ?? NaN)) delete normalized.lastProcessedRequestCount;
    return normalized;
  }
}

class JiraClient {
  constructor(private readonly baseUrl: string, private readonly token: string, private readonly email?: string) {}

  private authHeader(): string {
    return this.email ? `Basic ${Buffer.from(`${this.email}:${this.token}`).toString('base64')}` : `Bearer ${this.token}`;
  }

  private async request<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, { headers: { Authorization: this.authHeader(), Accept: 'application/json' } });
    if (!response.ok) throw new Error(response.status === 401 ? 'Jira rejected the token. Check the base URL, email, and token.' : `Jira request failed: ${response.status} ${response.statusText}`);
    return response.json() as Promise<T>;
  }

  async getCurrentUser(): Promise<{ accountId: string; displayName: string }> {
    return this.request<{ accountId: string; displayName: string }>('/rest/api/3/myself');
  }

  async searchAssignedInProgress(): Promise<Array<{ key: string; summary: string; url: string; status?: string; originalEstimateSeconds?: number }>> {
    const jql = encodeURIComponent('assignee = currentUser() AND statusCategory = "In Progress" ORDER BY updated DESC');
    // Jira's legacy /rest/api/3/search endpoint was retired in favor of /rest/api/3/search/jql
    const json = await this.request<{ issues: Array<{ key: string; fields: { summary: string; status?: { name: string }; timeoriginalestimate?: number } }> }>(`/rest/api/3/search/jql?jql=${jql}&fields=summary,status,timeoriginalestimate&maxResults=50`);
    return json.issues.map(issue => ({ key: issue.key, summary: issue.fields.summary, url: `${this.baseUrl}/browse/${issue.key}`, status: issue.fields.status?.name, originalEstimateSeconds: issue.fields.timeoriginalestimate }));
  }
}

interface ParsedRequestUsage {
  promptTokens?: number;
  completionTokens?: number;
  copilotCredits?: number;
  model?: string;
  usedPromptFallback: boolean;
  usedOutputFallback: boolean;
  usedCreditsFallback: boolean;
}

interface ParsedChatUsage {
  requestCount: number;
  requests: ParsedRequestUsage[];
}

interface UsageTotals {
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  copilotCredits: number;
  hasAnyExplicit: boolean;
  isPartial: boolean;
  modelUsageBreakdown: Record<string, number>;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readModel(request: Record<string, unknown>): string | undefined {
  const response = Array.isArray(request.response) ? request.response : undefined;
  const firstResponse = response && response.length ? readRecord(response[0]) : undefined;
  const responseMetadata = readRecord(firstResponse?.metadata);
  if (typeof responseMetadata?.modelId === 'string' && responseMetadata.modelId.trim()) return responseMetadata.modelId;

  const result = readRecord(request.result);
  const resultMetadata = readRecord(result?.metadata);
  if (typeof resultMetadata?.resolvedModel === 'string' && resultMetadata.resolvedModel.trim()) return resultMetadata.resolvedModel;
  return undefined;
}

function readMetadataNumber(request: Record<string, unknown>, field: string): number | undefined {
  const response = Array.isArray(request.response) ? request.response : undefined;
  const firstResponse = response && response.length ? readRecord(response[0]) : undefined;
  const responseMetadata = readRecord(firstResponse?.metadata);
  const responseValue = readNumber(responseMetadata?.[field]);
  if (responseValue !== undefined) return responseValue;

  const result = readRecord(request.result);
  const resultMetadata = readRecord(result?.metadata);
  return readNumber(resultMetadata?.[field]);
}

function readFallbackOutputTokens(request: Record<string, unknown>): number | undefined {
  const response = Array.isArray(request.response) ? request.response : undefined;
  const firstResponse = response && response.length ? readRecord(response[0]) : undefined;
  const responseMetadata = readRecord(firstResponse?.metadata);
  const responseFallback = readNumber(responseMetadata?.outputTokens);
  if (responseFallback !== undefined) return responseFallback;

  const result = readRecord(request.result);
  const resultMetadata = readRecord(result?.metadata);
  return readNumber(resultMetadata?.outputTokens);
}

function parseExportedChatUsage(raw: string): ParsedChatUsage {
  const json = JSON.parse(raw) as unknown;
  const root = readRecord(json);
  const requests = Array.isArray(root?.requests) ? root.requests : [];
  const parsed: ParsedRequestUsage[] = [];

  for (const request of requests) {
    const row = readRecord(request);
    if (!row) continue;
    const directPromptTokens = readNumber(row.promptTokens);
    const promptFallback = directPromptTokens === undefined ? readMetadataNumber(row, 'promptTokens') : undefined;
    const directCompletionTokens = readNumber(row.completionTokens);
    const fallbackOutputTokens = directCompletionTokens === undefined ? readFallbackOutputTokens(row) : undefined;
    const directCredits = readNumber(row.copilotCredits);
    const creditsFallback = directCredits === undefined ? readMetadataNumber(row, 'copilotCredits') : undefined;
    parsed.push({
      promptTokens: directPromptTokens ?? promptFallback,
      completionTokens: directCompletionTokens ?? fallbackOutputTokens,
      copilotCredits: directCredits ?? creditsFallback,
      model: readModel(row),
      usedPromptFallback: directPromptTokens === undefined && promptFallback !== undefined,
      usedOutputFallback: directCompletionTokens === undefined && fallbackOutputTokens !== undefined,
      usedCreditsFallback: directCredits === undefined && creditsFallback !== undefined
    });
  }

  return { requestCount: parsed.length, requests: parsed };
}

function summarizeUsage(requests: ParsedRequestUsage[]): UsageTotals {
  const summary: UsageTotals = {
    iterations: requests.length,
    inputTokens: 0,
    outputTokens: 0,
    copilotCredits: 0,
    hasAnyExplicit: false,
    isPartial: false,
    modelUsageBreakdown: {}
  };

  for (const request of requests) {
    if (request.promptTokens !== undefined) {
      summary.inputTokens += request.promptTokens;
      summary.hasAnyExplicit = true;
    } else {
      summary.isPartial = true;
    }

    if (request.completionTokens !== undefined) {
      summary.outputTokens += request.completionTokens;
      summary.hasAnyExplicit = true;
    } else {
      summary.isPartial = true;
    }

    if (request.copilotCredits !== undefined) {
      summary.copilotCredits += request.copilotCredits;
      summary.hasAnyExplicit = true;
    } else {
      summary.isPartial = true;
    }

    if (request.usedPromptFallback || request.usedOutputFallback || request.usedCreditsFallback) summary.isPartial = true;
    if (request.model) summary.modelUsageBreakdown[request.model] = (summary.modelUsageBreakdown[request.model] ?? 0) + 1;
  }

  return summary;
}

function mergeModelUsage(target: Record<string, number>, increment: Record<string, number>): void {
  for (const [model, count] of Object.entries(increment)) target[model] = (target[model] ?? 0) + count;
}

function appendAccountingNote(issue: IssueRecord, note: string): void {
  issue.accountingNotes.push(`${new Date().toISOString()} ${note}`);
  if (issue.accountingNotes.length > 30) issue.accountingNotes.splice(0, issue.accountingNotes.length - 30);
}

interface LoginState {
  loggedIn: boolean;
  baseUrl: string;
  email: string;
  currentUserName?: string;
  error?: string;
  visibleKeys: Set<string>;
}

class DashboardProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private currentUserName?: string;
  private loginError?: string;
  private readonly exportCommands = [
    'github.copilot.chat.export',
    'github.copilot.chat.exportChat',
    'workbench.action.chat.export',
    'workbench.action.chat.exportSession'
  ];
  constructor(private readonly context: vscode.ExtensionContext, private readonly tracker: TrackerStore) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage(message => this.handleMessage(message));
    this.render();
  }

  refresh(): void { this.render(); }

  private async render(): Promise<void> {
    await this.tracker.ready();
    const baseUrl = vscode.workspace.getConfiguration('agenttracker').get<string>('jiraBaseUrl')?.trim() ?? '';
    const token = await this.context.secrets.get(tokenSecret);
    const email = await this.context.secrets.get(emailSecret);
    const loggedIn = Boolean(baseUrl && token);
    let visibleKeys = new Set<string>();
    if (loggedIn && token) {
      try {
        const client = new JiraClient(baseUrl.replace(/\/$/, ''), token, email);
        const user = await client.getCurrentUser();
        this.currentUserName = user.displayName;
        const issues = await client.searchAssignedInProgress();
        await this.tracker.syncIssues(issues);
        visibleKeys = new Set(issues.map(issue => issue.key));
        this.loginError = undefined;
      } catch (error) {
        this.loginError = error instanceof Error ? error.message : 'Could not reach Jira.';
      }
    } else {
      this.currentUserName = undefined;
    }
    if (this.view) {
      this.view.webview.html = html(this.view.webview, this.tracker.snapshot, {
        loggedIn, baseUrl, email: email ?? '', currentUserName: this.currentUserName, error: this.loginError, visibleKeys
      });
    }
  }

  private async login(baseUrl?: string, email?: string, token?: string): Promise<void> {
    const normalizedBaseUrl = baseUrl?.trim().replace(/\/$/, '') ?? '';
    if (!/^https?:\/\//i.test(normalizedBaseUrl) || !token?.trim()) {
      this.loginError = 'Enter a Jira base URL (http:// or https://) and an API token.';
      return;
    }
    await vscode.workspace.getConfiguration('agenttracker').update('jiraBaseUrl', normalizedBaseUrl, vscode.ConfigurationTarget.Global);
    if (email?.trim()) await this.context.secrets.store(emailSecret, email.trim());
    else await this.context.secrets.delete(emailSecret);
    await this.context.secrets.store(tokenSecret, token.trim());
    this.loginError = undefined;
  }

  private async logout(): Promise<void> {
    await this.context.secrets.delete(tokenSecret);
    await this.context.secrets.delete(emailSecret);
    this.currentUserName = undefined;
    this.loginError = undefined;
  }

  private async stopTracking(key: string): Promise<void> {
    let sessionStopped = false;
    await this.tracker.mutate(key, issue => {
      const session = [...issue.sessions].reverse().find(item => !item.stoppedAt);
      if (!session) return;
      session.baselineRequestCount = session.baselineRequestCount ?? issue.lastProcessedRequestCount;
      session.stoppedAt = new Date().toISOString();
      session.durationSeconds = Math.max(0, (Date.parse(session.stoppedAt) - Date.parse(session.startedAt)) / 1000);
      session.usageAppliedAtStop = false;
      issue.totalTimeSeconds = issue.sessions.reduce((sum, item) => sum + (item.durationSeconds ?? 0), 0);
      sessionStopped = true;
    });

    if (!sessionStopped) return;
    const result = await this.applyUsageFromStopExport(key);
    if (result.level === 'warning') vscode.window.showWarningMessage(result.message);
    else vscode.window.showInformationMessage(result.message);
  }

  private async applyUsageFromStopExport(key: string): Promise<{ level: 'info' | 'warning'; message: string }> {
    const exportUri = await this.acquireExportedChatJson();
    if (!exportUri) {
      await this.tracker.mutate(key, issue => {
        const session = [...issue.sessions].reverse().find(item => item.stoppedAt && item.usageAppliedAtStop === false);
        if (!session) return;
        session.usageAppliedAtStop = true;
        issue.accountingStatus = 'unavailable';
        appendAccountingNote(issue, 'Stop completed, but chat export was not provided. Usage totals were not updated.');
      });
      return { level: 'warning', message: 'Stopped tracking. Usage was not updated because no chat export was available.' };
    }

    let usage: ParsedChatUsage;
    try {
      const bytes = await vscode.workspace.fs.readFile(exportUri);
      usage = parseExportedChatUsage(new TextDecoder().decode(bytes));
    } catch {
      await this.tracker.mutate(key, issue => {
        const session = [...issue.sessions].reverse().find(item => item.stoppedAt && item.usageAppliedAtStop === false);
        if (!session) return;
        session.usageAppliedAtStop = true;
        issue.accountingStatus = 'unavailable';
        appendAccountingNote(issue, 'Stop completed, but exported chat could not be parsed. Usage totals were not updated.');
      });
      return { level: 'warning', message: 'Stopped tracking. Exported chat could not be parsed, so usage was not updated.' };
    }

    let userMessage = 'Stopped tracking and updated usage totals.';
    await this.tracker.mutate(key, issue => {
      const session = [...issue.sessions].reverse().find(item => item.stoppedAt && item.usageAppliedAtStop === false);
      if (!session) {
        userMessage = 'Stopped tracking. No pending session usage update was found.';
        return;
      }

      const baseline = session.baselineRequestCount ?? issue.lastProcessedRequestCount ?? 0;
      let safeBaseline = Math.max(0, baseline);
      if (usage.requestCount < safeBaseline) {
        safeBaseline = 0;
        appendAccountingNote(issue, `Export request count reset from baseline ${baseline} to ${usage.requestCount}; restarting delta from 0.`);
      } else {
        safeBaseline = Math.min(usage.requestCount, safeBaseline);
      }
      const delta = usage.requests.slice(safeBaseline);
      const totals = summarizeUsage(delta);
      issue.lastProcessedRequestCount = usage.requestCount;
      session.usageAppliedAtStop = true;

      if (!delta.length) {
        issue.accountingStatus = 'exact';
        appendAccountingNote(issue, 'No new chat requests were found after the start baseline.');
        userMessage = 'Stopped tracking. No new chat requests were found for this session.';
        return;
      }

      if (!totals.hasAnyExplicit) {
        issue.accountingStatus = 'unavailable';
        appendAccountingNote(issue, 'No explicit promptTokens/completionTokens/copilotCredits fields were found in stop export delta.');
        userMessage = 'Stopped tracking. Export delta has no explicit usage fields, so totals were not updated.';
        return;
      }

      issue.iterations += totals.iterations;
      issue.inputTokens += totals.inputTokens;
      issue.outputTokens += totals.outputTokens;
      issue.copilotCredits += totals.copilotCredits;
      mergeModelUsage(issue.modelUsageBreakdown, totals.modelUsageBreakdown);
      issue.accountingStatus = totals.isPartial ? 'partial' : 'exact';
      appendAccountingNote(issue, `Processed ${totals.iterations} requests from stop export delta (${issue.accountingStatus}).`);
      userMessage = totals.isPartial
        ? 'Stopped tracking and applied partial usage totals (some fields were missing in export data).'
        : 'Stopped tracking and applied exact usage totals from chat export.';
    });

    return { level: userMessage.includes('not updated') ? 'warning' : 'info', message: userMessage };
  }

  private async acquireExportedChatJson(): Promise<vscode.Uri | undefined> {
    const tempDir = vscode.Uri.joinPath(this.context.globalStorageUri, 'chat-exports');
    await vscode.workspace.fs.createDirectory(tempDir);
    const tempTarget = vscode.Uri.joinPath(tempDir, `chat-${Date.now()}.json`);

    for (const command of this.exportCommands) {
      try {
        const result = await vscode.commands.executeCommand<unknown>(command, tempTarget);
        const candidate = this.coerceUri(result) ?? tempTarget;
        if (await this.isReadableExport(candidate)) return candidate;
        if (candidate.toString() !== tempTarget.toString() && await this.isReadableExport(tempTarget)) return tempTarget;
      } catch {
        // Try the next command id when a command is unavailable.
      }
    }

    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: false,
      canSelectMany: false,
      canSelectFiles: true,
      title: 'Select exported Copilot chat JSON',
      filters: { JSON: ['json'] }
    });
    if (!picked?.length) return undefined;

    try {
      const bytes = await vscode.workspace.fs.readFile(picked[0]);
      await vscode.workspace.fs.writeFile(tempTarget, bytes);
      return tempTarget;
    } catch {
      return undefined;
    }
  }

  private coerceUri(value: unknown): vscode.Uri | undefined {
    if (value instanceof vscode.Uri) return value;
    if (typeof value === 'string') {
      try { return vscode.Uri.parse(value); } catch { return undefined; }
    }
    return undefined;
  }

  private async isReadableExport(uri: vscode.Uri): Promise<boolean> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      parseExportedChatUsage(new TextDecoder().decode(bytes));
      return true;
    } catch {
      return false;
    }
  }

  private async handleMessage(message: { type: string; key?: string; note?: string; baseUrl?: string; email?: string; token?: string }): Promise<void> {
    if (message.type === 'login') await this.login(message.baseUrl, message.email, message.token);
    else if (message.type === 'logout') await this.logout();
    else if (message.type === 'openTokenPage') { await vscode.env.openExternal(vscode.Uri.parse('https://id.atlassian.com/manage-profile/security/api-tokens')); return; }
    else if (message.type === 'refresh') { /* render() below re-syncs from Jira */ }
    else if (message.key) {
      if (message.type === 'select') await this.tracker.select(message.key);
      if (message.type === 'start') await this.tracker.mutate(message.key, issue => {
        if (!issue.sessions.some(session => !session.stoppedAt)) {
          issue.sessions.push({
            startedAt: new Date().toISOString(),
            baselineRequestCount: issue.lastProcessedRequestCount,
            usageAppliedAtStop: false
          });
        }
      });
      if (message.type === 'stop') await this.stopTracking(message.key);
      if (message.type === 'note') await this.tracker.mutate(message.key, issue => { if (message.note?.trim()) issue.promptNotes.push(message.note.trim()); });
      if (message.type === 'remove') await this.tracker.remove(message.key);
    }
    await this.render();
  }
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function formatAccountingStatus(status: AccountingStatus): string {
  if (status === 'exact') return 'Exact';
  if (status === 'partial') return 'Partial';
  return 'Unavailable';
}

function html(webview: vscode.Webview, data: TrackerData, login: LoginState): string {
  const nonce = String(Date.now());
  const issues = Object.values(data.issues).filter(issue => login.visibleKeys.has(issue.key));
  const selected = (data.selectedKey && login.visibleKeys.has(data.selectedKey) ? data.issues[data.selectedKey] : undefined) ?? issues[0];
  const cards = issues.map(issue => `<button class="issue ${selected?.key === issue.key ? 'selected' : ''}" data-action="select" data-key="${issue.key}"><strong>${issue.key}</strong><span>${escapeHtml(issue.summary)}</span><small>${issue.sessions.some(s => !s.stoppedAt) ? '● tracking' : formatDuration(issue.totalTimeSeconds)}</small></button>`).join('');
  const active = selected?.sessions.some(s => !s.stoppedAt);
  const modelSummary = selected ? Object.entries(selected.modelUsageBreakdown)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([model, count]) => `${escapeHtml(model)} (${count})`)
    .join(', ') : '';
  const latestNote = selected?.accountingNotes.length ? selected.accountingNotes[selected.accountingNotes.length - 1] : undefined;
  const detail = selected
    ? `<section class="detail"><div class="eyebrow">ACTIVE ISSUE</div><h2>${selected.key}</h2><p class="summary">${escapeHtml(selected.summary)}</p><div class="metrics"><div><b>${formatDuration(selected.totalTimeSeconds)}</b><span>time spent</span></div><div><b>${selected.iterations}</b><span>iterations</span></div><div><b>${selected.inputTokens.toLocaleString()}</b><span>input tokens</span></div><div><b>${selected.outputTokens.toLocaleString()}</b><span>output tokens</span></div><div><b>${(selected.inputTokens + selected.outputTokens).toLocaleString()}</b><span>total tokens</span></div><div><b>${selected.copilotCredits.toFixed(5)}</b><span>copilot credits</span></div><div><b>${formatAccountingStatus(selected.accountingStatus)}</b><span>usage status</span></div></div><div class="actions"><button class="primary" data-action="${active ? 'stop' : 'start'}" data-key="${selected.key}">${active ? 'Stop tracking' : 'Start tracking'}</button><button data-action="note" data-key="${selected.key}">Add note</button><button data-action="remove" data-key="${selected.key}">Forget issue</button></div><p class="meta">Original estimate: ${selected.originalEstimateSeconds ? formatDuration(selected.originalEstimateSeconds) : 'not available'}${selected.status ? ` · Jira status: ${escapeHtml(selected.status)}` : ''}</p>${modelSummary ? `<p class="meta">Top models: ${modelSummary}</p>` : ''}${latestNote ? `<p class="meta">Last accounting note: ${escapeHtml(latestNote)}</p>` : ''}</section>`
    : `<section class="empty"><h2>No issues in progress</h2><p>Tickets assigned to you with status "In Progress" in Jira will appear here automatically.</p></section>`;

  const body = login.loggedIn
    ? `<div class="session"><span>Signed in as ${escapeHtml(login.currentUserName ?? 'Jira user')}</span><button data-action="logout">Sign out</button></div>${login.error ? `<p class="error">${escapeHtml(login.error)}</p>` : ''}<div class="issue-list">${cards || '<div class="hint">No issues assigned to you are In Progress.</div>'}</div>${detail}`
    : `<section class="login"><h2>Sign in to Jira</h2><p class="hint">Tickets assigned to you with status "In Progress" will appear automatically. Use an API token; nothing is written to the local tracker file.</p><label>Jira base URL<input id="baseUrl" type="text" placeholder="https://company.atlassian.net" value="${escapeHtml(login.baseUrl)}"></label><label>Account email (Jira Cloud)<input id="email" type="text" placeholder="you@company.com" value="${escapeHtml(login.email)}"></label><label>API token<input id="token" type="password" placeholder="API token"></label><button type="button" class="link" data-action="openTokenPage">Get an API token in your browser ↗</button>${login.error ? `<p class="error">${escapeHtml(login.error)}</p>` : ''}<button class="primary" data-action="login">Sign in</button></section>`;

  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><style>${styles}</style></head><body><header><div><div class="brand">AgentTracker</div><div class="sub">Agent-assisted work log</div></div>${login.loggedIn ? '<div class="toolbar"><button title="Refresh" data-action="refresh">⟳</button></div>' : ''}</header><main>${body}</main><script nonce="${nonce}">
const vscode = acquireVsCodeApi();
document.addEventListener('click', event => {
  const el = event.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  if (action === 'login') {
    vscode.postMessage({ type: 'login', baseUrl: document.getElementById('baseUrl').value, email: document.getElementById('email').value, token: document.getElementById('token').value });
    return;
  }
  if (action === 'logout' || action === 'refresh' || action === 'openTokenPage') { vscode.postMessage({ type: action }); return; }
  let note;
  if (action === 'note') note = prompt('Note:');
  vscode.postMessage({ type: action, key: el.dataset.key, note });
});
</script></body></html>`;
}

function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character); }

const styles = `
:root{color-scheme:dark;--bg:#10151b;--panel:#171e26;--line:#2a3540;--text:#e7edf2;--muted:#91a0ad;--accent:#77d6b3;--accent2:#ffca6b}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}header{display:flex;align-items:center;justify-content:space-between;padding:18px 16px 14px;border-bottom:1px solid var(--line)}.brand{font-weight:700;letter-spacing:.04em}.sub,.meta,.hint{color:var(--muted);font-size:11px}.toolbar{display:flex;gap:5px}button{font:inherit;color:inherit;background:transparent;border:1px solid var(--line);border-radius:4px;padding:7px 10px;cursor:pointer}button:hover{border-color:var(--accent);color:var(--accent)}.toolbar button{font-size:16px;padding:3px 8px}.issue-list{padding:12px 10px 4px;display:grid;gap:5px}.issue{width:100%;display:grid;grid-template-columns:auto 1fr auto;gap:8px;text-align:left;border-color:transparent;padding:8px 7px}.issue span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted)}.issue small{color:var(--muted);font-size:10px}.issue.selected{background:var(--panel);border-color:var(--line)}.issue.selected strong{color:var(--accent)}main{min-height:100vh}.detail,.empty,.login{margin:12px 10px;padding:16px 14px;background:var(--panel);border:1px solid var(--line);border-radius:6px}.eyebrow{font-size:10px;letter-spacing:.14em;color:var(--accent)}h2{font-size:21px;margin:5px 0}.summary{color:var(--muted);margin:0 0 18px}.metrics{display:grid;grid-template-columns:1fr 1fr 1fr;gap:1px;background:var(--line);border:1px solid var(--line);margin-bottom:16px}.metrics div{background:var(--panel);padding:10px}.metrics b{display:block;font-size:16px;color:var(--accent2)}.metrics span{font-size:10px;color:var(--muted)}.actions{display:flex;gap:6px;flex-wrap:wrap}.primary{background:var(--accent);border-color:var(--accent);color:#10201b;font-weight:700}.primary:hover{color:#10201b;filter:brightness(1.1)}.meta{margin:16px 0 0}.empty h2{font-size:16px}.empty p{color:var(--muted)}
.login h2{font-size:16px;margin-top:0}.login p.hint{margin-top:0}.login label{display:block;font-size:11px;color:var(--muted);margin:12px 0 4px}.login input{width:100%;padding:7px 8px;background:var(--bg);border:1px solid var(--line);border-radius:4px;color:var(--text);font:inherit}.login .primary{margin-top:16px}.login .link{border:none;padding:6px 0;color:var(--accent);font-size:11px}.login .link:hover{text-decoration:underline}.session{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;margin:12px 10px 0;background:var(--panel);border:1px solid var(--line);border-radius:6px;font-size:12px}.error{color:#ff9494;font-size:11px;margin:8px 10px 0;padding:0 4px}
`;

