import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConnectorKindView, ConnectorView, IdentityView, ProjectView } from '@xjournal/core';
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react';
import { alreadyRunning, api } from '../api';
import { Badge, Button, Empty, ErrorNote, inputClass, Panel } from '../components/ui';
import { useProject } from '../project';

// Settings (plan.md M2): workspace, projects, connectors and identities, all manageable
// without the CLI. Credentials are write-only: entered once, never shown again (spec §8.7).

export type SettingsTab = 'connectors' | 'projects' | 'workspace' | 'identities';
export const settingsTabs: SettingsTab[] = ['connectors', 'projects', 'workspace', 'identities'];

const TAB_LABEL: Record<SettingsTab, string> = {
  connectors: 'Connectors',
  projects: 'Projects',
  workspace: 'Workspace',
  identities: 'Identities',
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
      {tab === 'projects' && <Projects />}
      {tab === 'workspace' && <Workspace />}
      {tab === 'identities' && <Identities />}
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

interface GithubForm {
  host: string;
  login: string;
  includeOwners: string;
  excludeOwners: string;
}

const githubFromConfig = (c: Record<string, unknown>): GithubForm => ({
  host: String(c.host ?? 'github.com'),
  login: String(c.login ?? ''),
  includeOwners: ((c.includeOwners as string[] | undefined) ?? []).join(', '),
  excludeOwners: ((c.excludeOwners as string[] | undefined) ?? []).join(', '),
});

const githubToConfig = (f: GithubForm, base: Record<string, unknown> = {}) => ({
  ...base,
  host: f.host.trim(),
  login: f.login.trim(),
  includeOwners: list(f.includeOwners),
  excludeOwners: list(f.excludeOwners),
});

function GithubFields({
  form,
  set,
  lockHost,
}: {
  form: GithubForm;
  set: (f: GithubForm) => void;
  lockHost?: boolean;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Host" hint="github.com, or your GitHub Enterprise host">
        <input
          required
          disabled={lockHost}
          value={form.host}
          onChange={(e) => set({ ...form, host: e.target.value })}
          className={`w-full ${inputClass}`}
        />
      </Field>
      <Field label="Login" hint="Your username on that host">
        <input
          required
          value={form.login}
          onChange={(e) => set({ ...form, login: e.target.value })}
          className={`w-full ${inputClass}`}
        />
      </Field>
      <Field label="Only these owners" hint="Users or orgs, comma-separated. Empty: all.">
        <input
          value={form.includeOwners}
          onChange={(e) => set({ ...form, includeOwners: e.target.value })}
          placeholder="acme, acme-labs"
          className={`w-full ${inputClass}`}
        />
      </Field>
      <Field label="Never these owners" hint="e.g. your personal account">
        <input
          value={form.excludeOwners}
          onChange={(e) => set({ ...form, excludeOwners: e.target.value })}
          className={`w-full ${inputClass}`}
        />
      </Field>
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
  const [gh, setGh] = useState<GithubForm>(githubFromConfig({}));
  const [rawConfig, setRawConfig] = useState('{}');
  const [secret, setSecret] = useState('');
  const [projectIds, setProjectIds] = useState<string[]>(projects[0] ? [projects[0].id] : []);
  const [from, setFrom] = useState('');
  const desc = kinds.find((k) => k.kind === kind);
  const needsSecret = desc ? !desc.authTypes.includes('none') : true;

  const add = useMutation({
    mutationFn: () => {
      let config: Record<string, unknown>;
      if (kind === 'github') config = githubToConfig(gh);
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
              onChange={(e) => setKind(e.target.value)}
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
        {kind === 'github' ? (
          <GithubFields form={gh} set={setGh} />
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
  const [gh, setGh] = useState(githubFromConfig(c.config));
  const [raw, setRaw] = useState(JSON.stringify(c.config, null, 2));
  const [projectIds, setProjectIds] = useState(c.projectIds);
  const save = useMutation({
    mutationFn: () =>
      api.updateConnector(c.id, {
        displayName: name,
        config:
          c.kind === 'github'
            ? githubToConfig(gh, c.config)
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
      {c.kind === 'github' ? (
        <GithubFields form={gh} set={setGh} lockHost />
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
  const save = useMutation({
    mutationFn: () => api.updateWorkspace({ name: name.trim(), timeZone: tz.trim(), weekStart }),
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
        <div className="grid gap-3 sm:grid-cols-3">
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
