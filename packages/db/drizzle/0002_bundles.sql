CREATE TABLE "bundle_items" (
	"bundle_id" text NOT NULL,
	"record_revision_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	CONSTRAINT "bundle_items_bundle_id_record_revision_id_pk" PRIMARY KEY("bundle_id","record_revision_id")
);
--> statement-breakpoint
CREATE TABLE "daily_bundles" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"date" date NOT NULL,
	"content_hash" text NOT NULL,
	"coverage" jsonb NOT NULL,
	"built_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dirty_since" timestamp with time zone,
	CONSTRAINT "daily_bundles_project_date_key" UNIQUE("project_id","date")
);
--> statement-breakpoint
ALTER TABLE "bundle_items" ADD CONSTRAINT "bundle_items_bundle_id_daily_bundles_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "public"."daily_bundles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bundle_items" ADD CONSTRAINT "bundle_items_record_revision_id_record_revisions_id_fk" FOREIGN KEY ("record_revision_id") REFERENCES "public"."record_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_bundles" ADD CONSTRAINT "daily_bundles_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "daily_bundles_dirty_idx" ON "daily_bundles" USING btree ("project_id","dirty_since");