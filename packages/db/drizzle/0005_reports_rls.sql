-- Reports and guidance (schema.md §7, §9): row-level security.
--
-- A report is visible to its audience only. Writing a version needs audience membership plus
-- contributor rights in the report's project (the workspace owner for workspace aggregates).
-- Versions, inputs, evidence refs and stats are append-only. Staleness is set by a system job
-- (`withSystem`), which bypasses these policies.

CREATE FUNCTION app_in_report_audience(p_report text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM report_audience
                 WHERE report_id = p_report AND user_id = app_uid()) $$;
--> statement-breakpoint
-- May the caller set up this report (create it, add its audience)? Contributor in its project,
-- or the workspace owner for a workspace aggregate.
CREATE FUNCTION app_can_seed_report(p_report text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM reports r
                 WHERE r.id = p_report AND r.workspace_id = app_wid()
                   AND ((r.project_id IS NULL AND app_is_workspace_owner(r.workspace_id))
                        OR app_role(r.project_id) >= 'contributor')) $$;
--> statement-breakpoint
CREATE FUNCTION app_can_write_report(p_report text) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT app_in_report_audience(p_report) AND app_can_seed_report(p_report) $$;
--> statement-breakpoint
CREATE FUNCTION app_report_of_version(p_version text) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT report_id FROM report_versions WHERE id = p_version $$;
--> statement-breakpoint
CREATE FUNCTION app_can_see_guidance(p_guidance text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM guidance g
                 WHERE g.id = p_guidance AND g.workspace_id = app_wid()
                   AND (g.author_user_id = app_uid()
                        OR (g.visibility = 'project'
                            AND (g.project_id IS NULL OR app_is_member(g.project_id))))) $$;
--> statement-breakpoint
CREATE FUNCTION app_owns_guidance(p_guidance text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM guidance
                 WHERE id = p_guidance AND author_user_id = app_uid()) $$;
--> statement-breakpoint

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['reports', 'report_audience', 'report_versions', 'report_inputs',
                           'evidence_refs', 'report_stats', 'guidance', 'guidance_versions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON reports, guidance TO hub_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON report_audience, report_versions, report_inputs, evidence_refs,
  report_stats, guidance_versions TO hub_app;
--> statement-breakpoint

-- reports
CREATE POLICY reports_select ON reports FOR SELECT TO hub_app
  USING (workspace_id = app_wid() AND app_in_report_audience(id));
--> statement-breakpoint
CREATE POLICY reports_insert ON reports FOR INSERT TO hub_app
  WITH CHECK (workspace_id = app_wid()
              AND ((project_id IS NULL AND app_is_workspace_owner(workspace_id))
                   OR app_role(project_id) >= 'contributor'));
--> statement-breakpoint
CREATE POLICY reports_update ON reports FOR UPDATE TO hub_app
  USING (workspace_id = app_wid() AND app_can_write_report(id))
  WITH CHECK (workspace_id = app_wid() AND app_can_write_report(id));
--> statement-breakpoint

-- report_audience
CREATE POLICY report_audience_select ON report_audience FOR SELECT TO hub_app
  USING (workspace_id = app_wid() AND app_in_report_audience(report_id));
--> statement-breakpoint
CREATE POLICY report_audience_insert ON report_audience FOR INSERT TO hub_app
  WITH CHECK (workspace_id = app_wid() AND app_can_seed_report(report_id));
--> statement-breakpoint

-- report_versions
CREATE POLICY report_versions_select ON report_versions FOR SELECT TO hub_app
  USING (workspace_id = app_wid() AND app_in_report_audience(report_id));
--> statement-breakpoint
CREATE POLICY report_versions_insert ON report_versions FOR INSERT TO hub_app
  WITH CHECK (workspace_id = app_wid() AND app_can_write_report(report_id)
              AND actor_user_id = app_uid());
--> statement-breakpoint

-- Children of a version: read with the report, written by whoever may write it.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['report_inputs', 'evidence_refs', 'report_stats'] LOOP
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO hub_app USING (workspace_id = app_wid() AND app_in_report_audience(app_report_of_version(report_version_id)))', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT TO hub_app WITH CHECK (workspace_id = app_wid() AND app_can_write_report(app_report_of_version(report_version_id)))', t || '_insert', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- guidance: the author always; 'project' visibility for the project's members (or the whole
-- workspace for workspace-scoped guidance). Writing: the workspace owner for workspace scope,
-- a manager for project and report-kind scope, a report writer for report scope.
CREATE POLICY guidance_select ON guidance FOR SELECT TO hub_app
  USING (workspace_id = app_wid() AND app_can_see_guidance(id));
--> statement-breakpoint
CREATE POLICY guidance_insert ON guidance FOR INSERT TO hub_app
  WITH CHECK (workspace_id = app_wid() AND author_user_id = app_uid() AND (
       (scope = 'workspace' AND app_is_workspace_owner(workspace_id))
    OR (scope IN ('project', 'report_kind') AND app_role(project_id) >= 'manager')
    OR (scope = 'report' AND app_can_write_report(report_id))));
--> statement-breakpoint
CREATE POLICY guidance_update ON guidance FOR UPDATE TO hub_app
  USING (workspace_id = app_wid() AND author_user_id = app_uid())
  WITH CHECK (workspace_id = app_wid() AND author_user_id = app_uid());
--> statement-breakpoint
CREATE POLICY guidance_versions_select ON guidance_versions FOR SELECT TO hub_app
  USING (workspace_id = app_wid() AND app_can_see_guidance(guidance_id));
--> statement-breakpoint
CREATE POLICY guidance_versions_insert ON guidance_versions FOR INSERT TO hub_app
  WITH CHECK (workspace_id = app_wid() AND created_by = app_uid() AND app_owns_guidance(guidance_id));
