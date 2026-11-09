-- exports (schema.md §8): a user's own publish records. Reading the published version still
-- follows the report's audience; the row itself is private to whoever published it.
ALTER TABLE exports ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE exports FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT ON exports TO hub_app;
--> statement-breakpoint
CREATE POLICY exports_select ON exports FOR SELECT TO hub_app
  USING (workspace_id = app_wid() AND created_by = app_uid());
--> statement-breakpoint
CREATE POLICY exports_insert ON exports FOR INSERT TO hub_app
  WITH CHECK (workspace_id = app_wid() AND created_by = app_uid()
              AND (report_version_id IS NULL
                   OR app_in_report_audience(app_report_of_version(report_version_id))));
