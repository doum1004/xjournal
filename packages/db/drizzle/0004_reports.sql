CREATE TABLE "evidence_refs" (
	"report_version_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"anchor" text NOT NULL,
	"ref_type" "ref_type" NOT NULL,
	"ref_id" text NOT NULL,
	CONSTRAINT "evidence_refs_report_version_id_anchor_ref_type_ref_id_pk" PRIMARY KEY("report_version_id","anchor","ref_type","ref_id")
);
--> statement-breakpoint
CREATE TABLE "guidance" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"scope" "guidance_scope" NOT NULL,
	"project_id" text,
	"report_kind" "report_kind",
	"report_id" text,
	"author_user_id" text NOT NULL,
	"visibility" "visibility" DEFAULT 'project' NOT NULL,
	"current_version_id" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "guidance_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"guidance_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"version_no" integer NOT NULL,
	"text" text NOT NULL,
	"content_hash" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guidance_versions_guidance_no_key" UNIQUE("guidance_id","version_no")
);
--> statement-breakpoint
CREATE TABLE "report_audience" (
	"report_id" text NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	CONSTRAINT "report_audience_report_id_user_id_pk" PRIMARY KEY("report_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "report_inputs" (
	"report_version_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"input_type" text NOT NULL,
	"input_id" text NOT NULL,
	"input_hash" text NOT NULL,
	CONSTRAINT "report_inputs_report_version_id_input_type_input_id_pk" PRIMARY KEY("report_version_id","input_type","input_id"),
	CONSTRAINT "report_inputs_type_check" CHECK ("report_inputs"."input_type" in ('bundle', 'report_version', 'guidance_version'))
);
--> statement-breakpoint
CREATE TABLE "report_stats" (
	"id" text PRIMARY KEY NOT NULL,
	"report_version_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"metric" text NOT NULL,
	"query" jsonb NOT NULL,
	"value" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"report_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"version_no" integer NOT NULL,
	"body_md" text NOT NULL,
	"path" "gen_path" NOT NULL,
	"model" text,
	"template_version" text NOT NULL,
	"client" text,
	"actor_user_id" text,
	"input_hash" text NOT NULL,
	"guidance_hash" text NOT NULL,
	"change_reason" "change_reason" NOT NULL,
	"change_summary" text,
	"validation" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_versions_report_no_key" UNIQUE("report_id","version_no")
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text,
	"kind" "report_kind" NOT NULL,
	"period_start" date NOT NULL,
	"period_end_excl" date NOT NULL,
	"audience_key" text NOT NULL,
	"current_version_id" text,
	"status" "report_status" DEFAULT 'current' NOT NULL,
	"stale_since" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reports_scope_key" UNIQUE("workspace_id","project_id","kind","period_start","audience_key")
);
--> statement-breakpoint
ALTER TABLE "evidence_refs" ADD CONSTRAINT "evidence_refs_report_version_id_report_versions_id_fk" FOREIGN KEY ("report_version_id") REFERENCES "public"."report_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guidance" ADD CONSTRAINT "guidance_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guidance" ADD CONSTRAINT "guidance_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guidance" ADD CONSTRAINT "guidance_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guidance" ADD CONSTRAINT "guidance_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guidance_versions" ADD CONSTRAINT "guidance_versions_guidance_id_guidance_id_fk" FOREIGN KEY ("guidance_id") REFERENCES "public"."guidance"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guidance_versions" ADD CONSTRAINT "guidance_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_audience" ADD CONSTRAINT "report_audience_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_audience" ADD CONSTRAINT "report_audience_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_inputs" ADD CONSTRAINT "report_inputs_report_version_id_report_versions_id_fk" FOREIGN KEY ("report_version_id") REFERENCES "public"."report_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_stats" ADD CONSTRAINT "report_stats_report_version_id_report_versions_id_fk" FOREIGN KEY ("report_version_id") REFERENCES "public"."report_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_versions" ADD CONSTRAINT "report_versions_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_versions" ADD CONSTRAINT "report_versions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_inputs_input_idx" ON "report_inputs" USING btree ("input_type","input_id");--> statement-breakpoint
CREATE INDEX "reports_project_kind_period_idx" ON "reports" USING btree ("project_id","kind","period_start");