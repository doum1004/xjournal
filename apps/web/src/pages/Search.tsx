import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { api } from '../api';
import { RecordItem } from '../components/RecordItem';
import { Button, Empty, ErrorNote, inputClass, Panel } from '../components/ui';
import { useProject } from '../project';

// Full-text search (api.md §3.3, mode `text`). Filters live in the URL so results can be bookmarked.

export interface SearchParams {
  q: string;
  project?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

export function SearchPage({ params }: { params: SearchParams }) {
  const { projects } = useProject();
  const navigate = useNavigate();
  const [q, setQ] = useState(params.q);
  const [project, setProject] = useState(params.project ?? '');
  const [from, setFrom] = useState(params.from ?? '');
  const [to, setTo] = useState(params.to ?? '');

  const projectId = projects.find((p) => p.slug === params.project)?.id;
  const results = useInfiniteQuery({
    queryKey: ['search', params],
    queryFn: ({ pageParam }) =>
      api.search({
        q: params.q,
        ...(projectId ? { projectId } : {}),
        ...(params.from ? { from: params.from } : {}),
        ...(params.to ? { to: params.to } : {}),
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: params.q.trim().length > 0,
  });
  const items = results.data?.pages.flatMap((p) => p.items) ?? [];
  const slugOf = (id: string | null) => projects.find((p) => p.id === id)?.slug;

  return (
    <Panel>
      <form
        aria-label="Search"
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          navigate({
            to: '/search',
            search: {
              q,
              ...(project ? { project } : {}),
              ...(from ? { from } : {}),
              ...(to ? { to } : {}),
            },
          });
        }}
      >
        <input
          type="search"
          aria-label="Search words"
          placeholder="Search notes and logs"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className={`min-w-0 flex-1 ${inputClass}`}
        />
        <select
          aria-label="Project"
          value={project}
          onChange={(e) => setProject(e.target.value)}
          className={inputClass}
        >
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.slug}>
              #{p.slug}
            </option>
          ))}
        </select>
        <input
          type="date"
          aria-label="From"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className={inputClass}
        />
        <input
          type="date"
          aria-label="To (exclusive)"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className={inputClass}
        />
        <Button type="submit" variant="primary">
          Search
        </Button>
      </form>

      <div className="mt-4">
        {results.error && <ErrorNote error={results.error} />}
        {!params.q.trim() ? (
          <Empty>Words match whole words; use quotes for a phrase and - to exclude.</Empty>
        ) : results.isPending ? (
          <p className="text-sm text-muted">Searching…</p>
        ) : items.length === 0 ? (
          <Empty>No matches.</Empty>
        ) : (
          <ul>
            {items.map((r) => (
              <RecordItem key={r.id} record={r} showDate projectSlug={slugOf(r.projectId)} />
            ))}
          </ul>
        )}
        {results.hasNextPage && (
          <Button onClick={() => results.fetchNextPage()} disabled={results.isFetchingNextPage}>
            Load more
          </Button>
        )}
      </div>
    </Panel>
  );
}
