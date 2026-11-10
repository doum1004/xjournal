-- Work items (schema.md §6, spec §3.5): row-level security.
--
-- Work items are derived data, built by a system job running as the migration role
-- (`withSystem`), because linking looks at every record of a project whatever its visibility.
-- `hub_app` may only read them:
--   - a link is visible when its record is;
--   - an item is visible to the project's members who can see at least one of its links, so a
--     member never learns of an item made only of records hidden from them. Its title comes
--     from its project-visible records when it has any (services/src/workitems.ts).

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['work_items', 'work_item_links'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
--> statement-breakpoint
GRANT SELECT ON work_items, work_item_links TO hub_app;
--> statement-breakpoint
CREATE POLICY work_item_links_select ON work_item_links FOR SELECT TO hub_app
  USING (workspace_id = app_wid() AND app_can_see_record(record_id));
--> statement-breakpoint
-- The subquery on work_item_links runs under that table's policy.
CREATE POLICY work_items_select ON work_items FOR SELECT TO hub_app
  USING (workspace_id = app_wid() AND app_is_member(project_id) AND EXISTS (
    SELECT 1 FROM work_item_links l WHERE l.work_item_id = work_items.id));
