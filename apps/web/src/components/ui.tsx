import type { ButtonHTMLAttributes, ReactNode } from 'react';

// Small building blocks in the shadcn/ui spirit: plain elements with consistent styling.

export function Button({
  variant = 'default',
  className = '',
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'ghost' }) {
  const styles = {
    default: 'border border-line bg-panel hover:bg-bg',
    primary: 'bg-accent text-accent-ink hover:opacity-90',
    ghost: 'hover:bg-panel',
  }[variant];
  return (
    <button
      type={type}
      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${styles} ${className}`}
      {...props}
    />
  );
}

export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-line bg-panel p-4 ${className}`}>
      {children}
    </section>
  );
}

export function Badge({
  children,
  tone = 'muted',
}: {
  children: ReactNode;
  tone?: 'muted' | 'warn' | 'accent';
}) {
  const styles = {
    muted: 'border-line text-muted',
    warn: 'border-warn/40 text-warn',
    accent: 'border-accent/40 text-accent',
  }[tone];
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-px text-xs ${styles}`}>
      {children}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-8 text-center text-sm text-muted">{children}</p>;
}

export function ErrorNote({ error }: { error: unknown }) {
  return (
    <p role="alert" className="rounded-md border border-warn/40 p-3 text-sm text-warn">
      {error instanceof Error ? error.message : String(error)}
    </p>
  );
}

export const inputClass =
  'rounded-md border border-line bg-bg px-3 py-1.5 text-sm outline-none focus:border-accent';

const URL_RE = /(https?:\/\/[^\s<>)\]]+)/g;

/** Plain text with URLs turned into links. React escapes everything else. */
export function Linkified({ text }: { text: string }) {
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <a
            // biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed string
            key={i}
            href={part}
            target="_blank"
            rel="noreferrer noopener"
            className="break-all text-accent underline underline-offset-2"
          >
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </>
  );
}
