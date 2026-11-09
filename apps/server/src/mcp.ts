import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { addDays, localDate } from '@xjournal/core';
import type { HubDb } from '@xjournal/db';
import * as svc from '@xjournal/services';
import { z } from 'zod';

// The MCP server (api.md §5): one per request, in stateless Streamable HTTP mode, so no MCP
// session lives in the hub's memory and any instance can serve any request (spec §11.4 rule 1).
// Every tool runs as the caller, through the same service operations as the REST API.

export interface McpCaller {
  /** 'local': the per-install token. 'oauth': an MCP OAuth access token (hosted). */
  via: 'local' | 'oauth';
  userId: string | null;
  scopes: string[];
  clientId?: string;
}

export interface McpDeps {
  db: HubDb;
}

export const MCP_SERVER_INFO = { name: 'xjournal', version: '0.3.0' } as const;

const INSTRUCTIONS = `xjournal: the user's activity and knowledge hub. It holds evidence (PRs, reviews, commits, issues, pages, notes), groups it into daily bundles per project, and stores cited reports.

To write reports, call get_status, then for each item in \`due\` (oldest first): get_report_inputs → write the Markdown following inputs.template.instructions, citing evidence with the tokens in inputs.refFormat → save_report with the inputHash you got. If save_report returns validation errors, fix exactly those statements and save again. Never invent evidence; leave out what the inputs don't support.

projectId accepts a project ID or slug; it defaults to the user's only (or first) project.`;

const READ = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

const json = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: (Array.isArray(value) ? { items: value } : value) as Record<string, unknown>,
});

const failure = (e: unknown) => {
  if (e instanceof svc.ServiceError) {
    const body = {
      error: e.code,
      message: e.message,
      ...(e.errors ? { errors: e.errors } : {}),
      ...(e.data ?? {}),
    };
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }],
      isError: true,
    };
  }
  throw e;
};

async function contextFor(deps: McpDeps, caller: McpCaller): Promise<svc.Ctx> {
  if (caller.via === 'local') return { db: deps.db, actor: await svc.localOwner(deps.db) };
  if (!caller.userId) throw new svc.ServiceError(401, 'unauthenticated', 'The token names no user');
  return { db: deps.db, actor: await svc.actorForUser(deps.db, caller.userId) };
}

/** A project ID or slug → the ID; none → the only (or first) project. */
async function projectIdOf(ctx: svc.Ctx, idOrSlug?: string): Promise<string> {
  const projects = await svc.listProjects(ctx);
  if (!idOrSlug) {
    const first = projects[0];
    if (!first) throw new svc.ServiceError(404, 'not_found', 'No projects yet');
    return first.id;
  }
  const p = projects.find(
    (x) => x.id === idOrSlug || x.slug === idOrSlug.replace(/^#/, '').toLowerCase(),
  );
  if (!p) throw new svc.ServiceError(404, 'not_found', `No project "${idOrSlug}"`);
  return p.id;
}

const zKind = z.enum(['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly']);
const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const zProject = z
  .string()
  .optional()
  .describe('Project ID or slug; default: the only or first project');
const zAudience = z
  .enum(['me', 'project'])
  .optional()
  .describe("'me' (default): your personal report");

function buildServer(caller: McpCaller, deps: McpDeps): McpServer {
  const server = new McpServer(MCP_SERVER_INFO, { instructions: INSTRUCTIONS });
  let ctxCache: Promise<svc.Ctx> | null = null;
  const ctx = () => {
    ctxCache ??= contextFor(deps, caller);
    return ctxCache;
  };
  const tool = <S extends z.ZodRawShape>(
    name: string,
    meta: { title: string; description: string; annotations: typeof READ | typeof WRITE },
    shape: S,
    run: (args: z.infer<z.ZodObject<S>>, c: svc.Ctx) => Promise<unknown>,
  ) =>
    server.registerTool(name, { ...meta, inputSchema: shape }, (async (
      args: z.infer<z.ZodObject<S>>,
    ) => {
      try {
        return json(await run(args, await ctx()));
      } catch (e) {
        return failure(e);
      }
    }) as never);

  server.registerTool(
    'whoami',
    {
      title: 'Who am I',
      description: 'Returns the identity this MCP connection acts as. Read-only.',
      inputSchema: {},
      annotations: READ,
    },
    async () => json({ ...caller }),
  );

  tool(
    'get_status',
    {
      title: 'Status',
      description:
        'What needs doing: `due` lists the reports to write or refresh, oldest first (missing daily reports for weekdays with evidence, stale reports, last week’s and month’s reviews), plus the Inbox count and connector health.',
      annotations: READ,
    },
    { projectId: zProject },
    async (a, c) =>
      svc.getStatus(c, a.projectId ? { projectId: await projectIdOf(c, a.projectId) } : {}),
  );

  tool(
    'get_report_inputs',
    {
      title: 'Report inputs',
      description:
        'Everything needed to write one report: the evidence (daily: the bundle’s records; weekly and up: the daily reports with their statement anchors), template and instructions, guidance, stats, gaps, and the inputHash to pass to save_report. Creates the logical report if needed.',
      annotations: WRITE,
    },
    {
      kind: zKind,
      date: zDate.describe('Any date in the period'),
      projectId: zProject,
      audience: zAudience,
    },
    async (a, c) => {
      const ref = await svc.resolveReport(c, {
        projectId: await projectIdOf(c, a.projectId),
        kind: a.kind,
        date: a.date,
        audience: a.audience ?? 'me',
      });
      return svc.getReportInputs(c, ref.reportId);
    },
  );

  tool(
    'save_report',
    {
      title: 'Save a report version',
      description:
        'Store a new version of a report. Every statement must cite its evidence ([[r:…]], [[v:…#…]], [[s:…]]); counts must cite a stat. Returns the saved version, or `validation` errors to fix (each with the statement and a hint), or stale_input when the evidence changed (get the inputs again).',
      annotations: WRITE,
    },
    {
      reportId: z.string().describe('inputs.report.reportId'),
      bodyMd: z.string(),
      inputHash: z.string().describe('inputs.inputHash'),
      changeSummary: z.string().optional().describe('Required when a previous version exists'),
      client: z.string().optional().describe('e.g. "Claude Code"'),
      model: z.string().optional(),
    },
    async (a, c) => {
      try {
        return await svc.saveReportVersion(c, a.reportId, {
          bodyMd: a.bodyMd,
          inputHash: a.inputHash,
          ...(a.changeSummary ? { changeSummary: a.changeSummary } : {}),
          generator: {
            path: 'agent',
            client: a.client ?? caller.clientId ?? 'mcp',
            ...(a.model ? { model: a.model } : {}),
          },
        });
      } catch (e) {
        if (e instanceof svc.ServiceError && e.code === 'validation_failed') {
          return { saved: false, message: e.message, validation: e.data?.validation };
        }
        throw e;
      }
    },
  );

  tool(
    'get_report',
    {
      title: 'Read a report',
      description:
        'The current version of a report (or a given version), with citations expanded to titles and links.',
      annotations: READ,
    },
    {
      kind: zKind.optional(),
      date: zDate.optional(),
      projectId: zProject,
      audience: zAudience,
      versionId: z.string().optional(),
    },
    async (a, c) =>
      svc.getReport(c, {
        ...(a.versionId
          ? { versionId: a.versionId }
          : { projectId: await projectIdOf(c, a.projectId), kind: a.kind, date: a.date }),
        audience: a.audience ?? 'me',
      }),
  );

  tool(
    'get_day',
    {
      title: 'One day',
      description: 'A project’s records, bundle and coverage for one date.',
      annotations: READ,
    },
    { date: zDate, projectId: zProject },
    async (a, c) => svc.getDay(c, await projectIdOf(c, a.projectId), a.date),
  );

  tool(
    'get_stats',
    {
      title: 'Stats',
      description: 'Deterministic counts of your activity in a project and range (`to` exclusive).',
      annotations: READ,
    },
    { from: zDate, to: zDate, projectId: zProject },
    async (a, c) =>
      svc.getStats(c, { projectId: await projectIdOf(c, a.projectId), from: a.from, to: a.to }),
  );

  tool(
    'search',
    {
      title: 'Search',
      description: 'Full-text search over the records and notes you can see.',
      annotations: READ,
    },
    {
      query: z.string(),
      projectId: zProject,
      from: zDate.optional(),
      to: zDate.optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    async (a, c) =>
      svc.search(c, {
        q: a.query,
        ...(a.projectId ? { projectId: await projectIdOf(c, a.projectId) } : {}),
        ...(a.from ? { from: a.from } : {}),
        ...(a.to ? { to: a.to } : {}),
        ...(a.limit ? { limit: a.limit } : {}),
      }),
  );

  tool(
    'add_note',
    {
      title: 'Add a note',
      description:
        'Capture a note. Inline hints: #project, @today/@yesterday/@YYYY-MM-DD, !event/!context/!guidance/!reminder, !tag. Without a project it lands in the Inbox.',
      annotations: WRITE,
    },
    {
      text: z.string(),
      projectId: zProject,
      visibility: z.enum(['private', 'project']).optional(),
    },
    async (a, c) =>
      svc.addNote(
        c,
        {
          text: a.text,
          ...(a.projectId ? { projectId: await projectIdOf(c, a.projectId) } : {}),
          ...(a.visibility ? { visibility: a.visibility } : {}),
        },
        'mcp',
      ),
  );

  tool(
    'list_inbox',
    {
      title: 'Inbox',
      description: 'Notes and records not yet confidently filed into a project.',
      annotations: READ,
    },
    { limit: z.number().int().min(1).max(100).optional() },
    async (a, c) => svc.listInbox(c, { limit: a.limit ?? 50 }),
  );

  tool(
    'route_note',
    {
      title: 'Route a record',
      description: 'File a note or record into a project, or change its date, kind or visibility.',
      annotations: WRITE,
    },
    {
      recordId: z.string(),
      projectId: z.string().optional().describe('Project ID or slug; "inbox" to unfile'),
      date: zDate.optional(),
      kind: z.enum(['event', 'context', 'guidance', 'reminder']).optional(),
      visibility: z.enum(['private', 'project']).optional(),
    },
    async (a, c) =>
      svc.routeRecord(c, a.recordId, {
        ...(a.projectId
          ? { projectId: a.projectId === 'inbox' ? null : await projectIdOf(c, a.projectId) }
          : {}),
        ...(a.date ? { date: a.date } : {}),
        ...(a.kind ? { kind: a.kind } : {}),
        ...(a.visibility ? { visibility: a.visibility } : {}),
      }),
  );

  tool(
    'add_guidance',
    {
      title: 'Add guidance',
      description:
        'An instruction that shapes future reports without changing evidence, e.g. "Leave out routine standups".',
      annotations: WRITE,
    },
    {
      scope: z.enum(['workspace', 'project', 'report_kind', 'report']),
      text: z.string(),
      projectId: zProject,
      reportKind: zKind.optional(),
      reportId: z.string().optional(),
    },
    async (a, c) =>
      svc.addGuidance(c, {
        scope: a.scope,
        text: a.text,
        ...(a.scope !== 'workspace' && a.scope !== 'report'
          ? { projectId: await projectIdOf(c, a.projectId) }
          : {}),
        ...(a.reportKind ? { reportKind: a.reportKind } : {}),
        ...(a.reportId ? { reportId: a.reportId } : {}),
      }),
  );

  tool(
    'ingest_records',
    {
      title: 'Ingest records (agent bridge)',
      description:
        'Submit records from a service you can read but the hub has no connector for (Slack, Calendar, Zoom…). Each record: {externalId, kind, eventTime, title, url, actor, summary?, payload?, applicableDate?}. Deduplicated on source + externalId. Store summaries and permalinks, not full message bodies.',
      annotations: WRITE,
    },
    {
      source: z.string().describe('e.g. "slack:acme", "calendar:google", "zoom:acme"'),
      records: z.array(z.record(z.string(), z.unknown())),
      projectId: zProject,
    },
    async (a, c) => {
      const r = await svc.ingestRecords(c, {
        source: a.source,
        tier: 'agent',
        projectId: await projectIdOf(c, a.projectId),
        records: a.records,
      });
      await svc.rebuildBundles(c.db, { days: 31 });
      await svc.markStaleReports(c.db);
      return r;
    },
  );

  // Prompts (api.md §5.3)
  server.registerPrompt(
    'morning_run',
    {
      title: 'Morning run',
      description: 'Write every missing or stale report, oldest first (spec §5.1).',
      argsSchema: { projectId: z.string().optional(), date: z.string().optional() },
    },
    async (a) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Run my morning work log${a.projectId ? ` for project ${a.projectId}` : ''}.

1. If you can read Slack, Calendar or Zoom for me, collect yesterday's${a.date ? ` (or ${a.date}'s)` : ''} messages I sent, meetings I attended and meeting summaries, and submit them with ingest_records (summaries and permalinks only; leave out other people's personal topics).
2. Call get_status. For each entry in \`due\`, oldest first: call get_report_inputs with its kind, date and projectId; write the report following inputs.template.instructions and the guidance; call save_report with the inputHash. If it returns validation errors, fix those statements and save again; if stale_input, get the inputs again.
3. Reply with 2–4 lines per report written: the main points and anything that failed or looked incomplete (inputs.gaps).`,
          },
        },
      ],
    }),
  );
  server.registerPrompt(
    'period_review',
    {
      title: 'Period review',
      description: 'Write a weekly, bi-weekly, monthly, quarterly or yearly review.',
      argsSchema: {
        kind: z.string(),
        date: z.string().optional(),
        projectId: z.string().optional(),
      },
    },
    async (a) => {
      const date = a.date ?? addDays(localDate(new Date(), 'UTC'), -7);
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Write my ${a.kind} review for the period containing ${date}${a.projectId ? ` in project ${a.projectId}` : ''}: call get_report_inputs (kind "${a.kind}", date "${date}"), write it from inputs.inputReports and inputs.stats following inputs.template.instructions, citing the input reports' statements as [[v:<versionId>#<anchor>]] and numbers as [[s:<metric>]], then save_report. Mention inputs.gaps.missingDays if any. Show me the TL;DR when done.`,
            },
          },
        ],
      };
    },
  );
  server.registerPrompt(
    'capture',
    {
      title: 'Capture',
      description: 'Turn a free-form message into notes.',
      argsSchema: { text: z.string() },
    },
    async (a) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Turn this into one or more notes with add_note. Split unrelated points. Add #project, @date and !kind hints where the text implies them (!event for things that happened, !context for standing background, !guidance for how reports should be written, !reminder for follow-ups):\n\n${a.text}`,
          },
        },
      ],
    }),
  );

  return server;
}

export async function handleMcp(
  request: Request,
  caller: McpCaller,
  deps: McpDeps,
): Promise<Response> {
  const server = buildServer(caller, deps);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    // JSON responses are complete once handleRequest resolves.
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
  }
}
