-- Daily bundles (schema.md §6): row-level security and staleness.
--
-- Bundles are derived data, built by a system job running as the migration role (`withSystem`,
-- packages/db/src/actor.ts), because a bundle covers every record of its project and date
-- regardless of visibility. `hub_app` may only read them, under the policies below.

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['daily_bundles', 'bundle_items'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
--> statement-breakpoint
GRANT SELECT ON daily_bundles, bundle_items TO hub_app;
--> statement-breakpoint

-- A project's members see its bundles (hash, coverage, staleness).
CREATE POLICY daily_bundles_select ON daily_bundles FOR SELECT TO hub_app
  USING (workspace_id = app_wid() AND app_is_member(project_id));
--> statement-breakpoint
-- Items: only the revisions whose record the caller can see.
CREATE POLICY bundle_items_select ON bundle_items FOR SELECT TO hub_app
  USING (workspace_id = app_wid() AND EXISTS (
    SELECT 1 FROM record_revisions rr
    WHERE rr.id = bundle_items.record_revision_id AND app_can_see_record(rr.record_id)));
--> statement-breakpoint

-- Staleness: any change to a record's day, project, content or hidden state marks the bundles
-- of its old and new (project, date) dirty. SECURITY DEFINER, because the service role that
-- changes records has no write access to bundles. A day without a bundle yet needs no mark:
-- it's found as "has records, no bundle".
CREATE FUNCTION mark_bundles_dirty() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.project_id IS NOT NULL THEN
    UPDATE daily_bundles SET dirty_since = coalesce(dirty_since, now())
    WHERE project_id = OLD.project_id AND date = OLD.applicable_date;
  END IF;
  IF NEW.project_id IS NOT NULL THEN
    UPDATE daily_bundles SET dirty_since = coalesce(dirty_since, now())
    WHERE project_id = NEW.project_id AND date = NEW.applicable_date;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER records_mark_bundles_dirty
  AFTER INSERT OR UPDATE OF project_id, applicable_date, current_revision_id, hidden_at
  ON records FOR EACH ROW EXECUTE FUNCTION mark_bundles_dirty();
