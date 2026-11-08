import { defineConfig } from 'drizzle-kit';

// `bun run db:generate` diffs src/schema against drizzle/ and writes a new migration.
// RLS policies, roles and grants are hand-written SQL migrations (`--custom`), see src/rls/.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './drizzle',
  strict: true,
  verbose: true,
});
