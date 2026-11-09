import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ConnectorKindView,
  ConnectorView,
  IdentityView,
  ProjectView,
  RuleMatch,
} from '@xjournal/core';
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react';
import { alreadyRunning, api, type RuleView } from '../api';
import { Badge, Button, Empty, ErrorNote, inputClass, Panel } from '../components/ui';
import { useProject } from '../project';

// Settings (plan.md M2): workspace, projects, connectors and identities, all manageable
// without the CLI. Credentials are write-only: entered once, never shown again (spec §8.7).

export type SettingsTab = 'connectors' | 'rules' | 'projects' | 'workspace' | 'identities' | 'ai';
export const settingsTabs: SettingsTab[] = [
  'connectors',
  'rules',
  'projects',
  'workspace',
  'identities',
  'ai',
];

const TAB_LABEL: Record<SettingsTab, string> = {
  connectors: 'Connectors',
  rules: 'Rules',
  projects: 'Projects',
  workspace: 'Workspace',
  identities: 'Identities',
  ai: 'AI',
};

export function SettingsPage({
  tab,
  onTab,
}: {
  tab: SettingsTab;
  onTab: (t: SettingsTab) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1 border-b border-line">
        <h1 className="mr-4 py-2 text-lg font-semibold">Settings</h1>
        {settingsTabs.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => onTab(t)}
            aria-current={t === tab ? 'page' : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${
              t === tab
                ? 'border-accent font-semibold text-ink'
                : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>
      {tab === 'connectors' && <Connectors />}
      {tab === 'rules' && <Rules />}
      {tab === 'projects' && <Projects />}
      {tab === 'workspace' && <Workspace />}
      {tab === 'identities' && <Identities />}
      {tab === 'ai' && <Ai />}
    </div>
  );
}

// ------------------------------------------------------------------------------------------
// Small pieces
// ------------------------------------------------------------------------------------------

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is the child
    <label className="block space-y-1">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted">{hint}</span>}
    </label>
  );
}

/** A destructive action that needs a second click to confirm. */
function ConfirmButton({
  label,
  confirm,
  onConfirm,
  disabled,
}: {
  label: string;
  confirm: string;
  onConfirm: () => void;
  disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <Button
      disabled={disabled}
      className={armed ? 'border-warn text-warn' : ''}
      onClick={() => {
        if (!armed) return setArmed(true);
        setArmed(false);
        onConfirm();
      }}
    >
      {armed ? confirm : label}
    </Button>
  );
}

const timeZones = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf(
      'timeZone',
    );
  } catch {
    return [] as string[];
  }
})();

function TimeZoneInput({
  value,
  onChange,
  placeholder,
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  id: string;
}) {
  return (
    <>
      <input
        list={`${id}-zones`}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full ${inputClass}`}
      />
      <datalist id={`${id}-zones`}>
        {timeZones.map((z) => (
          <option key={z} value={z} />
        ))}
      </datalist>
    </>
  );
}

const list = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : 'never';

function useInvalidate() {
  const qc = useQueryClient();
  return (...keys: string[]) =>
    Promise.all(keys.map((k) => qc.invalidateQueries({ queryKey: [k] })));
}

// ------------------------------------------------------------------------------------------
// Connectors
// ------------------------------------------------------------------------------------------

function statusTone(status: string): 'muted' | 'warn' | 'accent' {
  return status === 'error' ? 'warn' : status === 'running' ? 'accent' : 'muted';
}

function Connectors() {
  const invalidate = useInvalidate();
  const [polling, setPolling] = useState(0);
  const connectors = useQuery({
    queryKey: ['connectors'],
    queryFn: api.connectors,
    // Poll while a queued sync may still be running.
    refetchInterval: (q) =>
      polling > Date.now() || q.state.data?.items.some((c) => c.status === 'running')
        ? 2000
        : false,
  });
  const kinds = useQuery({ queryKey: ['connector-kinds'], queryFn: api.connectorKinds });
  const [adding, setAdding] = useState(false);
  const morning = useMutation({
    mutationFn: api.morningRun,
    onSuccess: () => {
      setPolling(Date.now() + 60_000);
      return invalidate('connectors', 'days', 'day');
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">
          Accounts the hub collects your activity from. Tokens are kept in the OS keychain.
        </p>
        <div className="flex gap-2">
          <Button onClick={() => morning.mutate()} disabled={morning.isPending}>
            {morning.isPending ? 'Running…' : 'Run morning sync now'}
          </Button>
          <Button variant="primary" onClick={() => setAdding(true)} disabled={adding}>
            + Add connector
          </Button>
        </div>
      </div>
      {morning.error && <ErrorNote error={morning.error} />}
      {alreadyRunning(morning.data) && (
        <p className="text-sm text-muted">A morning run is already queued or running.</p>
      )}
      {adding && kinds.data && (
        <AddConnector
          kinds={kinds.data.items}
          onDone={() => {
            setAdding(false);
            invalidate('connectors', 'identities');
          }}
        />
      )}
      {connectors.error ? (
        <ErrorNote error={connectors.error} />
      ) : connectors.data?.items.length === 0 && !adding ? (
        <Panel>
          <Empty>No connectors yet. Add GitHub to start collecting PRs, reviews and commits.</Empty>
        </Panel>
      ) : (
        connectors.data?.items.map((c) => (
          <ConnectorCard key={c.id} c={c} onSyncQueued={() => setPolling(Date.now() + 60_000)} />
        ))
      )}
    </div>
  );
}

// Per-kind connector forms. Each field maps to one key of the connector's config; lists are
// edited as comma-separated text. Kinds not listed here fall back to raw JSON.

interface FieldSpec {
  key: string;
  label: string;
  hint?: string;
  kind: 'text' | 'list' | 'select' | 'checkbox';
  options?: string[];
  required?: boolean;
  /** Part of the source key: fixed once connected. */
  identity?: boolean;
  placeholder?: string;
  initial?: string;
}

const ATLASSIAN: FieldSpec[] = [
  {
    key: 'baseUrl',
    label: 'Base URL',
    kind: 'text',
    required: true,
    identity: true,
    placeholder: 'https://jira.example.com',
  },
  { key: 'login', label: 'Username', kind: 'text', required: true, hint: 'Your username there' },
  {
    key: 'auth',
    label: 'Token type',
    kind: 'select',
    options: ['bearer', 'basic'],
    initial: 'bearer',
    hint: 'bearer: a personal access token; basic: username + API token',
  },
];

const FORMS: Record<string, FieldSpec[]> = {
  github: [
    {
      key: 'host',
      label: 'Host',
      kind: 'text',
      required: true,
      identity: true,
      initial: 'github.com',
      hint: 'github.com, or your GitHub Enterprise host',
    },
    {
      key: 'login',
      label: 'Login',
      kind: 'text',
      required: true,
      hint: 'Your username on that host',
    },
    {
      key: 'includeOwners',
      label: 'Only these owners',
      kind: 'list',
      placeholder: 'acme, acme-labs',
      hint: 'Users or orgs, comma-separated. Empty: all.',
    },
    {
      key: 'excludeOwners',
      label: 'Never these owners',
      kind: 'list',
      hint: 'e.g. your personal account',
    },
  ],
  jira: [
    ...ATLASSIAN,
    {
      key: 'watchProjects',
      label: 'Watched projects',
      kind: 'list',
      placeholder: 'PROJ, OPS',
      hint: "Other people's new issues, status changes and comments there count too",
    },
  ],
  confluence: [
    ...ATLASSIAN.map((f) =>
      f.key === 'baseUrl' ? { ...f, placeholder: 'https://wiki.example.com' } : f,
    ),
    {
      key: 'excludeAncestorIds',
      label: 'Skip pages under',
      kind: 'list',
      hint: 'Page IDs, e.g. your work-log tree',
    },
    {
      key: 'worklog.space',
      label: 'Work log space',
      kind: 'text',
      placeholder: '~jdoe',
      hint: 'Where daily reports are published. Empty: no work log.',
    },
    {
      key: 'worklog.rootPageId',
      label: 'Work log root page ID',
      kind: 'text',
      hint: 'The page the "Work Logs - <year>" pages live under',
    },
    {
      key: 'worklog.jiraServer',
      label: 'Jira link name',
      kind: 'text',
      hint: 'For live [PROJ-1] macros',
    },
    { key: 'worklog.jiraServerId', label: 'Jira link ID', kind: 'text' },
    {
      key: 'worklog.mirrorDaily',
      label: 'Publish every saved daily report',
      kind: 'checkbox',
    },
  ],
};

type FormValues = Record<string, string>;

// Keys may be dotted ("worklog.space") for nested config objects.
const getPath = (c: Record<string, unknown>, key: string): unknown =>
  key
    .split('.')
    .reduce<unknown>(
      (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
      c,
    );

const formFromConfig = (specs: FieldSpec[], c: Record<string, unknown>): FormValues =>
  Object.fromEntries(
    specs.map((f) => {
      const v = getPath(c, f.key);
      return [f.key, Array.isArray(v) ? v.join(', ') : v != null ? String(v) : (f.initial ?? '')];
    }),
  );

const configFromForm = (specs: FieldSpec[], v: FormValues, base: Record<string, unknown> = {}) => {
  const out: Record<string, unknown> = { ...base };
  const nested: Record<string, Record<string, unknown>> = {};
  for (const f of specs) {
    const raw = v[f.key] ?? '';
    const value =
      f.kind === 'list' ? list(raw) : f.kind === 'checkbox' ? raw === 'true' : raw.trim();
    const [head, sub] = f.key.split('.') as [string, string | undefined];
    if (sub) {
      nested[head] ??= {};
      if (value !== '') (nested[head] as Record<string, unknown>)[sub] = value;
    } else {
      out[head] = value;
    }
  }
  for (const [k, obj] of Object.entries(nested)) {
    // A nested block with nothing but defaults (e.g. no work log space) is left out.
    const meaningful = Object.entries(obj).some(([, x]) => x !== false && x !== '');
    if (meaningful) out[k] = obj;
    else delete out[k];
  }
  return out;
};

function KindFields({
  specs,
  form,
  set,
  editing,
}: {
  specs: FieldSpec[];
  form: FormValues;
  set: (f: FormValues) => void;
  editing?: boolean;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {specs.map((f) => (
        <Field key={f.key} label={f.label} {...(f.hint ? { hint: f.hint } : {})}>
          {f.kind === 'checkbox' ? (
            <input
              type="checkbox"
              checked={form[f.key] === 'true'}
              onChange={(e) => set({ ...form, [f.key]: String(e.target.checked) })}
              className="block"
            />
          ) : f.kind === 'select' ? (
            <select
              value={form[f.key] ?? ''}
              onChange={(e) => set({ ...form, [f.key]: e.target.value })}
              className={`w-full ${inputClass}`}
            >
              {f.options?.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : (
            <input
              required={f.required}
              disabled={editing && f.identity}
              value={form[f.key] ?? ''}
              placeholder={f.placeholder}
              onChange={(e) => set({ ...form, [f.key]: e.target.value })}
              className={`w-full ${inputClass}`}
            />
          )}
        </Field>
      ))}
    </div>
  );
}

function ProjectChecks({
  projects,
  value,
  onChange,
}: {
  projects: ProjectView[];
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  return (
    <fieldset className="space-y-1">
      <legend className="text-sm font-medium">Feeds projects</legend>
      <div className="flex flex-wrap gap-3">
        {projects.map((p) => (
          <label key={p.id} className="flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              checked={value.includes(p.id)}
              onChange={(e) =>
                onChange(e.target.checked ? [...value, p.id] : value.filter((x) => x !== p.id))
              }
            />
            #{p.slug}
          </label>
        ))}
      </div>
      <p className="text-xs text-muted">
        With exactly one project, records are filed there; otherwise they go to the Inbox.
      </p>
    </fieldset>
  );
}

function AddConnector({ kinds, onDone }: { kinds: ConnectorKindView[]; onDone: () => void }) {
  const { projects } = useProject();
  const [kind, setKind] = useState(kinds[0]?.kind ?? '');
  const [name, setName] = useState('');
  const [form, setForm] = useState<FormValues>(() => formFromConfig(FORMS[kind] ?? [], {}));
  const specs = FORMS[kind];
  const [rawConfig, setRawConfig] = useState('{}');
  const [secret, setSecret] = useState('');
  const [projectIds, setProjectIds] = useState<string[]>(projects[0] ? [projects[0].id] : []);
  const [from, setFrom] = useState('');
  const desc = kinds.find((k) => k.kind === kind);
  const needsSecret = desc ? !desc.authTypes.includes('none') : true;

  const add = useMutation({
    mutationFn: () => {
      let config: Record<string, unknown>;
      if (specs) config = configFromForm(specs, form);
      else config = JSON.parse(rawConfig) as Record<string, unknown>;
      return api.addConnector({
        kind,
        config,
        projectIds,
        ...(name.trim() ? { displayName: name.trim() } : {}),
        ...(secret.trim() ? { secret: secret.trim() } : {}),
        ...(from ? { backfillFrom: from } : {}),
      });
    },
    onSuccess: () => {
      setSecret('');
      onDone();
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate();
  };

  return (
    <Panel>
      <form onSubmit={submit} className="space-y-4" autoComplete="off">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Add a connector</h2>
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Kind">
            <select
              value={kind}
              onChange={(e) => {
                setKind(e.target.value);
                setForm(formFromConfig(FORMS[e.target.value] ?? [], {}));
              }}
              className={`w-full ${inputClass}`}
            >
              {kinds.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.displayName}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Name" hint="Optional, e.g. “GitHub (work)”">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={`w-full ${inputClass}`}
            />
          </Field>
        </div>
        {specs ? (
          <KindFields specs={specs} form={form} set={setForm} />
        ) : (
          <Field label="Config (JSON)">
            <textarea
              value={rawConfig}
              onChange={(e) => setRawConfig(e.target.value)}
              rows={4}
              className={`w-full font-mono ${inputClass}`}
            />
          </Field>
        )}
        {needsSecret && (
          <Field
            label="Token"
            hint={
              kind === 'github'
                ? 'A read-only personal access token for this host. Stored in the OS keychain and never shown again.'
                : 'Stored in the OS keychain and never shown again.'
            }
          >
            <input
              type="password"
              required
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              autoComplete="new-password"
              className={`w-full ${inputClass}`}
            />
          </Field>
        )}
        <ProjectChecks projects={projects} value={projectIds} onChange={setProjectIds} />
        <Field
          label="First sync reaches back to"
          hint="Optional. Default: the source's own limit (GitHub: 90 days)."
        >
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className={inputClass}
          />
        </Field>
        {add.error && <ErrorNote error={add.error} />}
        <Button type="submit" variant="primary" disabled={add.isPending}>
          {add.isPending ? 'Connecting…' : 'Connect'}
        </Button>
      </form>
    </Panel>
  );
}

function ConnectorCard({ c, onSyncQueued }: { c: ConnectorView; onSyncQueued: () => void }) {
  const { projects } = useProject();
  const invalidate = useInvalidate();
  const [mode, setMode] = useState<'view' | 'edit' | 'token' | 'backfill'>('view');
  const slugs = useMemo(() => new Map(projects.map((p) => [p.id, p.slug])), [projects]);

  const sync = useMutation({
    mutationFn: (backfillFrom?: string) =>
      api.syncConnector(c.id, backfillFrom ? { backfillFrom } : {}),
    onSuccess: () => {
      onSyncQueued();
      setMode('view');
      return invalidate('connectors', 'days', 'day');
    },
  });
  const remove = useMutation({
    mutationFn: () => api.removeConnector(c.id),
    onSuccess: () => invalidate('connectors'),
  });

  return (
    <Panel>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">
            {c.displayName} <Badge tone={statusTone(c.status)}>{c.status}</Badge>
          </h2>
          <p className="text-sm text-muted">
            {c.source} · feeds{' '}
            {c.projectIds.length
              ? c.projectIds.map((p) => `#${slugs.get(p) ?? '?'}`).join(' ')
              : 'the Inbox'}
            {c.hasSecret ? ' · token stored' : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => sync.mutate(undefined)}
            disabled={sync.isPending || c.status === 'running'}
          >
            {sync.isPending || c.status === 'running' ? 'Syncing…' : 'Sync now'}
          </Button>
          <Button onClick={() => setMode(mode === 'backfill' ? 'view' : 'backfill')}>
            Backfill…
          </Button>
          <Button onClick={() => setMode(mode === 'edit' ? 'view' : 'edit')}>Edit</Button>
          <Button onClick={() => setMode(mode === 'token' ? 'view' : 'token')}>
            Replace token
          </Button>
          <ConfirmButton
            label="Disconnect"
            confirm="Click again to disconnect"
            disabled={remove.isPending}
            onConfirm={() => remove.mutate()}
          />
        </div>
      </div>
      {[sync.error, remove.error].map((e, i) =>
        // biome-ignore lint/suspicious/noArrayIndexKey: two fixed slots
        e ? <ErrorNote key={i} error={e} /> : null,
      )}
      {alreadyRunning(sync.data) && (
        <p className="mt-2 text-sm text-muted">
          A sync for this account is already queued or running.
        </p>
      )}

      {c.streams.length > 0 && (
        <table className="mt-3 w-full text-left text-sm">
          <thead className="text-xs text-muted">
            <tr>
              <th className="py-1 font-normal">Stream</th>
              <th className="py-1 font-normal">Last success</th>
              <th className="py-1 font-normal">History from</th>
              <th className="py-1 font-normal">Last error</th>
            </tr>
          </thead>
          <tbody>
            {c.streams.map((s) => (
              <tr key={s.stream} className="border-t border-line align-top">
                <td className="py-1 font-mono text-xs">{s.stream}</td>
                <td className="py-1">{when(s.lastSuccessAt)}</td>
                <td className="py-1">{s.historyFloor ? s.historyFloor.slice(0, 10) : '—'}</td>
                <td className="py-1 text-warn">{s.lastError ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {c.streams.length === 0 && <p className="mt-3 text-sm text-muted">Not synced yet.</p>}

      {mode === 'edit' && <EditConnector c={c} onDone={() => setMode('view')} />}
      {mode === 'token' && <ReplaceToken id={c.id} onDone={() => setMode('view')} />}
      {mode === 'backfill' && (
        <Backfill
          onRun={(d) => sync.mutate(d)}
          pending={sync.isPending}
          onCancel={() => setMode('view')}
        />
      )}
    </Panel>
  );
}

function EditConnector({ c, onDone }: { c: ConnectorView; onDone: () => void }) {
  const { projects } = useProject();
  const invalidate = useInvalidate();
  const [name, setName] = useState(c.displayName);
  const specs = FORMS[c.kind];
  const [form, setForm] = useState<FormValues>(() => formFromConfig(specs ?? [], c.config));
  const [raw, setRaw] = useState(JSON.stringify(c.config, null, 2));
  const [projectIds, setProjectIds] = useState(c.projectIds);
  const save = useMutation({
    mutationFn: () =>
      api.updateConnector(c.id, {
        displayName: name,
        config: specs
          ? configFromForm(specs, form, c.config)
          : (JSON.parse(raw) as Record<string, unknown>),
        projectIds,
      }),
    onSuccess: () => {
      onDone();
      return invalidate('connectors');
    },
  });
  return (
    <form
      className="mt-4 space-y-3 border-t border-line pt-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Field label="Name">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={`w-full ${inputClass}`}
        />
      </Field>
      {specs ? (
        <KindFields specs={specs} form={form} set={setForm} editing />
      ) : (
        <Field label="Config (JSON)">
          <textarea
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            rows={6}
            className={`w-full font-mono ${inputClass}`}
          />
        </Field>
      )}
      <ProjectChecks projects={projects} value={projectIds} onChange={setProjectIds} />
      {save.error && <ErrorNote error={save.error} />}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={save.isPending}>
          Save
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function ReplaceToken({ id, onDone }: { id: string; onDone: () => void }) {
  const invalidate = useInvalidate();
  const [secret, setSecret] = useState('');
  const save = useMutation({
    mutationFn: () => api.replaceSecret(id, secret.trim()),
    onSuccess: () => {
      setSecret('');
      onDone();
      return invalidate('connectors');
    },
  });
  return (
    <form
      className="mt-4 flex flex-wrap items-end gap-2 border-t border-line pt-4"
      autoComplete="off"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Field label="New token" hint="Replaces the stored one in the OS keychain.">
        <input
          type="password"
          required
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          autoComplete="new-password"
          className={`w-72 ${inputClass}`}
        />
      </Field>
      <Button type="submit" variant="primary" disabled={save.isPending || !secret.trim()}>
        Save token
      </Button>
      <Button variant="ghost" onClick={onDone}>
        Cancel
      </Button>
      {save.error && <ErrorNote error={save.error} />}
    </form>
  );
}

function Backfill({
  onRun,
  pending,
  onCancel,
}: {
  onRun: (from: string) => void;
  pending: boolean;
  onCancel: () => void;
}) {
  const [from, setFrom] = useState('');
  return (
    <form
      className="mt-4 flex flex-wrap items-end gap-2 border-t border-line pt-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (from) onRun(from);
      }}
    >
      <Field
        label="Collect history from"
        hint="Streams that haven't synced yet start here; search streams can reach years back."
      >
        <input
          type="date"
          required
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className={inputClass}
        />
      </Field>
      <Button type="submit" variant="primary" disabled={pending || !from}>
        Start backfill
      </Button>
      <Button variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </form>
  );
}

// ------------------------------------------------------------------------------------------
// Projects
// ------------------------------------------------------------------------------------------

function Projects() {
  const { projects } = useProject();
  const ws = useQuery({ queryKey: ['workspace'], queryFn: api.workspace });
  const invalidate = useInvalidate();
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [tz, setTz] = useState('');
  const create = useMutation({
    mutationFn: () =>
      api.createProject({
        slug: slug.trim().toLowerCase(),
        name: name.trim(),
        ...(tz ? { timeZone: tz } : {}),
      }),
    onSuccess: () => {
      setSlug('');
      setName('');
      setTz('');
      return invalidate('me');
    },
  });

  return (
    <div className="space-y-4">
      {projects.map((p) => (
        <ProjectRow key={p.id} p={p} workspaceTz={ws.data?.timeZone ?? ''} />
      ))}
      {ws.data?.isOwner && (
        <Panel>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <h2 className="font-semibold">New project</h2>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Slug" hint="Used in notes as #slug">
                <input
                  required
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  placeholder="sdk"
                  className={`w-full ${inputClass}`}
                />
              </Field>
              <Field label="Name">
                <input
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className={`w-full ${inputClass}`}
                />
              </Field>
              <Field label="Time zone" hint="Empty: the workspace's">
                <TimeZoneInput
                  id="new-project"
                  value={tz}
                  onChange={setTz}
                  placeholder={ws.data?.timeZone}
                />
              </Field>
            </div>
            {create.error && <ErrorNote error={create.error} />}
            <Button type="submit" variant="primary" disabled={create.isPending}>
              Create project
            </Button>
          </form>
        </Panel>
      )}
    </div>
  );
}

function ProjectRow({ p, workspaceTz }: { p: ProjectView; workspaceTz: string }) {
  const invalidate = useInvalidate();
  const [name, setName] = useState(p.name);
  const [tz, setTz] = useState(p.timeZone === workspaceTz ? '' : p.timeZone);
  const [vis, setVis] = useState(p.defaultNoteVisibility);
  const canEdit = p.role === 'owner' || p.role === 'manager';
  const save = useMutation({
    mutationFn: () =>
      api.updateProject(p.id, {
        name: name.trim(),
        timeZone: tz.trim() || null,
        defaultNoteVisibility: vis,
      }),
    onSuccess: () => invalidate('me', 'days', 'day'),
  });
  const archive = useMutation({
    mutationFn: () => api.archiveProject(p.id),
    onSuccess: () => invalidate('me'),
  });
  const dirty =
    name !== p.name || (tz || workspaceTz) !== p.timeZone || vis !== p.defaultNoteVisibility;

  return (
    <Panel>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">
            #{p.slug} <Badge>{p.role}</Badge>
          </h2>
          {p.role === 'owner' && (
            <ConfirmButton
              label="Archive"
              confirm="Click again to archive"
              disabled={archive.isPending}
              onConfirm={() => archive.mutate()}
            />
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Name">
            <input
              disabled={!canEdit}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={`w-full ${inputClass}`}
            />
          </Field>
          <Field
            label="Time zone"
            hint="Decides day boundaries. Existing records keep their dates."
          >
            <TimeZoneInput
              id={`tz-${p.id}`}
              value={tz}
              onChange={setTz}
              placeholder={`${workspaceTz} (workspace)`}
            />
          </Field>
          <Field label="New notes are">
            <select
              disabled={!canEdit}
              value={vis}
              onChange={(e) => setVis(e.target.value as ProjectView['defaultNoteVisibility'])}
              className={`w-full ${inputClass}`}
            >
              <option value="private">private (only you)</option>
              <option value="project">visible to the project</option>
            </select>
          </Field>
        </div>
        {[save.error, archive.error].map((e, i) =>
          // biome-ignore lint/suspicious/noArrayIndexKey: two fixed slots
          e ? <ErrorNote key={i} error={e} /> : null,
        )}
        {canEdit && (
          <Button type="submit" variant="primary" disabled={!dirty || save.isPending}>
            {save.isSuccess && !dirty ? 'Saved' : 'Save'}
          </Button>
        )}
      </form>
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------
// Workspace
// ------------------------------------------------------------------------------------------

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function Workspace() {
  const ws = useQuery({ queryKey: ['workspace'], queryFn: api.workspace });
  if (ws.error) return <ErrorNote error={ws.error} />;
  if (!ws.data) return <Empty>Loading…</Empty>;
  return <WorkspaceForm key={JSON.stringify(ws.data)} ws={ws.data} />;
}

function WorkspaceForm({ ws }: { ws: NonNullable<Awaited<ReturnType<typeof api.workspace>>> }) {
  const invalidate = useInvalidate();
  const [name, setName] = useState(ws.name);
  const [tz, setTz] = useState(ws.timeZone);
  const [weekStart, setWeekStart] = useState(ws.weekStart);
  const [anchor, setAnchor] = useState(ws.biweeklyAnchor);
  const save = useMutation({
    mutationFn: () =>
      api.updateWorkspace({
        name: name.trim(),
        timeZone: tz.trim(),
        weekStart,
        biweeklyAnchor: anchor,
      }),
    onSuccess: () => invalidate('workspace', 'me'),
  });
  return (
    <Panel>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <h2 className="font-semibold">
          Workspace <Badge>{ws.domain}</Badge>
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Name">
            <input
              disabled={!ws.isOwner}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={`w-full ${inputClass}`}
            />
          </Field>
          <Field
            label="Time zone"
            hint="Projects without their own use this; so does the morning run."
          >
            <TimeZoneInput id="ws-tz" value={tz} onChange={setTz} />
          </Field>
          <Field label="Week starts on">
            <select
              disabled={!ws.isOwner}
              value={weekStart}
              onChange={(e) => setWeekStart(Number(e.target.value))}
              className={`w-full ${inputClass}`}
            >
              {WEEKDAYS.map((d, i) => (
                <option key={d} value={i + 1}>
                  {d}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Bi-weekly anchor" hint="Any day in the first week of a two-week pair.">
            <input
              type="date"
              required
              disabled={!ws.isOwner}
              value={anchor}
              onChange={(e) => setAnchor(e.target.value)}
              className={`w-full ${inputClass}`}
            />
          </Field>
        </div>
        <p className="text-xs text-muted">
          The morning run's schedule follows the time zone after a hub restart.
        </p>
        {save.error && <ErrorNote error={save.error} />}
        {ws.isOwner && (
          <Button type="submit" variant="primary" disabled={save.isPending}>
            Save
          </Button>
        )}
      </form>
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------
// Identities
// ------------------------------------------------------------------------------------------

function Identities() {
  const ids = useQuery({ queryKey: ['identities'], queryFn: api.identities });
  const connectors = useQuery({ queryKey: ['connectors'], queryFn: api.connectors });
  const invalidate = useInvalidate();
  const sources = [...new Set((connectors.data?.items ?? []).map((c) => c.source))];
  const [source, setSource] = useState('');
  const [login, setLogin] = useState('');
  const [aliases, setAliases] = useState('');
  const add = useMutation({
    mutationFn: () =>
      api.addIdentity({ source: source.trim(), accountKey: login.trim(), aliases: list(aliases) }),
    onSuccess: () => {
      setLogin('');
      setAliases('');
      return invalidate('identities');
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.removeIdentity(id),
    onSuccess: () => invalidate('identities'),
  });
  const bySource = new Map<string, IdentityView[]>();
  for (const i of ids.data?.items ?? [])
    bySource.set(i.source, [...(bySource.get(i.source) ?? []), i]);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        Your accounts in each source decide what counts as yours: commit authors, reviewers,
        commenters. Add every name and email your commits use as aliases.
      </p>
      {ids.error && <ErrorNote error={ids.error} />}
      {remove.error && <ErrorNote error={remove.error} />}
      {[...bySource.entries()].map(([src, items]) => (
        <Panel key={src}>
          <h2 className="mb-2 font-mono text-sm">{src}</h2>
          <ul className="divide-y divide-line">
            {items.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span>
                  <span className="font-medium">{i.accountKey}</span>
                  {i.aliases.length > 0 && (
                    <span className="text-muted"> · {i.aliases.join(', ')}</span>
                  )}
                </span>
                <ConfirmButton
                  label="Remove"
                  confirm="Click again"
                  onConfirm={() => remove.mutate(i.id)}
                />
              </li>
            ))}
          </ul>
        </Panel>
      ))}
      {ids.data?.items.length === 0 && (
        <Panel>
          <Empty>No identities yet. Connecting GitHub adds your login automatically.</Empty>
        </Panel>
      )}
      <Panel>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <h2 className="font-semibold">Add an identity</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Source" hint="e.g. github:github.com">
              <input
                required
                list="identity-sources"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                className={`w-full ${inputClass}`}
              />
              <datalist id="identity-sources">
                {sources.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </Field>
            <Field label="Login">
              <input
                required
                value={login}
                onChange={(e) => setLogin(e.target.value)}
                className={`w-full ${inputClass}`}
              />
            </Field>
            <Field label="Aliases" hint="Names and emails, comma-separated">
              <input
                value={aliases}
                onChange={(e) => setAliases(e.target.value)}
                className={`w-full ${inputClass}`}
              />
            </Field>
          </div>
          {add.error && <ErrorNote error={add.error} />}
          <Button type="submit" variant="primary" disabled={add.isPending}>
            Add
          </Button>
        </form>
      </Panel>
    </div>
  );
}

// ------------------------------------------------------------------------------------------
// Project rules (spec §8.4)
// ------------------------------------------------------------------------------------------

const MATCH_FIELDS: {
  key: 'source' | 'repo' | 'project' | 'space' | 'titleContains';
  label: string;
  hint: string;
}[] = [
  { key: 'source', label: 'Source', hint: 'e.g. github:* or jira:jira.example.com' },
  { key: 'repo', label: 'GitHub repo', hint: 'e.g. acme/cli or acme/*' },
  { key: 'project', label: 'Jira project', hint: 'e.g. PROJ' },
  { key: 'space', label: 'Confluence space', hint: 'e.g. ENG' },
  { key: 'titleContains', label: 'Title contains', hint: 'Plain text, any case' },
];

type MatchForm = Record<(typeof MATCH_FIELDS)[number]['key'], string>;
const emptyMatch: MatchForm = { source: '', repo: '', project: '', space: '', titleContains: '' };

const matchOf = (f: MatchForm): RuleMatch =>
  Object.fromEntries(
    Object.entries(f)
      .map(([k, v]) => [k, v.trim()])
      .filter(([, v]) => v),
  ) as RuleMatch;

const describeMatch = (m: RuleMatch) =>
  Object.entries(m)
    .map(([k, v]) => `${k} ${Array.isArray(v) ? v.join('|') : v}`)
    .join(' · ');

function Rules() {
  const { projects } = useProject();
  const invalidate = useInvalidate();
  const rules = useQuery({ queryKey: ['rules'], queryFn: api.rules });
  const slugs = new Map(projects.map((p) => [p.id, p.slug]));
  const manageable = projects.filter((p) => p.role === 'owner' || p.role === 'manager');
  const [form, setForm] = useState<MatchForm>(emptyMatch);
  const [projectId, setProjectId] = useState(manageable[0]?.id ?? '');
  const match = matchOf(form);
  const hasMatch = Object.keys(match).length > 0;

  const preview = useQuery({
    queryKey: ['rule-preview', JSON.stringify(match)],
    queryFn: () => api.previewRule(match),
    enabled: hasMatch,
  });
  const create = useMutation({
    mutationFn: () => api.createRule({ projectId, match }),
    onSuccess: () => {
      setForm(emptyMatch);
      return invalidate('rules');
    },
  });
  const apply = useMutation({
    mutationFn: api.applyRules,
    onSuccess: () => invalidate('inbox', 'days', 'day', 'rule-preview'),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">
          Rules file incoming records into projects, first match wins (lowest priority first). They
          apply to new records from connectors, ahead of an account's own project. Anything no rule
          matches goes to the Inbox.
        </p>
        <Button onClick={() => apply.mutate()} disabled={apply.isPending}>
          Run the Inbox through the rules
        </Button>
      </div>
      {apply.error && <ErrorNote error={apply.error} />}
      {apply.data && (
        <p className="text-sm text-muted">
          Filed {apply.data.routed} Inbox record{apply.data.routed === 1 ? '' : 's'}.
        </p>
      )}
      {rules.error && <ErrorNote error={rules.error} />}
      {rules.data?.items.length === 0 && (
        <Panel>
          <Empty>No rules yet.</Empty>
        </Panel>
      )}
      {rules.data && rules.data.items.length > 0 && (
        <Panel>
          <ul className="divide-y divide-line">
            {rules.data.items.map((r) => (
              <RuleRowView
                key={`${r.id}:${r.version}`}
                r={r}
                slug={slugs.get(r.projectId) ?? '?'}
              />
            ))}
          </ul>
        </Panel>
      )}
      {manageable.length > 0 && (
        <Panel>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <h2 className="font-semibold">New rule</h2>
            <div className="grid gap-3 sm:grid-cols-3">
              {MATCH_FIELDS.map((f) => (
                <Field key={f.key} label={f.label} hint={f.hint}>
                  <input
                    value={form[f.key]}
                    onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                    className={`w-full ${inputClass}`}
                  />
                </Field>
              ))}
              <Field label="File into">
                <select
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                  className={`w-full ${inputClass}`}
                >
                  {manageable.map((p) => (
                    <option key={p.id} value={p.id}>
                      #{p.slug}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            {hasMatch && (
              <div className="rounded-md border border-line p-3 text-sm">
                {preview.isPending ? (
                  <span className="text-muted">Checking the Inbox…</span>
                ) : preview.error ? (
                  <ErrorNote error={preview.error} />
                ) : (
                  <>
                    <p className="text-muted">
                      Matches {preview.data?.total ?? 0} record
                      {preview.data?.total === 1 ? '' : 's'} in your Inbox now.
                    </p>
                    <ul className="mt-1 space-y-0.5">
                      {preview.data?.matches.slice(0, 8).map((m) => (
                        <li key={m.id} className="truncate">
                          <span className="text-muted">{m.applicableDate}</span> {m.title}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}
            {create.error && <ErrorNote error={create.error} />}
            <Button
              type="submit"
              variant="primary"
              disabled={!hasMatch || !projectId || create.isPending}
            >
              Add rule
            </Button>
          </form>
        </Panel>
      )}
    </div>
  );
}

function RuleRowView({ r, slug }: { r: RuleView; slug: string }) {
  const invalidate = useInvalidate();
  const [priority, setPriority] = useState(String(r.priority));
  const save = useMutation({
    mutationFn: () => api.updateRule(r, { priority: Number(priority) }),
    onSuccess: () => invalidate('rules'),
  });
  const remove = useMutation({
    mutationFn: () => api.removeRule(r),
    onSuccess: () => invalidate('rules'),
  });
  return (
    <li className="flex flex-wrap items-center gap-3 py-2 text-sm">
      <input
        aria-label="Priority"
        type="number"
        value={priority}
        onChange={(e) => setPriority(e.target.value)}
        onBlur={() => Number(priority) !== r.priority && save.mutate()}
        className={`w-20 ${inputClass}`}
      />
      <span className="flex-1">
        {describeMatch(r.match)} → <span className="font-medium">#{slug}</span>
      </span>
      <ConfirmButton label="Remove" confirm="Click again" onConfirm={() => remove.mutate()} />
      {[save.error, remove.error].map((e, i) =>
        // biome-ignore lint/suspicious/noArrayIndexKey: two fixed slots
        e ? <ErrorNote key={i} error={e} /> : null,
      )}
    </li>
  );
}

// ------------------------------------------------------------------------------------------
// AI: the key for direct report generation (plan.md M4)
// ------------------------------------------------------------------------------------------

function Ai() {
  const invalidate = useInvalidate();
  const ai = useQuery({ queryKey: ['ai'], queryFn: api.ai });
  const [key, setKey] = useState('');
  const save = useMutation({
    mutationFn: () => api.setAiKey(key.trim()),
    onSuccess: () => {
      setKey('');
      return invalidate('ai');
    },
  });
  const remove = useMutation({ mutationFn: api.removeAiKey, onSuccess: () => invalidate('ai') });
  return (
    <Panel>
      <h2 className="font-semibold">Claude API key</h2>
      <p className="mt-1 text-sm text-muted">
        With a key, the hub writes reports itself (Generate, Regenerate, Write all due reports),
        from the same evidence and through the same checks as an agent. Without one, reports come
        from your agent over MCP.
      </p>
      {ai.error && <ErrorNote error={ai.error} />}
      {ai.data && (
        <p className="mt-3 text-sm">
          {ai.data.hasKey ? <Badge tone="accent">key stored</Badge> : <Badge>no key</Badge>}{' '}
          <span className="text-muted">
            Model: <code className="font-mono">{ai.data.model}</code> (set HUB_MODEL to change)
          </span>
        </p>
      )}
      <form
        className="mt-3 flex flex-wrap items-end gap-2"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field
          label={ai.data?.hasKey ? 'Replace the key' : 'API key'}
          hint="Kept in the OS keychain and never shown again."
        >
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            autoComplete="new-password"
            placeholder="sk-ant-…"
            className={`w-80 ${inputClass}`}
          />
        </Field>
        <Button type="submit" variant="primary" disabled={!key.trim() || save.isPending}>
          Save key
        </Button>
        {ai.data?.hasKey && (
          <ConfirmButton
            label="Remove key"
            confirm="Click again to remove"
            onConfirm={() => remove.mutate()}
          />
        )}
      </form>
      {(save.error || remove.error) && <ErrorNote error={save.error ?? remove.error} />}
    </Panel>
  );
}
