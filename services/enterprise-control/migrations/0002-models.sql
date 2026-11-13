CREATE TABLE enterprise_departments (
  tenant_id uuid NOT NULL REFERENCES enterprise_tenants(id),
  id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, name)
);

ALTER TABLE enterprise_users ADD COLUMN department_id uuid,
  ADD FOREIGN KEY (tenant_id, department_id) REFERENCES enterprise_departments(tenant_id, id);

CREATE TABLE enterprise_projects (
  tenant_id uuid NOT NULL REFERENCES enterprise_tenants(id),
  id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  classification text NOT NULL CHECK (classification IN ('general', 'internal', 'restricted')),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE enterprise_project_members (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  user_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, project_id, user_id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES enterprise_projects(tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES enterprise_users(tenant_id, id)
);

CREATE TABLE enterprise_model_providers (
  tenant_id uuid NOT NULL REFERENCES enterprise_tenants(id),
  id text NOT NULL,
  display_name text NOT NULL,
  protocol text NOT NULL CHECK (protocol IN ('anthropic', 'openai')),
  base_url text NOT NULL,
  sealed_key text NOT NULL,
  auth_header text NOT NULL CHECK (auth_header IN ('bearer', 'x-api-key')),
  classifications text[] NOT NULL CHECK (cardinality(classifications) > 0 AND classifications <@
    ARRAY['general', 'internal', 'restricted']::text[]),
  stream_usage boolean NOT NULL,
  enabled boolean NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE enterprise_models (
  tenant_id uuid NOT NULL REFERENCES enterprise_tenants(id),
  id text NOT NULL,
  provider_id text NOT NULL,
  upstream_model text NOT NULL,
  display_name text NOT NULL,
  capabilities text[] NOT NULL CHECK ('text' = ANY(capabilities) AND capabilities <@
    ARRAY['text', 'tools', 'vision', 'reasoning']::text[]),
  context_window integer NOT NULL CHECK (context_window BETWEEN 1024 AND 2000000),
  max_output_tokens integer NOT NULL CHECK (max_output_tokens BETWEEN 1 AND context_window),
  default_effort text CHECK (default_effort IN ('low', 'medium', 'high')),
  allowed_roles text[] NOT NULL CHECK (cardinality(allowed_roles) > 0 AND allowed_roles <@
    ARRAY['platform_admin', 'it_lead', 'project_owner', 'developer', 'requester', 'approver', 'auditor']::text[]),
  project_id uuid,
  is_default boolean NOT NULL,
  daily_tokens bigint CHECK (daily_tokens BETWEEN 1 AND 1000000000),
  soft_daily_tokens bigint CHECK (soft_daily_tokens BETWEEN 1 AND 1000000000 AND
    (daily_tokens IS NULL OR soft_daily_tokens <= daily_tokens)),
  enabled boolean NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, provider_id) REFERENCES enterprise_model_providers(tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES enterprise_projects(tenant_id, id)
);
CREATE UNIQUE INDEX enterprise_models_default_per_scope ON enterprise_models (tenant_id, project_id) NULLS NOT DISTINCT
  WHERE enabled AND is_default;

CREATE TABLE enterprise_model_grants (
  token_digest text PRIMARY KEY,
  tenant_id uuid NOT NULL,
  model_id text NOT NULL,
  device_id uuid NOT NULL REFERENCES enterprise_devices(id),
  session_id text NOT NULL,
  project_id uuid,
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (tenant_id, model_id) REFERENCES enterprise_models(tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES enterprise_projects(tenant_id, id)
);
CREATE INDEX enterprise_model_grants_expiry ON enterprise_model_grants(expires_at);

CREATE TABLE enterprise_model_usage (
  request_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  department_id uuid,
  project_id uuid,
  device_id uuid NOT NULL REFERENCES enterprise_devices(id),
  session_id text NOT NULL,
  provider_id text NOT NULL,
  model_id text NOT NULL,
  api_kind text NOT NULL CHECK (api_kind IN ('messages', 'count_tokens', 'chat_completions')),
  status text NOT NULL CHECK (status IN ('streaming', 'completed', 'cancelled', 'timed_out', 'upstream_error')),
  reserved_tokens integer NOT NULL CHECK (reserved_tokens >= 0),
  charged_tokens bigint CHECK (charged_tokens >= 0),
  input_tokens bigint CHECK (input_tokens >= 0),
  output_tokens bigint CHECK (output_tokens >= 0),
  usage_source text CHECK (usage_source IN ('provider', 'reserved', 'none')),
  soft_limit_reached boolean NOT NULL DEFAULT false,
  upstream_status integer,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  FOREIGN KEY (tenant_id, user_id) REFERENCES enterprise_users(tenant_id, id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES enterprise_departments(tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES enterprise_projects(tenant_id, id),
  FOREIGN KEY (tenant_id, model_id) REFERENCES enterprise_models(tenant_id, id),
  FOREIGN KEY (tenant_id, provider_id) REFERENCES enterprise_model_providers(tenant_id, id)
);
CREATE INDEX enterprise_model_usage_by_owner ON enterprise_model_usage(tenant_id, user_id, started_at DESC);
CREATE INDEX enterprise_model_usage_by_tenant ON enterprise_model_usage(tenant_id, started_at DESC);
