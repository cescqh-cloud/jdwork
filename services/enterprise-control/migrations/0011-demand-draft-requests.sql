CREATE TABLE enterprise_demand_draft_requests (
  tenant_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  request_id uuid NOT NULL,
  demand_id uuid NOT NULL,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  draft_revision integer NOT NULL CHECK (draft_revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, actor_id, request_id),
  FOREIGN KEY (tenant_id, actor_id) REFERENCES enterprise_users(tenant_id, id),
  FOREIGN KEY (tenant_id, demand_id) REFERENCES enterprise_demands(tenant_id, id)
);
