CREATE TABLE enterprise_development_tasks (
  tenant_id uuid NOT NULL REFERENCES enterprise_tenants(id),
  id uuid NOT NULL,
  demand_id uuid NOT NULL,
  approved_version_id uuid NOT NULL,
  approval_decision text GENERATED ALWAYS AS ('AGREE'::text) STORED,
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
  project_id uuid NOT NULL,
  assignee_id uuid NOT NULL,
  assigned_by uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('ASSIGNED', 'DEVELOPING', 'TESTING', 'ACCEPTANCE', 'DELIVERED')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  binding_id uuid,
  latest_run_id uuid,
  accepted_run_id uuid,
  review_decision text GENERATED ALWAYS AS ('ACCEPT'::text) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, demand_id, approved_version_id),
  UNIQUE (tenant_id, id, assignee_id),
  FOREIGN KEY (tenant_id, demand_id, approved_version_id, approval_decision)
    REFERENCES enterprise_demand_approvals(tenant_id, demand_id, version_id, decision),
  FOREIGN KEY (tenant_id, project_id) REFERENCES enterprise_projects(tenant_id, id),
  FOREIGN KEY (tenant_id, assignee_id) REFERENCES enterprise_users(tenant_id, id),
  FOREIGN KEY (tenant_id, assigned_by) REFERENCES enterprise_users(tenant_id, id),
  CHECK (state = 'ASSIGNED' OR binding_id IS NOT NULL),
  CHECK (accepted_run_id IS NULL OR (latest_run_id IS NOT NULL AND accepted_run_id = latest_run_id)),
  CHECK (state NOT IN ('TESTING', 'ACCEPTANCE', 'DELIVERED') OR accepted_run_id IS NOT NULL)
);
CREATE INDEX enterprise_development_tasks_project ON enterprise_development_tasks (tenant_id, project_id, updated_at DESC, id);

CREATE TABLE enterprise_delivery_bindings (
  tenant_id uuid NOT NULL,
  task_id uuid NOT NULL,
  id uuid NOT NULL,
  assignee_id uuid NOT NULL,
  device_id uuid NOT NULL REFERENCES enterprise_devices(id),
  worktree_id text NOT NULL CHECK (worktree_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$'),
  session_id text NOT NULL CHECK (session_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$'),
  git_revision text NOT NULL CHECK (git_revision ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, task_id, id),
  FOREIGN KEY (tenant_id, task_id, assignee_id) REFERENCES enterprise_development_tasks(tenant_id, id, assignee_id)
);

CREATE TABLE enterprise_delivery_check_runs (
  tenant_id uuid NOT NULL,
  task_id uuid NOT NULL,
  id uuid NOT NULL,
  binding_id uuid NOT NULL,
  submitted_by uuid NOT NULL,
  task_revision integer NOT NULL CHECK (task_revision > 0),
  request_id uuid,
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  rule_version text NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('PASS', 'WARN', 'BLOCK')),
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'array'),
  knowledge_refs jsonb NOT NULL CHECK (jsonb_typeof(knowledge_refs) = 'array'),
  findings jsonb NOT NULL CHECK (jsonb_typeof(findings) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, task_id, id),
  UNIQUE (tenant_id, task_id, request_id),
  UNIQUE (tenant_id, task_id, id, verdict),
  FOREIGN KEY (tenant_id, task_id, binding_id) REFERENCES enterprise_delivery_bindings(tenant_id, task_id, id),
  FOREIGN KEY (tenant_id, task_id, submitted_by) REFERENCES enterprise_development_tasks(tenant_id, id, assignee_id)
);

CREATE TABLE enterprise_delivery_reviews (
  tenant_id uuid NOT NULL,
  task_id uuid NOT NULL,
  run_id uuid NOT NULL,
  reviewer_id uuid NOT NULL,
  run_verdict text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('ACCEPT', 'REWORK')),
  acknowledged_warnings boolean NOT NULL DEFAULT false,
  note text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, task_id, run_id),
  UNIQUE (tenant_id, task_id, run_id, decision),
  FOREIGN KEY (tenant_id, task_id, run_id, run_verdict)
    REFERENCES enterprise_delivery_check_runs(tenant_id, task_id, id, verdict),
  FOREIGN KEY (tenant_id, reviewer_id) REFERENCES enterprise_users(tenant_id, id),
  CHECK (decision <> 'ACCEPT' OR (run_verdict <> 'BLOCK' AND (run_verdict <> 'WARN' OR acknowledged_warnings)))
);

ALTER TABLE enterprise_development_tasks
  ADD FOREIGN KEY (tenant_id, id, binding_id) REFERENCES enterprise_delivery_bindings(tenant_id, task_id, id),
  ADD FOREIGN KEY (tenant_id, id, latest_run_id) REFERENCES enterprise_delivery_check_runs(tenant_id, task_id, id),
  ADD FOREIGN KEY (tenant_id, id, accepted_run_id, review_decision)
    REFERENCES enterprise_delivery_reviews(tenant_id, task_id, run_id, decision);

CREATE TABLE enterprise_delivery_history (
  tenant_id uuid NOT NULL,
  task_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  actor_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('ASSIGNED', 'DEVELOPING', 'TESTING', 'ACCEPTANCE', 'DELIVERED')),
  action text NOT NULL,
  details jsonb NOT NULL CHECK (jsonb_typeof(details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, task_id, revision),
  FOREIGN KEY (tenant_id, task_id) REFERENCES enterprise_development_tasks(tenant_id, id),
  FOREIGN KEY (tenant_id, actor_id) REFERENCES enterprise_users(tenant_id, id)
);

CREATE FUNCTION enterprise_reject_delivery_evidence_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Delivery evidence is immutable' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER enterprise_delivery_bindings_frozen BEFORE UPDATE OR DELETE ON enterprise_delivery_bindings
  FOR EACH ROW EXECUTE FUNCTION enterprise_reject_delivery_evidence_change();
CREATE TRIGGER enterprise_delivery_check_runs_frozen BEFORE UPDATE OR DELETE ON enterprise_delivery_check_runs
  FOR EACH ROW EXECUTE FUNCTION enterprise_reject_delivery_evidence_change();
CREATE TRIGGER enterprise_delivery_reviews_frozen BEFORE UPDATE OR DELETE ON enterprise_delivery_reviews
  FOR EACH ROW EXECUTE FUNCTION enterprise_reject_delivery_evidence_change();
CREATE TRIGGER enterprise_delivery_history_frozen BEFORE UPDATE OR DELETE ON enterprise_delivery_history
  FOR EACH ROW EXECUTE FUNCTION enterprise_reject_delivery_evidence_change();
