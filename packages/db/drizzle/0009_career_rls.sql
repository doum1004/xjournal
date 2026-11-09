-- career_entries (spec §9.8): the career log is private to its owner, who must be a member of
-- the project. A proposed draft may name the quarterly report version it came from, which the
-- owner must be able to read.
ALTER TABLE career_entries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE career_entries FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON career_entries TO hub_app;
--> statement-breakpoint
CREATE POLICY career_entries_select ON career_entries FOR SELECT TO hub_app
  USING (workspace_id = app_wid() AND user_id = app_uid());
--> statement-breakpoint
CREATE POLICY career_entries_insert ON career_entries FOR INSERT TO hub_app
  WITH CHECK (workspace_id = app_wid() AND user_id = app_uid() AND app_is_member(project_id)
              AND (source_version_id IS NULL
                   OR app_in_report_audience(app_report_of_version(source_version_id))));
--> statement-breakpoint
CREATE POLICY career_entries_update ON career_entries FOR UPDATE TO hub_app
  USING (workspace_id = app_wid() AND user_id = app_uid())
  WITH CHECK (workspace_id = app_wid() AND user_id = app_uid() AND app_is_member(project_id)
              AND (source_version_id IS NULL
                   OR app_in_report_audience(app_report_of_version(source_version_id))));
--> statement-breakpoint
CREATE POLICY career_entries_delete ON career_entries FOR DELETE TO hub_app
  USING (workspace_id = app_wid() AND user_id = app_uid());
