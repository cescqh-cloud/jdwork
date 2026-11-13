CREATE TABLE enterprise_client_releases (
  tenant_id uuid NOT NULL REFERENCES enterprise_tenants(id),
  id uuid NOT NULL,
  platform text NOT NULL CHECK (platform IN ('win32', 'darwin', 'linux')),
  arch text NOT NULL CHECK (arch IN ('x64', 'arm64', 'ia32')),
  channel text NOT NULL CHECK (channel IN ('dev', 'canary', 'stable')),
  version text NOT NULL CHECK (char_length(version) BETWEEN 5 AND 96),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED', 'PAUSED', 'WITHDRAWN')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  rollout_percent integer NOT NULL CHECK (rollout_percent BETWEEN 0 AND 100),
  target_devices uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  target_users uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  target_departments uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  min_client_version text,
  max_tested_version text,
  security_required boolean NOT NULL DEFAULT false,
  failure_min_sample integer NOT NULL CHECK (failure_min_sample BETWEEN 1 AND 1000),
  failure_threshold_percent integer NOT NULL CHECK (failure_threshold_percent BETWEEN 1 AND 100),
  manifest_bytes bytea CHECK (manifest_bytes IS NULL OR octet_length(manifest_bytes) BETWEEN 1 AND 65536),
  manifest_sha256 text CHECK (manifest_sha256 IS NULL OR manifest_sha256 ~ '^[0-9a-f]{64}$'),
  artifact_name text,
  artifact_size bigint CHECK (artifact_size IS NULL OR artifact_size BETWEEN 1 AND 2147483648),
  artifact_sha512 text,
  artifact_sha256 text CHECK (artifact_sha256 IS NULL OR artifact_sha256 ~ '^[0-9a-f]{64}$'),
  signer_fingerprint text CHECK (signer_fingerprint IS NULL OR signer_fingerprint ~ '^[0-9a-f]{64}$'),
  signer_publisher text,
  signer_kind text CHECK (signer_kind IS NULL OR signer_kind IN ('authenticode', 'test-fixture')),
  proof jsonb CHECK (proof IS NULL OR jsonb_typeof(proof) = 'object'),
  test_evidence text,
  created_by uuid NOT NULL,
  published_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  paused_at timestamptz,
  pause_reason text,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, platform, arch, channel, version),
  FOREIGN KEY (tenant_id, created_by) REFERENCES enterprise_users(tenant_id, id),
  FOREIGN KEY (tenant_id, published_by) REFERENCES enterprise_users(tenant_id, id),
  CHECK ((manifest_bytes IS NULL AND manifest_sha256 IS NULL AND artifact_name IS NULL AND artifact_size IS NULL AND artifact_sha512 IS NULL)
    OR (manifest_bytes IS NOT NULL AND manifest_sha256 IS NOT NULL AND artifact_name IS NOT NULL AND artifact_size IS NOT NULL AND artifact_sha512 IS NOT NULL)),
  CHECK ((artifact_sha256 IS NULL AND signer_fingerprint IS NULL AND signer_publisher IS NULL AND signer_kind IS NULL)
    OR (artifact_sha256 IS NOT NULL AND manifest_bytes IS NOT NULL AND signer_fingerprint IS NOT NULL AND signer_publisher IS NOT NULL AND signer_kind IS NOT NULL)),
  CHECK (status NOT IN ('PUBLISHED', 'PAUSED') OR
    (artifact_sha256 IS NOT NULL AND proof IS NOT NULL AND test_evidence IS NOT NULL AND published_by IS NOT NULL AND published_at IS NOT NULL)),
  CHECK (status <> 'PAUSED' OR (paused_at IS NOT NULL AND pause_reason IS NOT NULL)),
  CHECK (NOT security_required OR min_client_version IS NOT NULL),
  CHECK (channel <> 'dev' OR cardinality(target_devices) + cardinality(target_users) + cardinality(target_departments) > 0)
);
CREATE INDEX enterprise_client_release_candidates ON enterprise_client_releases (tenant_id, platform, arch, channel, published_at DESC)
  WHERE status = 'PUBLISHED';

CREATE FUNCTION enterprise_protect_client_release() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Release evidence cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF ROW(NEW.tenant_id, NEW.id, NEW.platform, NEW.arch, NEW.channel, NEW.version, NEW.created_by, NEW.created_at)
      IS DISTINCT FROM ROW(OLD.tenant_id, OLD.id, OLD.platform, OLD.arch, OLD.channel, OLD.version, OLD.created_by, OLD.created_at) OR
    (OLD.artifact_sha256 IS NOT NULL AND
      ROW(NEW.manifest_bytes, NEW.manifest_sha256, NEW.artifact_name, NEW.artifact_size, NEW.artifact_sha512,
        NEW.artifact_sha256, NEW.signer_fingerprint, NEW.signer_publisher, NEW.signer_kind)
      IS DISTINCT FROM ROW(OLD.manifest_bytes, OLD.manifest_sha256, OLD.artifact_name, OLD.artifact_size, OLD.artifact_sha512,
        OLD.artifact_sha256, OLD.signer_fingerprint, OLD.signer_publisher, OLD.signer_kind)) OR
    (OLD.published_at IS NOT NULL AND
      ROW(NEW.rollout_percent, NEW.target_devices, NEW.target_users, NEW.target_departments, NEW.min_client_version,
        NEW.max_tested_version, NEW.security_required, NEW.failure_min_sample, NEW.failure_threshold_percent,
        NEW.proof, NEW.test_evidence, NEW.published_at, NEW.published_by)
      IS DISTINCT FROM ROW(OLD.rollout_percent, OLD.target_devices, OLD.target_users, OLD.target_departments, OLD.min_client_version,
        OLD.max_tested_version, OLD.security_required, OLD.failure_min_sample, OLD.failure_threshold_percent,
        OLD.proof, OLD.test_evidence, OLD.published_at, OLD.published_by)) OR
    (OLD.status = 'PUBLISHED' AND NEW.status NOT IN ('PUBLISHED', 'PAUSED')) OR
    (OLD.status = 'PAUSED' AND NEW.status NOT IN ('PAUSED', 'WITHDRAWN')) OR
    (OLD.status = 'WITHDRAWN' AND NEW.status <> 'WITHDRAWN') THEN
    RAISE EXCEPTION 'Published client release metadata is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER enterprise_client_release_frozen BEFORE UPDATE OR DELETE ON enterprise_client_releases
  FOR EACH ROW EXECUTE FUNCTION enterprise_protect_client_release();

CREATE TABLE enterprise_update_devices (
  tenant_id uuid NOT NULL REFERENCES enterprise_tenants(id),
  device_id uuid NOT NULL REFERENCES enterprise_devices(id),
  arch text NOT NULL CHECK (arch IN ('x64', 'arm64', 'ia32')),
  installed_version text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, device_id)
);

CREATE TABLE enterprise_update_offers (
  tenant_id uuid NOT NULL,
  release_id uuid NOT NULL,
  device_id uuid NOT NULL,
  offered_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  offered_from_version text NOT NULL,
  PRIMARY KEY (tenant_id, release_id, device_id),
  FOREIGN KEY (tenant_id, release_id) REFERENCES enterprise_client_releases(tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES enterprise_update_devices(tenant_id, device_id)
);

CREATE TABLE enterprise_update_reports (
  tenant_id uuid NOT NULL,
  device_id uuid NOT NULL,
  event_id uuid NOT NULL,
  release_id uuid NOT NULL,
  stage text NOT NULL CHECK (stage IN ('downloaded', 'installed', 'healthy', 'failed')),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, device_id, event_id),
  FOREIGN KEY (tenant_id, release_id, device_id) REFERENCES enterprise_update_offers(tenant_id, release_id, device_id),
  CHECK ((stage = 'failed') = (error_code IS NOT NULL))
);

CREATE TABLE enterprise_update_health (
  tenant_id uuid NOT NULL,
  release_id uuid NOT NULL,
  device_id uuid NOT NULL,
  latest_stage text NOT NULL CHECK (latest_stage IN ('downloaded', 'installed', 'healthy', 'failed')),
  error_code text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, release_id, device_id),
  FOREIGN KEY (tenant_id, release_id, device_id) REFERENCES enterprise_update_offers(tenant_id, release_id, device_id),
  CHECK ((latest_stage = 'failed') = (error_code IS NOT NULL))
);
