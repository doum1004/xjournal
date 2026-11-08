-- Row-level security (schema.md §9, docs/adr/0005).
--
-- Roles:
--   hub_app   The service layer. Every transaction runs `set local role hub_app` and sets
--             app.user_id / app.workspace_id (packages/db/src/actor.ts). All policies below apply.
--   hub_auth  Better Auth and invite redemption, which run before a user is known. Granted only
--             the sign-in tables; it can't read records, reports or connectors.
-- Both are NOLOGIN group roles; the login role in DATABASE_URL must be a member of them.
--
-- The helper functions are SECURITY DEFINER so that a policy on project_members can ask
-- "is the caller a member?" without recursing into its own policy. They must be owned by a
-- role that bypasses RLS (the migration role; see ADR 0005 for managed Postgres).

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hub_app') THEN CREATE ROLE hub_app NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hub_auth') THEN CREATE ROLE hub_auth NOLOGIN; END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN EXECUTE format('GRANT hub_app, hub_auth TO %I', current_user); END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO hub_app, hub_auth;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION app_uid() RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.user_id', true), '') $$;
--> statement-breakpoint
CREATE FUNCTION app_wid() RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.workspace_id', true), '') $$;
--> statement-breakpoint

-- The caller's role in a project, or null.
CREATE FUNCTION app_role(p_project text) RETURNS member_role
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT role FROM project_members
  WHERE project_id = p_project AND user_id = app_uid() AND left_at IS NULL $$;
--> statement-breakpoint
CREATE FUNCTION app_is_member(p_project text) RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT app_role(p_project) IS NOT NULL $$;
--> statement-breakpoint
CREATE FUNCTION app_is_workspace_owner(p_workspace text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM workspaces WHERE id = p_workspace AND owner_user_id = app_uid()) $$;
--> statement-breakpoint
CREATE FUNCTION app_is_workspace_member(p_workspace text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM project_members
                 WHERE workspace_id = p_workspace AND user_id = app_uid() AND left_at IS NULL) $$;
--> statement-breakpoint
-- True when the caller and p_user are both active members of some project.
CREATE FUNCTION app_shares_project(p_user text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM project_members a JOIN project_members b USING (project_id)
                 WHERE a.user_id = app_uid() AND b.user_id = p_user
                   AND a.left_at IS NULL AND b.left_at IS NULL) $$;
--> statement-breakpoint
-- Device approval: the caller is a manager or owner of a project that p_user belongs to.
CREATE FUNCTION app_can_approve_devices_of(p_user text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM project_members me JOIN project_members them USING (project_id)
                 WHERE me.user_id = app_uid() AND them.user_id = p_user
                   AND me.role >= 'manager' AND me.left_at IS NULL AND them.left_at IS NULL) $$;
--> statement-breakpoint
CREATE FUNCTION app_owns_connector(p_connector text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM connector_accounts WHERE id = p_connector AND owner_user_id = app_uid()) $$;
--> statement-breakpoint
CREATE FUNCTION app_in_record_audience(p_record text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM record_audiences WHERE record_id = p_record AND user_id = app_uid()) $$;
--> statement-breakpoint

-- The record read rule (schema.md §9), shared by the records policy and its child tables.
-- Inbox rows (project_id null) are visible only to their owner. A member who left a project
-- loses 'project' and 'restricted' items in it.
CREATE FUNCTION app_record_visible(p_id text, p_owner text, p_project text, p_vis visibility)
  RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT p_owner = app_uid()
      OR (p_project IS NOT NULL AND app_is_member(p_project) AND (
            p_vis = 'project'
         OR (p_vis = 'restricted' AND app_in_record_audience(p_id)))) $$;
--> statement-breakpoint
CREATE FUNCTION app_can_see_record(p_record text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM records r
                 WHERE r.id = p_record AND r.workspace_id = app_wid()
                   AND app_record_visible(r.id, r.owner_user_id, r.project_id, r.visibility)) $$;
--> statement-breakpoint
-- Who may change a record's metadata and children: its owner, or a manager of its project.
CREATE FUNCTION app_can_edit_record(p_record text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM records r
                 WHERE r.id = p_record AND r.workspace_id = app_wid()
                   AND (r.owner_user_id = app_uid() OR app_role(r.project_id) >= 'manager')) $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Enable and force RLS on every table
-- ---------------------------------------------------------------------------------------------

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'workspaces', 'projects', 'project_members', 'invites', 'passkeys', 'sessions',
    'access_tokens', 'identities', 'connector_accounts', 'project_sources', 'sync_states',
    'project_rules', 'records', 'record_revisions', 'record_audiences', 'record_tags',
    'record_people', 'accounts', 'verifications', 'jwks', 'oauth_clients', 'oauth_resources',
    'oauth_client_resources', 'oauth_refresh_tokens', 'oauth_access_tokens', 'oauth_consents',
    'oauth_client_assertions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- hub_app: grants. Append-only tables get no UPDATE or DELETE (schema.md §0).
-- ---------------------------------------------------------------------------------------------

GRANT SELECT, UPDATE ON users TO hub_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON workspaces, projects, project_members, invites, records,
  connector_accounts, project_rules, sync_states TO hub_app;
--> statement-breakpoint
GRANT SELECT, UPDATE ON passkeys TO hub_app;
--> statement-breakpoint
GRANT SELECT, UPDATE, DELETE ON sessions TO hub_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON access_tokens, identities, project_sources,
  record_audiences, record_tags, record_people TO hub_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON record_revisions TO hub_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- hub_app: policies
-- ---------------------------------------------------------------------------------------------

-- users: yourself and anyone you share a project with. Users are created by hub_auth.
CREATE POLICY users_select ON users FOR SELECT TO hub_app
  USING (id = app_uid() OR app_shares_project(id));
--> statement-breakpoint
CREATE POLICY users_update ON users FOR UPDATE TO hub_app
  USING (id = app_uid()) WITH CHECK (id = app_uid());
--> statement-breakpoint

-- workspaces
CREATE POLICY workspaces_select ON workspaces FOR SELECT TO hub_app
  USING (id = app_wid() AND (owner_user_id = app_uid() OR app_is_workspace_member(id)));
--> statement-breakpoint
CREATE POLICY workspaces_insert ON workspaces FOR INSERT TO hub_app
  WITH CHECK (id = app_wid() AND owner_user_id = app_uid());
--> statement-breakpoint
CREATE POLICY workspaces_update ON workspaces FOR UPDATE TO hub_app
  USING (id = app_wid() AND owner_user_id = app_uid())
  WITH CHECK (id = app_wid() AND owner_user_id = app_uid());
--> statement-breakpoint

-- projects: members read; the workspace owner creates; managers update.
CREATE POLICY projects_select ON projects FOR SELECT TO hub_app
  USING (workspace_id = app_wid() AND (app_is_member(id) OR app_is_workspace_owner(workspace_id)));
--> statement-breakpoint
CREATE POLICY projects_insert ON projects FOR INSERT TO hub_app
  WITH CHECK (workspace_id = app_wid() AND app_is_workspace_owner(workspace_id));
--> statement-breakpoint
CREATE POLICY projects_update ON projects FOR UPDATE TO hub_app
  USING (workspace_id = app_wid() AND app_role(id) >= 'manager')
  WITH CHECK (workspace_id = app_wid() AND app_role(id) >= 'manager');
--> statement-breakpoint

-- project_members: members read. Managers add or change members below manager; owners
-- anything. The workspace owner seeds a project's first owner. A member may update their
-- own row (to leave) but never raise their role. Removal is `left_at`, never DELETE.
CREATE POLICY project_members_select ON project_members FOR SELECT TO hub_app
  USING (workspace_id = app_wid() AND app_is_member(project_id));
--> statement-breakpoint
CREATE POLICY project_members_insert ON project_members FOR INSERT TO hub_app
  WITH CHECK (workspace_id = app_wid() AND (
       app_role(project_id) = 'owner'
    OR (app_role(project_id) = 'manager' AND role < 'manager')
    OR app_is_workspace_owner(workspace_id)));
--> statement-breakpoint
CREATE POLICY project_members_update ON project_members FOR UPDATE TO hub_app
  USING (workspace_id = app_wid() AND (
       app_role(project_id) = 'owner'
    OR (app_role(project_id) = 'manager' AND role < 'manager')
    OR user_id = app_uid()))
  WITH CHECK (workspace_id = app_wid() AND (
       app_role(project_id) = 'owner'
    OR (app_role(project_id) = 'manager' AND role < 'manager')
    OR (user_id = app_uid() AND role <= app_role(project_id))));
--> statement-breakpoint

-- invites: managers; inviting a manager or owner needs an owner.
CREATE POLICY invites_select ON invites FOR SELECT TO hub_app
  USING (workspace_id = app_wid() AND app_role(project_id) >= 'manager');
--> statement-breakpoint
CREATE POLICY invites_insert ON invites FOR INSERT TO hub_app
  WITH CHECK (workspace_id = app_wid() AND created_by = app_uid() AND (
       app_role(project_id) = 'owner'
    OR (app_role(project_id) = 'manager' AND role < 'manager')));
--> statement-breakpoint
CREATE POLICY invites_update ON invites FOR UPDATE TO hub_app
  USING (workspace_id = app_wid() AND app_role(project_id) >= 'manager')
  WITH CHECK (workspace_id = app_wid() AND app_role(project_id) >= 'manager');
--> statement-breakpoint

-- passkeys: the owner user; managers of a shared project may read and approve.
CREATE POLICY passkeys_select ON passkeys FOR SELECT TO hub_app
  USING (user_id = app_uid() OR app_can_approve_devices_of(user_id));
--> statement-breakpoint
CREATE POLICY passkeys_update ON passkeys FOR UPDATE TO hub_app
  USING (user_id = app_uid() OR app_can_approve_devices_of(user_id))
  WITH CHECK (user_id = app_uid() OR app_can_approve_devices_of(user_id));
--> statement-breakpoint

-- Owner-user-only tables.
CREATE POLICY sessions_owner ON sessions FOR ALL TO hub_app
  USING (user_id = app_uid()) WITH CHECK (user_id = app_uid());
--> statement-breakpoint
CREATE POLICY access_tokens_owner ON access_tokens FOR ALL TO hub_app
  USING (workspace_id = app_wid() AND user_id = app_uid())
  WITH CHECK (workspace_id = app_wid() AND user_id = app_uid());
--> statement-breakpoint
CREATE POLICY identities_owner ON identities FOR ALL TO hub_app
  USING (workspace_id = app_wid() AND user_id = app_uid())
  WITH CHECK (workspace_id = app_wid() AND user_id = app_uid());
--> statement-breakpoint
CREATE POLICY connector_accounts_owner ON connector_accounts FOR ALL TO hub_app
  USING (workspace_id = app_wid() AND owner_user_id = app_uid())
  WITH CHECK (workspace_id = app_wid() AND owner_user_id = app_uid());
--> statement-breakpoint
CREATE POLICY sync_states_owner ON sync_states FOR ALL TO hub_app
  USING (workspace_id = app_wid() AND app_owns_connector(connector_account_id))
  WITH CHECK (workspace_id = app_wid() AND app_owns_connector(connector_account_id));
--> statement-breakpoint

-- project_sources: members read; attaching needs contributor and owning the connector.
CREATE POLICY project_sources_select ON project_sources FOR SELECT TO hub_app
  USING (workspace_id = app_wid() AND app_is_member(project_id));
--> statement-breakpoint
CREATE POLICY project_sources_write ON project_sources FOR ALL TO hub_app
  USING (workspace_id = app_wid() AND app_role(project_id) >= 'contributor'
         AND app_owns_connector(connector_account_id))
  WITH CHECK (workspace_id = app_wid() AND app_role(project_id) >= 'contributor'
              AND app_owns_connector(connector_account_id));
--> statement-breakpoint

-- project_rules: members read; managers (or the workspace owner) write.
CREATE POLICY project_rules_select ON project_rules FOR SELECT TO hub_app
  USING (workspace_id = app_wid() AND app_is_member(project_id));
--> statement-breakpoint
CREATE POLICY project_rules_insert ON project_rules FOR INSERT TO hub_app
  WITH CHECK (workspace_id = app_wid() AND created_by = app_uid()
              AND (app_role(project_id) >= 'manager' OR app_is_workspace_owner(workspace_id)));
--> statement-breakpoint
CREATE POLICY project_rules_update ON project_rules FOR UPDATE TO hub_app
  USING (workspace_id = app_wid() AND (app_role(project_id) >= 'manager' OR app_is_workspace_owner(workspace_id)))
  WITH CHECK (workspace_id = app_wid() AND (app_role(project_id) >= 'manager' OR app_is_workspace_owner(workspace_id)));
--> statement-breakpoint

-- records
CREATE POLICY records_select ON records FOR SELECT TO hub_app
  USING (workspace_id = app_wid() AND app_record_visible(id, owner_user_id, project_id, visibility));
--> statement-breakpoint
-- Insert as yourself (connectors run as their owner): into the Inbox, or a project where
-- you're at least a contributor.
CREATE POLICY records_insert ON records FOR INSERT TO hub_app
  WITH CHECK (workspace_id = app_wid() AND owner_user_id = app_uid()
              AND (project_id IS NULL OR app_role(project_id) >= 'contributor'));
--> statement-breakpoint
-- Update (route, re-route, hide): the owner, into a project they contribute to; or a manager.
CREATE POLICY records_update ON records FOR UPDATE TO hub_app
  USING (workspace_id = app_wid() AND (owner_user_id = app_uid() OR app_role(project_id) >= 'manager'))
  WITH CHECK (workspace_id = app_wid() AND (
       (owner_user_id = app_uid() AND (project_id IS NULL OR app_role(project_id) >= 'contributor'))
    OR app_role(project_id) >= 'manager'));
--> statement-breakpoint

-- record_revisions: visible with their record; insert-only.
CREATE POLICY record_revisions_select ON record_revisions FOR SELECT TO hub_app
  USING (workspace_id = app_wid() AND app_can_see_record(record_id));
--> statement-breakpoint
CREATE POLICY record_revisions_insert ON record_revisions FOR INSERT TO hub_app
  WITH CHECK (workspace_id = app_wid() AND app_can_edit_record(record_id));
--> statement-breakpoint

-- Record children: read with the record; written by whoever may edit the record.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['record_audiences', 'record_tags', 'record_people'] LOOP
    EXECUTE format('CREATE POLICY %1$s_select ON %1$I FOR SELECT TO hub_app
      USING (workspace_id = app_wid() AND app_can_see_record(record_id))', t);
    EXECUTE format('CREATE POLICY %1$s_insert ON %1$I FOR INSERT TO hub_app
      WITH CHECK (workspace_id = app_wid() AND app_can_edit_record(record_id))', t);
    EXECUTE format('CREATE POLICY %1$s_update ON %1$I FOR UPDATE TO hub_app
      USING (workspace_id = app_wid() AND app_can_edit_record(record_id))
      WITH CHECK (workspace_id = app_wid() AND app_can_edit_record(record_id))', t);
    EXECUTE format('CREATE POLICY %1$s_delete ON %1$I FOR DELETE TO hub_app
      USING (workspace_id = app_wid() AND app_can_edit_record(record_id))', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- hub_auth: the sign-in tables only.
-- ---------------------------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON users, sessions, passkeys, accounts, verifications, jwks,
  oauth_clients, oauth_resources, oauth_client_resources, oauth_refresh_tokens,
  oauth_access_tokens, oauth_consents, oauth_client_assertions TO hub_auth;
--> statement-breakpoint
-- Invite redemption: read and consume the invite, add the membership.
GRANT SELECT, UPDATE ON invites TO hub_auth;
--> statement-breakpoint
GRANT SELECT, INSERT ON project_members TO hub_auth;
--> statement-breakpoint
GRANT SELECT ON projects TO hub_auth;
--> statement-breakpoint
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'sessions', 'passkeys', 'accounts', 'verifications', 'jwks', 'oauth_clients',
    'oauth_resources', 'oauth_client_resources', 'oauth_refresh_tokens', 'oauth_access_tokens',
    'oauth_consents', 'oauth_client_assertions', 'invites', 'project_members', 'projects'] LOOP
    EXECUTE format('CREATE POLICY %1$s_auth ON %1$I FOR ALL TO hub_auth USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
