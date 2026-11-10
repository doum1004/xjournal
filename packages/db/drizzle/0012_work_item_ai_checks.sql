CREATE TABLE "work_item_ai_checks" (
	"record_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"revision_id" text NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "work_item_ai_checks" ADD CONSTRAINT "work_item_ai_checks_record_id_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."records"("id") ON DELETE no action ON UPDATE no action;