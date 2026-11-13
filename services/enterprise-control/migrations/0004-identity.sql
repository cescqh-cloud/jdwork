ALTER TABLE enterprise_external_identities
  DROP CONSTRAINT enterprise_external_identities_pkey,
  ADD PRIMARY KEY (tenant_id, issuer, subject);
