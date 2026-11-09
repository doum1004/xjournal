import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
  useNavigate,
} from '@tanstack/react-router';
import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiError, api } from './api';
import { QuickAdd } from './components/QuickAdd';
import { TokenGate } from './components/TokenGate';
import { Button, ErrorNote, inputClass, Panel } from './components/ui';
import { isIsoDate } from './dates';
import { DayPage } from './pages/Day';
import { InboxPage } from './pages/Inbox';
import { RecordPage } from './pages/Record';
import { SearchPage, type SearchParams } from './pages/Search';
import { SettingsPage, type SettingsTab, settingsTabs } from './pages/Settings';
import { TimelinePage } from './pages/Timeline';
import { ProjectProvider, useProject } from './project';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A 401 or 404 won't fix itself on retry.
      retry: (n, err) => !(err instanceof ApiError && err.status < 500) && n < 2,
      staleTime: 30_000,
    },
  },
});

// ------------------------------------------------------------------------------------------
// Layout
// ------------------------------------------------------------------------------------------

let openQuickAdd: (prefill?: string) => void = () => {};

function Layout() {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const [quick, setQuick] = useState<{ open: boolean; prefill: string }>({
    open: false,
    prefill: '',
  });
  const open = useCallback((prefill = '') => setQuick({ open: true, prefill }), []);
  openQuickAdd = open;

  useEffect(() => {
    // "n" opens quick-add from anywhere except while typing (spec §3.6: a global shortcut).
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key !== 'n' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
      e.preventDefault();
      open();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (me.error instanceof ApiError && me.error.status === 401) return <TokenGate />;
  if (me.error instanceof ApiError && me.error.code === 'not_initialized') {
    return (
      <div className="mx-auto mt-24 max-w-md px-4">
        <Panel>
          <h1 className="text-lg font-semibold">Set up the hub first</h1>
          <p className="mt-1 text-sm text-muted">
            Run <code className="font-mono">bun run hub init</code>, then reload this page.
          </p>
        </Panel>
      </div>
    );
  }

  return (
    <ProjectProvider>
      <div className="min-h-screen">
        <Header onAdd={() => open()} />
        <main className="mx-auto max-w-5xl px-4 py-6">
          {me.error ? <ErrorNote error={me.error} /> : <Outlet />}
        </main>
      </div>
      <QuickAdd
        open={quick.open}
        prefill={quick.prefill}
        onClose={() => setQuick({ open: false, prefill: '' })}
      />
    </ProjectProvider>
  );
}

function Header({ onAdd }: { onAdd: () => void }) {
  const { projects, project, setProjectId } = useProject();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const nav =
    'rounded-md px-2 py-1 text-sm text-muted hover:text-ink [&.active]:font-semibold [&.active]:text-ink';
  return (
    <header className="border-b border-line bg-panel">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <Link to="/" search={{}} className="font-semibold tracking-tight">
          xjournal
        </Link>
        <nav className="flex gap-1">
          <Link
            to="/"
            search={{}}
            className={nav}
            activeOptions={{ exact: true, includeSearch: false }}
          >
            Timeline
          </Link>
          <Link to="/inbox" className={nav}>
            Inbox
          </Link>
          <Link to="/search" search={{ q: '' }} className={nav}>
            Search
          </Link>
          <Link to="/settings" search={{ tab: 'connectors' }} className={nav}>
            Settings
          </Link>
        </nav>
        <form
          aria-label="Search"
          className="ml-auto flex min-w-0 flex-1 justify-end gap-2 sm:flex-none"
          onSubmit={(e) => {
            e.preventDefault();
            if (q.trim()) navigate({ to: '/search', search: { q: q.trim() } });
          }}
        >
          <input
            type="search"
            aria-label="Quick search"
            placeholder="Search…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className={`w-full min-w-0 sm:w-48 ${inputClass}`}
          />
        </form>
        {projects.length > 0 && (
          <select
            aria-label="Project"
            value={project?.id}
            onChange={(e) => setProjectId(e.target.value)}
            className={inputClass}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                #{p.slug}
              </option>
            ))}
          </select>
        )}
        <Button variant="primary" onClick={onAdd} title="Add a note (n)">
          + Note
        </Button>
      </div>
    </header>
  );
}

// ------------------------------------------------------------------------------------------
// Routes
// ------------------------------------------------------------------------------------------

const rootRoute = createRootRoute({ component: Layout });

const timelineRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  validateSearch: (s: Record<string, unknown>): { year?: number } => {
    const y = Number(s.year);
    return Number.isInteger(y) && y > 1990 && y < 3000 ? { year: y } : {};
  },
  component: function Timeline() {
    const { year } = timelineRoute.useSearch();
    return <TimelinePage year={year ?? new Date().getFullYear()} />;
  },
});

const dayRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/day/$date',
  component: function Day() {
    const { date } = dayRoute.useParams();
    if (!isIsoDate(date)) return <ErrorNote error="Expected a date as YYYY-MM-DD" />;
    return <DayPage date={date} onAddNote={(p) => openQuickAdd(p)} />;
  },
});

const recordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/records/$id',
  component: function Record() {
    const { id } = recordRoute.useParams();
    return <RecordPage id={id} />;
  },
});

const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/inbox',
  component: InboxPage,
});

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/search',
  validateSearch: (s: Record<string, unknown>): SearchParams => ({
    q: typeof s.q === 'string' ? s.q : '',
    ...(str(s.project) ? { project: str(s.project) } : {}),
    ...(isIsoDate(s.from) ? { from: s.from } : {}),
    ...(isIsoDate(s.to) ? { to: s.to } : {}),
  }),
  component: function Search() {
    const params = searchRoute.useSearch();
    // Remount when the query changes, so the form fields follow the URL.
    return <SearchPage key={JSON.stringify(params)} params={params} />;
  },
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  validateSearch: (s: Record<string, unknown>): { tab: SettingsTab } => ({
    tab: settingsTabs.includes(s.tab as SettingsTab) ? (s.tab as SettingsTab) : 'connectors',
  }),
  component: function Settings() {
    const { tab } = settingsRoute.useSearch();
    const navigate = useNavigate();
    return (
      <SettingsPage tab={tab} onTab={(t) => navigate({ to: '/settings', search: { tab: t } })} />
    );
  },
});

const router = createRouter({
  routeTree: rootRoute.addChildren([
    timelineRoute,
    dayRoute,
    recordRoute,
    inboxRoute,
    searchRoute,
    settingsRoute,
  ]),
  defaultNotFoundComponent: () => <Panel>Page not found.</Panel>,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
