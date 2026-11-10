-- AI-suggested work item links (docs/adr/0009): which records the model has already been
-- asked about. Only the system job that asks reads or writes this table, so `hub_app` gets no
-- grant and no policy: with row-level security forced, it sees nothing.

ALTER TABLE work_item_ai_checks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE work_item_ai_checks FORCE ROW LEVEL SECURITY;
