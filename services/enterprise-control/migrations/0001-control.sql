CREATE TABLE enterprise_tenants (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,47}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  active boolean NOT NULL DEFAULT true,
  policy_revision integer NOT NULL DEFAULT 1 CHECK (policy_revision > 0),
  event_sequence bigint NOT NULL DEFAULT 0 CHECK (event_sequence BETWEEN 0 AND 9007199254740991)
);

CREATE TABLE enterprise_users (
  tenant_id uuid NOT NULL REFERENCES enterprise_tenants(id),
  id uuid NOT NULL,
  login text NOT NULL CHECK (login = lower(login) AND char_length(login) BETWEEN 1 AND 120),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120),
  password_hash text,
  active boolean NOT NULL DEFAULT true,
  roles text[] NOT NULL CHECK (cardinality(roles) BETWEEN 1 AND 7 AND roles <@
    ARRAY['platform_admin', 'it_lead', 'project_owner', 'developer', 'requester', 'approver', 'auditor']::text[]),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, login)
);

CREATE TABLE enterprise_external_identities (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  issuer text NOT NULL,
  subject text NOT NULL,
  PRIMARY KEY (issuer, subject),
  FOREIGN KEY (tenant_id, user_id) REFERENCES enterprise_users(tenant_id, id)
);

CREATE TABLE enterprise_web_sessions (
  token_digest text PRIMARY KEY,
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (tenant_id, user_id) REFERENCES enterprise_users(tenant_id, id)
);
CREATE INDEX enterprise_web_sessions_expiry ON enterprise_web_sessions (expires_at);

CREATE TABLE enterprise_enrollment_challenges (
  token_digest text PRIMARY KEY,
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  FOREIGN KEY (tenant_id, user_id) REFERENCES enterprise_users(tenant_id, id)
);
CREATE INDEX enterprise_enrollment_challenges_expiry ON enterprise_enrollment_challenges (expires_at);

CREATE TABLE enterprise_devices (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  public_key text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('win32', 'darwin', 'linux')),
  client_version text NOT NULL,
  registered_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  FOREIGN KEY (tenant_id, user_id) REFERENCES enterprise_users(tenant_id, id)
);
CREATE INDEX enterprise_devices_tenant_owner ON enterprise_devices (tenant_id, user_id);

CREATE TABLE enterprise_device_sessions (
  device_id uuid PRIMARY KEY REFERENCES enterprise_devices(id),
  access_digest text NOT NULL UNIQUE,
  refresh_digest text NOT NULL UNIQUE,
  access_expires_at timestamptz NOT NULL,
  refresh_expires_at timestamptz NOT NULL
);

CREATE TABLE enterprise_events (
  tenant_id uuid NOT NULL REFERENCES enterprise_tenants(id),
  sequence bigint NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
  event_id uuid NOT NULL UNIQUE,
  user_id uuid,
  event_type text NOT NULL,
  resource_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, sequence),
  FOREIGN KEY (tenant_id, user_id) REFERENCES enterprise_users(tenant_id, id)
);
CREATE INDEX enterprise_events_by_owner ON enterprise_events (tenant_id, user_id, sequence);

CREATE TABLE enterprise_audit (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES enterprise_tenants(id),
  actor_id uuid,
  action text NOT NULL,
  target_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, actor_id) REFERENCES enterprise_users(tenant_id, id)
);
CREATE INDEX enterprise_audit_by_tenant ON enterprise_audit (tenant_id, occurred_at DESC);
