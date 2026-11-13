CREATE SEQUENCE enterprise_demand_number AS bigint;

CREATE TABLE enterprise_dingtalk_demand_templates (
  tenant_id uuid NOT NULL REFERENCES enterprise_tenants(id),
  process_code text NOT NULL,
  label text NOT NULL,
  field_map jsonb NOT NULL CHECK (jsonb_typeof(field_map) = 'object'),
  approver_options jsonb NOT NULL CHECK (jsonb_typeof(approver_options) = 'array'),
  submit_enabled boolean NOT NULL,
  import_enabled boolean NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, process_code)
);

CREATE TABLE enterprise_dingtalk_demand_identities (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  corp_id text NOT NULL,
  staff_id text NOT NULL,
  department_id bigint NOT NULL CHECK (department_id >= -1 AND department_id <= 9007199254740991),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, corp_id),
  UNIQUE (tenant_id, corp_id, staff_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES enterprise_users(tenant_id, id)
);

CREATE TABLE enterprise_demands (
  tenant_id uuid NOT NULL REFERENCES enterprise_tenants(id),
  id uuid NOT NULL,
  demand_no text NOT NULL DEFAULT ('REQ-' || to_char(now() AT TIME ZONE 'UTC', 'YYYY') || '-' || nextval('enterprise_demand_number')::text),
  owner_id uuid,
  draft jsonb NOT NULL CHECK (jsonb_typeof(draft) = 'object'),
  draft_revision integer NOT NULL DEFAULT 1 CHECK (draft_revision > 0),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  precheck jsonb CHECK (precheck IS NULL OR jsonb_typeof(precheck) = 'object'),
  state text NOT NULL CHECK (state IN ('DRAFT', 'AI_PRECHECK', 'SUBMITTING', 'SUBMIT_FAILED', 'PENDING', 'IMPORT_REVIEW', 'BACKLOG', 'REJECTED', 'CANCELLED', 'CHANGE_REQUEST')),
  origin text NOT NULL CHECK (origin IN ('WORKBENCH', 'DINGTALK')),
  import_confirmed boolean NOT NULL DEFAULT true,
  active_version_id uuid,
  approved_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, demand_no),
  FOREIGN KEY (tenant_id, owner_id) REFERENCES enterprise_users(tenant_id, id),
  CHECK (state <> 'BACKLOG' OR approved_version_id IS NOT NULL),
  CHECK (origin <> 'WORKBENCH' OR (owner_id IS NOT NULL AND import_confirmed))
);
CREATE INDEX enterprise_demands_owner ON enterprise_demands (tenant_id, owner_id, updated_at DESC, id);
CREATE INDEX enterprise_demands_backlog ON enterprise_demands (tenant_id, updated_at DESC, id) WHERE approved_version_id IS NOT NULL;

CREATE TABLE enterprise_demand_versions (
  tenant_id uuid NOT NULL,
  demand_id uuid NOT NULL,
  id uuid NOT NULL,
  version_no integer NOT NULL CHECK (version_no > 0),
  draft_revision integer NOT NULL CHECK (draft_revision > 0),
  submitted_by uuid,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
  body_hash text NOT NULL CHECK (body_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, demand_id, id),
  UNIQUE (tenant_id, demand_id, version_no),
  FOREIGN KEY (tenant_id, demand_id) REFERENCES enterprise_demands(tenant_id, id),
  FOREIGN KEY (tenant_id, submitted_by) REFERENCES enterprise_users(tenant_id, id)
);
ALTER TABLE enterprise_demands ADD FOREIGN KEY (tenant_id, id, active_version_id)
  REFERENCES enterprise_demand_versions(tenant_id, demand_id, id);
ALTER TABLE enterprise_demands ADD FOREIGN KEY (tenant_id, id, approved_version_id)
  REFERENCES enterprise_demand_versions(tenant_id, demand_id, id);

CREATE TABLE enterprise_demand_submissions (
  tenant_id uuid NOT NULL,
  demand_id uuid NOT NULL,
  version_id uuid NOT NULL,
  request_id uuid NOT NULL,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('QUEUED', 'DISPATCHING', 'UNCONFIRMED', 'LINKED', 'CLOSED', 'DECLINED')),
  corp_id text NOT NULL,
  process_code text NOT NULL,
  originator_user_id text NOT NULL,
  request jsonb NOT NULL CHECK (jsonb_typeof(request) = 'object'),
  version_ref_field jsonb NOT NULL CHECK (jsonb_typeof(version_ref_field) = 'object'),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  next_check_at timestamptz NOT NULL DEFAULT now(),
  error_code text,
  PRIMARY KEY (tenant_id, demand_id, version_id),
  UNIQUE (tenant_id, demand_id, request_id),
  FOREIGN KEY (tenant_id, demand_id, version_id) REFERENCES enterprise_demand_versions(tenant_id, demand_id, id)
);
CREATE UNIQUE INDEX enterprise_demand_one_open_submission ON enterprise_demand_submissions (tenant_id, demand_id)
  WHERE state IN ('QUEUED', 'DISPATCHING', 'UNCONFIRMED', 'LINKED');
CREATE INDEX enterprise_demand_dispatch_due ON enterprise_demand_submissions (tenant_id, next_check_at)
  WHERE state IN ('QUEUED', 'DISPATCHING', 'UNCONFIRMED');

CREATE TABLE enterprise_dingtalk_demand_instances (
  tenant_id uuid NOT NULL,
  instance_id text NOT NULL,
  corp_id text NOT NULL,
  process_code text NOT NULL,
  demand_id uuid NOT NULL,
  version_id uuid NOT NULL,
  originator_user_id text NOT NULL,
  approver_user_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  state text NOT NULL DEFAULT 'UNKNOWN' CHECK (state IN ('UNKNOWN', 'RUNNING', 'AGREE', 'REFUSE', 'TERMINATED')),
  next_check_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  PRIMARY KEY (tenant_id, instance_id),
  UNIQUE (tenant_id, demand_id, version_id),
  UNIQUE (tenant_id, instance_id, demand_id, version_id),
  FOREIGN KEY (tenant_id, demand_id, version_id) REFERENCES enterprise_demand_versions(tenant_id, demand_id, id)
);
CREATE INDEX enterprise_dingtalk_demand_poll_due ON enterprise_dingtalk_demand_instances (tenant_id, next_check_at)
  WHERE state IN ('UNKNOWN', 'RUNNING');

CREATE TABLE enterprise_demand_approvals (
  tenant_id uuid NOT NULL,
  instance_id text NOT NULL,
  demand_id uuid NOT NULL,
  version_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('AGREE', 'REFUSE', 'TERMINATED')),
  decided_at timestamptz,
  verified_at timestamptz NOT NULL DEFAULT now(),
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (tenant_id, instance_id),
  UNIQUE (tenant_id, demand_id, version_id, decision),
  FOREIGN KEY (tenant_id, instance_id, demand_id, version_id)
    REFERENCES enterprise_dingtalk_demand_instances(tenant_id, instance_id, demand_id, version_id)
);

CREATE FUNCTION enterprise_reject_demand_evidence_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Frozen demand evidence cannot be changed' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER enterprise_demand_versions_frozen BEFORE UPDATE OR DELETE ON enterprise_demand_versions
  FOR EACH ROW EXECUTE FUNCTION enterprise_reject_demand_evidence_change();
CREATE TRIGGER enterprise_demand_approvals_frozen BEFORE UPDATE OR DELETE ON enterprise_demand_approvals
  FOR EACH ROW EXECUTE FUNCTION enterprise_reject_demand_evidence_change();

ALTER TABLE enterprise_demands ADD COLUMN approved_decision text GENERATED ALWAYS AS ('AGREE'::text) STORED;
ALTER TABLE enterprise_demands ADD FOREIGN KEY (tenant_id, id, approved_version_id, approved_decision)
  REFERENCES enterprise_demand_approvals(tenant_id, demand_id, version_id, decision);

CREATE TABLE enterprise_dingtalk_demand_inbox (
  tenant_id uuid NOT NULL REFERENCES enterprise_tenants(id),
  event_id text NOT NULL,
  corp_id text NOT NULL,
  process_code text NOT NULL,
  instance_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('start', 'finish', 'terminate', 'scan')),
  received_at timestamptz NOT NULL DEFAULT now(),
  next_check_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  processed_at timestamptz,
  PRIMARY KEY (tenant_id, event_id)
);
CREATE INDEX enterprise_dingtalk_demand_inbox_due ON enterprise_dingtalk_demand_inbox (tenant_id, next_check_at)
  WHERE processed_at IS NULL;
