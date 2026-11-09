// A line diff of two report bodies (LCS), for comparing a version with the one before.

type Op = { kind: 'same' | 'add' | 'del'; text: string };

const strip = (s: string) => s.replace(/\s*\[\[[rwvs]:[^\]]+\]\]/g, '');

export function lineDiff(before: string, after: string): Op[] {
  const a = strip(before).split('\n');
  const b = strip(after).split('\n');
  const w = b.length + 1;
  const dp = new Int32Array((a.length + 1) * w);
  const at = (i: number, j: number) => dp[i * w + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const out: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] ?? '' });
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      out.push({ kind: 'del', text: a[i] ?? '' });
      i++;
    } else {
      out.push({ kind: 'add', text: b[j] ?? '' });
      j++;
    }
  }
  for (; i < a.length; i++) out.push({ kind: 'del', text: a[i] ?? '' });
  for (; j < b.length; j++) out.push({ kind: 'add', text: b[j] ?? '' });
  return out;
}

export function Diff({ before, after }: { before: string; after: string }) {
  const ops = lineDiff(before, after);
  if (!ops.some((o) => o.kind !== 'same')) {
    return <p className="text-sm text-muted">No text changes (only citations or metadata).</p>;
  }
  return (
    <pre className="overflow-x-auto rounded-md border border-line bg-bg p-2 text-xs leading-5">
      {ops.map((o, k) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: a static rendering of one diff
          key={k}
          className={
            o.kind === 'add'
              ? 'text-accent'
              : o.kind === 'del'
                ? 'text-warn line-through opacity-70'
                : 'text-muted'
          }
        >
          {o.kind === 'add' ? '+ ' : o.kind === 'del' ? '- ' : '  '}
          {o.text}
        </div>
      ))}
    </pre>
  );
}
