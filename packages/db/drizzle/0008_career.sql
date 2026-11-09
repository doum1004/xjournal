CREATE TABLE "career_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"period_start" date NOT NULL,
	"body_md" text NOT NULL,
	"source_version_id" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "career_entries_owner_period_key" UNIQUE("user_id","project_id","period_start"),
	CONSTRAINT "career_entries_status_check" CHECK ("career_entries"."status" in ('draft', 'approved'))
);
--> statement-breakpoint
ALTER TABLE "report_inputs" DROP CONSTRAINT "report_inputs_type_check";--> statement-breakpoint
ALTER TABLE "career_entries" ADD CONSTRAINT "career_entries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_entries" ADD CONSTRAINT "career_entries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_entries" ADD CONSTRAINT "career_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_entries" ADD CONSTRAINT "career_entries_source_version_id_report_versions_id_fk" FOREIGN KEY ("source_version_id") REFERENCES "public"."report_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_inputs" ADD CONSTRAINT "report_inputs_type_check" CHECK ("report_inputs"."input_type" in ('bundle', 'report_version', 'previous_report', 'guidance_version'));