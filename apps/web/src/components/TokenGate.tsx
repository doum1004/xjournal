import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { tokenStore } from '../api';
import { Button, inputClass, Panel } from './ui';

/** Asks for the per-install token (HUB_LOCAL_TOKEN in .env) when the hub answers 401. */
export function TokenGate() {
  const [value, setValue] = useState('');
  const qc = useQueryClient();
  return (
    <div className="mx-auto mt-24 max-w-md px-4">
      <Panel>
        <h1 className="text-lg font-semibold">Connect to your hub</h1>
        <p className="mt-1 text-sm text-muted">
          Paste the local token, <code className="font-mono">HUB_LOCAL_TOKEN</code> from your{' '}
          <code className="font-mono">.env</code>. It is kept in this browser only.
        </p>
        <form
          className="mt-4 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!value.trim()) return;
            tokenStore.set(value.trim());
            qc.resetQueries();
          }}
        >
          <input
            type="password"
            autoComplete="off"
            aria-label="Local token"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className={`min-w-0 flex-1 ${inputClass}`}
          />
          <Button type="submit" variant="primary">
            Connect
          </Button>
        </form>
      </Panel>
    </div>
  );
}
