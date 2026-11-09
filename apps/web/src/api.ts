import type {
  ConnectorKindView,
  ConnectorView,
  DaySummary,
  DayView,
  IdentityView,
  Page,
  ProjectView,
  RecordView,
  ReportRef,
  ReportVersionView,
  RevisionView,
  RuleMatch,
  StatusView,
  WorkspaceView,
} from '@xjournal/core';

// A thin client for /api/v1 (docs/api.md). Local mode authenticates with the per-install
// token (spec §11.3), kept in this browser's localStorage.

const TOKEN_KEY = 'xjournal.token';

export const tokenStore = {
  get: (): string | null => {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set: (t: string) => {
    try {
      localStorage.setItem(TOKEN_KEY, t);
    } catch {
      // Private mode: the token lasts until the tab closes.
    }
  },
  clear: () => {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {}
  },
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  return requestWith<T>(method, path, body, {});
}

async function requestWith<T>(
  method: string,
  path: string,
  body: unknown,
  extra: Record<string, string>,
): Promise<T> {
  const token = tokenStore.get();
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers: {
      ...extra,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      'x-hub-client': 'web',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const p = (await res.json().catch(() => ({}))) as {
      code?: string;
      title?: string;
      errors?: { path: string; message: string }[];
    };
    const detail = p.errors?.map((e) => `${e.path}: ${e.message}`).join('; ');
    throw new ApiError(
      res.status,
      p.code ?? 'internal',
      detail ? `${p.title}: ${detail}` : (p.title ?? res.statusText),
    );
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const qs = (params: Record<string, string | number | undefined | null>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
};

export interface Me {
  user: { id: string; name: string };
  projects: ProjectView[];
}

export interface RouteBody {
  projectId?: string | null;
  date?: string;
  kind?: string;
  visibility?: string;
  tags?: string[];
}

export interface RuleView {
  id: string;
  projectId: string;
  priority: number;
  match: RuleMatch;
  version: number;
  active: boolean;
  createdAt: string;
}

export interface ProjectPatch {
  name?: string;
  timeZone?: string | null;
  defaultNoteVisibility?: string;
}

export interface ConnectorInput {
  kind: string;
  displayName?: string;
  config: Record<string, unknown>;
  secret?: string;
  projectIds: string[];
  backfillFrom?: string;
}

export interface ConnectorPatch {
  displayName?: string;
  config?: Record<string, unknown>;
  projectIds?: string[];
}

/** `202` from the queue, or the finished result when the hub runs it inline. */
export type Queued = { queued: boolean; alreadyRunning: boolean } | Record<string, unknown>;

/** The queue already had this job (a second click while one is queued or running). */
export const alreadyRunning = (q: Queued | undefined): boolean =>
  q != null && 'alreadyRunning' in q && q.alreadyRunning === true;

export const api = {
  me: () => request<Me>('GET', '/me'),
  days: (projectId: string, from: string, to: string) =>
    request<{ items: DaySummary[] }>('GET', `/projects/${projectId}/days${qs({ from, to })}`),
  day: (projectId: string, date: string) =>
    request<DayView>('GET', `/projects/${projectId}/days/${date}`),
  record: (id: string) => request<RecordView>('GET', `/records/${id}`),
  revisions: (id: string) => request<{ items: RevisionView[] }>('GET', `/records/${id}/revisions`),
  inbox: (cursor?: string) =>
    request<Page<RecordView>>('GET', `/inbox${qs({ limit: 50, cursor })}`),
  search: (p: { q: string; projectId?: string; from?: string; to?: string; cursor?: string }) =>
    request<Page<RecordView & { score: number }>>('GET', `/search${qs({ ...p, limit: 50 })}`),
  addNote: (text: string, projectId?: string) =>
    request<{ note: RecordView; routed: boolean }>('POST', '/notes', {
      text,
      ...(projectId ? { projectId } : {}),
    }),
  editNote: (id: string, text: string) => request<RecordView>('PATCH', `/notes/${id}`, { text }),
  route: (id: string, body: RouteBody) => request<RecordView>('POST', `/records/${id}/route`, body),

  // Reports (api.md §3.5)
  report: (projectId: string, kind: string, date: string) =>
    request<ReportVersionView>('GET', `/report${qs({ projectId, kind, date })}`),
  reportVersion: (id: string) => request<ReportVersionView>('GET', `/report-versions/${id}`),
  reports: (projectId: string, from: string, to: string, kind?: string) =>
    request<{
      items: (ReportRef & {
        versionNo: number | null;
        path: string | null;
        updatedAt: string | null;
      })[];
    }>('GET', `/projects/${projectId}/reports${qs({ from, to, kind })}`),
  reportVersions: (reportId: string) =>
    request<{
      items: {
        versionId: string;
        versionNo: number;
        path: string;
        client: string | null;
        model: string | null;
        changeReason: string;
        changeSummary: string | null;
        createdAt: string;
      }[];
    }>('GET', `/reports/${reportId}/versions`),
  publish: (versionId: string, force = false) =>
    request<{
      status: string;
      url?: string;
      pageTitle?: string;
      currentText?: string;
      message?: string;
    }>('POST', `/report-versions/${versionId}/publish`, { confirm: true, force }),
  status: (projectId?: string) => request<StatusView>('GET', `/status${qs({ projectId })}`),
  resolveReport: (projectId: string, kind: string, date: string) =>
    request<ReportRef>('POST', `/projects/${projectId}/reports/resolve`, { kind, date }),
  generate: (reportId: string, instructions?: string) =>
    request<Queued>('POST', `/reports/${reportId}/generate`, instructions ? { instructions } : {}),
  refreshReports: (projectId: string) =>
    request<Queued>('POST', `/projects/${projectId}/reports/refresh`),
  exportMarkdown: async (versionId: string) => {
    const token = tokenStore.get();
    const res = await fetch(`/api/v1/report-versions/${versionId}/export`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new ApiError(res.status, 'internal', 'Export failed');
    const name =
      /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'report.md';
    return { name, text: await res.text() };
  },
  stats: (projectId: string, from: string, to: string) =>
    request<{ items: { metric: string; value: number; description: string }[] }>(
      'GET',
      `/stats${qs({ projectId, from, to })}`,
    ),
  guidance: (projectId?: string) =>
    request<{
      items: {
        id: string;
        scope: string;
        projectId: string | null;
        reportKind: string | null;
        text: string;
        visibility: string;
        createdAt: string;
      }[];
    }>('GET', `/guidance${qs({ projectId })}`),
  addGuidance: (body: {
    scope: string;
    text: string;
    projectId?: string;
    reportKind?: string;
    reportId?: string;
  }) => request<{ guidanceId: string }>('POST', '/guidance', body),
  archiveGuidance: (id: string) => request<void>('DELETE', `/guidance/${id}`),
  ai: () => request<{ hasKey: boolean; model: string }>('GET', '/ai'),
  setAiKey: (key: string) => request<void>('PUT', '/ai/key', { key }),
  removeAiKey: () => request<void>('DELETE', '/ai/key'),

  // Settings (api.md §3.2a)
  workspace: () => request<WorkspaceView>('GET', '/workspace'),
  updateWorkspace: (body: { name?: string; timeZone?: string; weekStart?: number }) =>
    request<WorkspaceView>('PATCH', '/workspace', body),
  createProject: (body: { slug: string; name: string; timeZone?: string }) =>
    request<ProjectView>('POST', '/projects', body),
  updateProject: (id: string, body: ProjectPatch) =>
    request<ProjectView>('PATCH', `/projects/${id}`, body),
  archiveProject: (id: string) => request<void>('POST', `/projects/${id}/archive`),
  rebuildDay: (projectId: string, date: string) =>
    request<{ changed: boolean }>('POST', `/projects/${projectId}/days/${date}/rebuild`),

  connectorKinds: () => request<{ items: ConnectorKindView[] }>('GET', '/connector-kinds'),
  connectors: () => request<{ items: ConnectorView[] }>('GET', '/connectors'),
  addConnector: (body: ConnectorInput) => request<ConnectorView>('POST', '/connectors', body),
  updateConnector: (id: string, body: ConnectorPatch) =>
    request<ConnectorView>('PATCH', `/connectors/${id}`, body),
  replaceSecret: (id: string, secret: string) =>
    request<void>('PUT', `/connectors/${id}/secret`, { secret }),
  removeConnector: (id: string) => request<void>('DELETE', `/connectors/${id}`),
  syncConnector: (id: string, body: { backfillFrom?: string } = {}) =>
    request<Queued>('POST', `/connectors/${id}/sync`, body),
  morningRun: () => request<Queued>('POST', '/runs/morning'),

  rules: () => request<{ items: RuleView[] }>('GET', '/rules'),
  createRule: (body: { projectId: string; priority?: number; match: RuleMatch }) =>
    request<RuleView>('POST', '/rules', body),
  updateRule: (r: RuleView, body: Partial<Pick<RuleView, 'projectId' | 'priority' | 'match'>>) =>
    requestWith<RuleView>('PUT', `/rules/${r.id}`, body, { 'if-match': String(r.version) }),
  removeRule: (r: RuleView) =>
    requestWith<void>('DELETE', `/rules/${r.id}`, undefined, { 'if-match': String(r.version) }),
  previewRule: (match: RuleMatch) =>
    request<{
      matches: { id: string; title: string; source: string; applicableDate: string }[];
      total: number;
    }>('POST', '/rules/preview', { match }),
  applyRules: () =>
    request<{ routed: number; byProject: Record<string, number> }>('POST', '/rules/apply'),

  identities: () => request<{ items: IdentityView[] }>('GET', '/identities'),
  addIdentity: (body: { source: string; accountKey: string; aliases: string[] }) =>
    request<IdentityView>('POST', '/identities', body),
  removeIdentity: (id: string) => request<void>('DELETE', `/identities/${id}`),
};
