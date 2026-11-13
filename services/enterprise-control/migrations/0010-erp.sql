CREATE TABLE enterprise_erp_activity (
  request_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES enterprise_tenants(id),
  actor_id uuid NOT NULL,
  project_id uuid NOT NULL,
  environment_id text NOT NULL,
  operation_key text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('started', 'succeeded', 'failed', 'denied')),
  returned_count integer CHECK (returned_count BETWEEN 0 AND 50),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  FOREIGN KEY (tenant_id, actor_id) REFERENCES enterprise_users(tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES enterprise_projects(tenant_id, id)
);
CREATE INDEX enterprise_erp_activity_by_tenant ON enterprise_erp_activity (tenant_id, occurred_at DESC);

CREATE TABLE enterprise_erp_operation_plans (
  tenant_id uuid NOT NULL REFERENCES enterprise_tenants(id),
  id uuid NOT NULL,
  project_id uuid NOT NULL,
  environment_id text NOT NULL,
  request_key uuid NOT NULL,
  requester_id uuid NOT NULL,
  approved_by uuid,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('pending', 'approved', 'rejected', 'executing', 'completed', 'unknown', 'failed')),
  decision_note text,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, requester_id, request_key),
  FOREIGN KEY (tenant_id, requester_id) REFERENCES enterprise_users(tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by) REFERENCES enterprise_users(tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES enterprise_projects(tenant_id, id),
  CHECK (approved_by IS NULL OR approved_by <> requester_id)
);
CREATE INDEX enterprise_erp_plans_by_project ON enterprise_erp_operation_plans (tenant_id, project_id, created_at DESC);

CREATE FUNCTION enterprise_erp_frozen_plan() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.tenant_id, OLD.id, OLD.project_id, OLD.environment_id, OLD.request_key, OLD.requester_id, OLD.snapshot, OLD.snapshot_hash, OLD.created_at)
     IS DISTINCT FROM
     (NEW.tenant_id, NEW.id, NEW.project_id, NEW.environment_id, NEW.request_key, NEW.requester_id, NEW.snapshot, NEW.snapshot_hash, NEW.created_at) THEN
    RAISE EXCEPTION 'ERP operation plan snapshot is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER enterprise_erp_preserve_plan BEFORE UPDATE ON enterprise_erp_operation_plans
  FOR EACH ROW EXECUTE FUNCTION enterprise_erp_frozen_plan();
