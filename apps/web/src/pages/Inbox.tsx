import { useInfiniteQuery } from '@tanstack/react-query';
import { api } from '../api';
import { RecordItem } from '../components/RecordItem';
import { Button, Empty, ErrorNote, Panel } from '../components/ui';
import { RouteForm } from './Record';

// Inbox (spec §3.6): notes and records without a confident project, sorted with one click.

export function InboxPage() {
  const inbox = useInfiniteQuery({
    queryKey: ['inbox'],
    queryFn: ({ pageParam }) => api.inbox(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = inbox.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <Panel>
      <h1 className="text-lg font-semibold">Inbox</h1>
      <p className="mb-3 text-sm text-muted">
        Pick a project (and a date, if needed) to file each item.
      </p>
      {inbox.error && <ErrorNote error={inbox.error} />}
      {!inbox.isPending && items.length === 0 ? (
        <Empty>Inbox is empty.</Empty>
      ) : (
        <ul>
          {items.map((r) => (
            <RecordItem key={r.id} record={r} showDate>
              <RouteForm record={r} compact />
            </RecordItem>
          ))}
        </ul>
      )}
      {inbox.hasNextPage && (
        <Button onClick={() => inbox.fetchNextPage()} disabled={inbox.isFetchingNextPage}>
          Load more
        </Button>
      )}
    </Panel>
  );
}
