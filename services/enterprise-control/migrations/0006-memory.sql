CREATE TABLE enterprise_memory_records (
  tenant_id uuid NOT NULL REFERENCES enterprise_tenants(id),
  id uuid NOT NULL,
  owner_id uuid NOT NULL,
  scope text NOT NULL CHECK (scope IN ('user_private', 'project_private', 'team_shared')),
  project_id uuid,
  department_id uuid,
  scope_id uuid GENERATED ALWAYS AS (COALESCE(project_id, department_id, owner_id)) STORED,
  body text NOT NULL CHECK (char_length(body) <= 2000),
  source_ref jsonb,
  classification text NOT NULL CHECK (classification IN ('general', 'internal', 'restricted')),
  fact_hash text NOT NULL CHECK (fact_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('candidate', 'active', 'deleted')),
  revision integer NOT NULL CHECK (revision > 0),
  create_key uuid,
  create_fingerprint text NOT NULL CHECK (create_fingerprint ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz,
  last_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, owner_id, create_key),
  FOREIGN KEY (tenant_id, owner_id) REFERENCES enterprise_users(tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES enterprise_projects(tenant_id, id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES enterprise_departments(tenant_id, id),
  CHECK (
    (scope = 'user_private' AND project_id IS NULL AND department_id IS NULL) OR
    (scope = 'project_private' AND project_id IS NOT NULL AND department_id IS NULL) OR
    (scope = 'team_shared' AND department_id IS NOT NULL AND project_id IS NULL)
  ),
  CHECK ((status = 'deleted' AND body = '') OR (status <> 'deleted' AND char_length(body) > 0))
);
CREATE INDEX enterprise_memory_records_scope ON enterprise_memory_records (tenant_id, scope, scope_id, status);
CREATE INDEX enterprise_memory_records_dedupe ON enterprise_memory_records (tenant_id, owner_id, scope, scope_id, fact_hash)
  WHERE status <> 'deleted';

CREATE TABLE enterprise_memory_versions (
  tenant_id uuid NOT NULL,
  memory_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  actor_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('candidate', 'active', 'deleted')),
  fact_hash text NOT NULL CHECK (fact_hash ~ '^[0-9a-f]{64}$'),
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, memory_id, revision),
  FOREIGN KEY (tenant_id, memory_id) REFERENCES enterprise_memory_records(tenant_id, id),
  FOREIGN KEY (tenant_id, actor_id) REFERENCES enterprise_users(tenant_id, id)
);

CREATE TABLE enterprise_knowledge_documents (
  tenant_id uuid NOT NULL REFERENCES enterprise_tenants(id),
  id uuid NOT NULL,
  owner_id uuid NOT NULL,
  scope text NOT NULL CHECK (scope IN ('enterprise_reference', 'project_private', 'team_shared')),
  project_id uuid,
  department_id uuid,
  scope_id uuid GENERATED ALWAYS AS (COALESCE(project_id, department_id)) STORED,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  body text NOT NULL CHECK (char_length(body) <= 3500),
  source jsonb NOT NULL,
  classification text NOT NULL CHECK (classification IN ('general', 'internal', 'restricted')),
  checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('draft', 'ready', 'deleted')),
  revision integer NOT NULL CHECK (revision > 0),
  index_revision integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_id) REFERENCES enterprise_users(tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES enterprise_projects(tenant_id, id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES enterprise_departments(tenant_id, id),
  CHECK (
    (scope = 'enterprise_reference' AND project_id IS NULL AND department_id IS NULL) OR
    (scope = 'project_private' AND project_id IS NOT NULL AND department_id IS NULL) OR
    (scope = 'team_shared' AND department_id IS NOT NULL AND project_id IS NULL)
  ),
  CHECK ((status = 'ready' AND index_revision = revision AND index_revision IS NOT NULL) OR
    (status <> 'ready' AND index_revision IS NULL)),
  CHECK ((status = 'deleted' AND body = '') OR (status <> 'deleted' AND char_length(body) > 0))
);
CREATE INDEX enterprise_knowledge_scope ON enterprise_knowledge_documents (tenant_id, scope, scope_id, status);

CREATE TABLE enterprise_context_visibility (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  resource_type text NOT NULL CHECK (resource_type IN ('memory', 'knowledge')),
  resource_id uuid NOT NULL,
  scope text NOT NULL CHECK (scope IN ('user_private', 'project_private', 'team_shared', 'enterprise_reference')),
  scope_id uuid,
  revision integer NOT NULL CHECK (revision > 0),
  PRIMARY KEY (tenant_id, user_id, resource_type, resource_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES enterprise_users(tenant_id, id)
);
CREATE INDEX enterprise_context_visibility_scope ON enterprise_context_visibility (tenant_id, scope, scope_id, user_id);
CREATE INDEX enterprise_context_visibility_resource ON enterprise_context_visibility (tenant_id, resource_type, resource_id);

CREATE TABLE enterprise_context_changes (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
  resource_type text NOT NULL CHECK (resource_type IN ('memory', 'knowledge')),
  resource_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  operation text NOT NULL CHECK (operation IN ('upsert', 'tombstone')),
  reason text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, sequence),
  FOREIGN KEY (tenant_id, user_id) REFERENCES enterprise_users(tenant_id, id),
  CHECK ((operation = 'upsert' AND reason IS NULL) OR
    (operation = 'tombstone' AND reason IN ('deleted', 'access_revoked', 'expired', 'unpublished') AND reason IS NOT NULL))
);

CREATE FUNCTION enterprise_context_scope_allowed(p_tenant uuid, p_user uuid, p_scope text, p_scope_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM enterprise_users u JOIN enterprise_tenants t ON t.id = u.tenant_id
    WHERE u.tenant_id = p_tenant AND u.id = p_user AND u.active AND t.active
    AND CASE p_scope
      WHEN 'user_private' THEN u.id = p_scope_id
      WHEN 'team_shared' THEN u.department_id = p_scope_id
      WHEN 'project_private' THEN EXISTS (
        SELECT 1 FROM enterprise_project_members m
        JOIN enterprise_projects p ON (p.tenant_id, p.id) = (m.tenant_id, m.project_id)
        WHERE m.tenant_id = p_tenant AND m.user_id = p_user AND m.project_id = p_scope_id AND p.active
      )
      WHEN 'enterprise_reference' THEN p_scope_id IS NULL
      ELSE false
    END
  )
$$;

-- The tenant row orders visibility changes, including writes made by the existing project/directory module.
-- Sequences are independent per user, with no counter exposing the activity of other users.
CREATE FUNCTION enterprise_context_append(p_tenant uuid, p_changes jsonb)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_changes IS NULL OR p_changes = '[]'::jsonb THEN RETURN; END IF;
  PERFORM 1 FROM enterprise_tenants WHERE id = p_tenant FOR UPDATE;
  WITH entries AS MATERIALIZED (
    SELECT * FROM jsonb_to_recordset(p_changes) AS x(
      user_id uuid, resource_type text, resource_id uuid, revision integer, operation text, reason text
    )
  ), heads AS (
    SELECT users.user_id, COALESCE((
      SELECT max(c.sequence) FROM enterprise_context_changes c
      WHERE c.tenant_id = p_tenant AND c.user_id = users.user_id
    ), 0) AS head
    FROM (SELECT DISTINCT user_id FROM entries) users
  )
  INSERT INTO enterprise_context_changes (tenant_id, user_id, sequence, resource_type, resource_id, revision, operation, reason)
  SELECT p_tenant, e.user_id,
    h.head + row_number() OVER (PARTITION BY e.user_id ORDER BY e.resource_type, e.resource_id),
    e.resource_type, e.resource_id, e.revision, e.operation, e.reason
  FROM entries e JOIN heads h ON h.user_id = e.user_id;
END
$$;

CREATE FUNCTION enterprise_context_withdraw(
  p_tenant uuid, p_user uuid, p_scope text, p_scope_id uuid, p_resource_type text, p_resource_id uuid, p_reason text
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE changes jsonb;
BEGIN
  PERFORM 1 FROM enterprise_tenants WHERE id = p_tenant FOR UPDATE;
  WITH removed AS (
    DELETE FROM enterprise_context_visibility v
    WHERE v.tenant_id = p_tenant AND (p_user IS NULL OR v.user_id = p_user)
      AND (p_scope IS NULL OR (v.scope = p_scope AND v.scope_id = p_scope_id))
      AND (p_resource_type IS NULL OR (v.resource_type = p_resource_type AND v.resource_id = p_resource_id))
    RETURNING v.user_id, v.resource_type, v.resource_id, v.revision
  )
  SELECT jsonb_agg(to_jsonb(removed) || jsonb_build_object('operation', 'tombstone', 'reason', p_reason))
    INTO changes FROM removed;
  PERFORM enterprise_context_append(p_tenant, changes);
END
$$;

CREATE FUNCTION enterprise_context_reconcile(p_tenant uuid, p_user uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE changes jsonb;
BEGIN
  PERFORM 1 FROM enterprise_tenants WHERE id = p_tenant FOR UPDATE;
  WITH visible AS MATERIALIZED (
    SELECT 'memory' AS resource_type, m.id AS resource_id, m.scope, m.scope_id, m.revision
    FROM enterprise_memory_records m WHERE m.tenant_id = p_tenant AND m.status = 'active'
      AND (m.expires_at IS NULL OR m.expires_at > now()) AND enterprise_context_scope_allowed(p_tenant, p_user, m.scope, m.scope_id)
    UNION ALL
    SELECT 'knowledge', k.id, k.scope, k.scope_id, k.revision
    FROM enterprise_knowledge_documents k WHERE k.tenant_id = p_tenant AND k.status = 'ready'
      AND enterprise_context_scope_allowed(p_tenant, p_user, k.scope, k.scope_id)
  ), removed AS (
    DELETE FROM enterprise_context_visibility v
    WHERE v.tenant_id = p_tenant AND v.user_id = p_user AND NOT EXISTS (
      SELECT 1 FROM visible n WHERE (n.resource_type, n.resource_id) = (v.resource_type, v.resource_id)
    )
    RETURNING v.user_id, v.resource_type, v.resource_id, v.revision
  ), saved AS (
    INSERT INTO enterprise_context_visibility AS v (tenant_id, user_id, resource_type, resource_id, scope, scope_id, revision)
    SELECT p_tenant, p_user, resource_type, resource_id, scope, scope_id, revision FROM visible
    ON CONFLICT (tenant_id, user_id, resource_type, resource_id) DO UPDATE
      SET scope = EXCLUDED.scope, scope_id = EXCLUDED.scope_id, revision = EXCLUDED.revision
      WHERE v.revision <> EXCLUDED.revision
    RETURNING v.user_id, v.resource_type, v.resource_id, v.revision
  ), events AS (
    SELECT saved.*, 'upsert'::text AS operation, NULL::text AS reason FROM saved
    UNION ALL
    SELECT r.*, 'tombstone',
      CASE WHEN r.resource_type = 'memory' AND m.expires_at <= now() THEN 'expired' ELSE 'access_revoked' END
    FROM removed r LEFT JOIN enterprise_memory_records m
      ON r.resource_type = 'memory' AND m.tenant_id = p_tenant AND m.id = r.resource_id
  )
  SELECT jsonb_agg(to_jsonb(events)) INTO changes FROM events;
  PERFORM enterprise_context_append(p_tenant, changes);
END
$$;

CREATE FUNCTION enterprise_context_revoke_project_member() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (OLD.tenant_id, OLD.project_id, OLD.user_id) IS DISTINCT FROM (NEW.tenant_id, NEW.project_id, NEW.user_id) THEN
    PERFORM enterprise_context_withdraw(OLD.tenant_id, OLD.user_id, 'project_private', OLD.project_id, NULL, NULL, 'access_revoked');
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER enterprise_context_project_member_revoked AFTER DELETE OR UPDATE OF tenant_id, project_id, user_id
  ON enterprise_project_members FOR EACH ROW EXECUTE FUNCTION enterprise_context_revoke_project_member();

CREATE FUNCTION enterprise_context_revoke_project() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM enterprise_context_withdraw(OLD.tenant_id, NULL, 'project_private', OLD.id, NULL, NULL, 'access_revoked');
  RETURN NULL;
END
$$;
CREATE TRIGGER enterprise_context_project_inactive AFTER UPDATE OF active ON enterprise_projects
  FOR EACH ROW WHEN (OLD.active AND NOT NEW.active) EXECUTE FUNCTION enterprise_context_revoke_project();

CREATE FUNCTION enterprise_context_revoke_user() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.active AND NOT NEW.active THEN
    PERFORM enterprise_context_withdraw(OLD.tenant_id, OLD.id, NULL, NULL, NULL, NULL, 'access_revoked');
  ELSIF OLD.department_id IS NOT NULL AND OLD.department_id IS DISTINCT FROM NEW.department_id THEN
    PERFORM enterprise_context_withdraw(OLD.tenant_id, OLD.id, 'team_shared', OLD.department_id, NULL, NULL, 'access_revoked');
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER enterprise_context_user_acl_changed AFTER UPDATE OF department_id, active ON enterprise_users
  FOR EACH ROW EXECUTE FUNCTION enterprise_context_revoke_user();
