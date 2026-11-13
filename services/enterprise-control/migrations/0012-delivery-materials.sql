ALTER TABLE enterprise_delivery_check_runs
  ADD COLUMN selection_receipt text CHECK (selection_receipt ~ '^[A-Za-z0-9_-]{86}$');

ALTER TABLE enterprise_development_tasks
  ADD COLUMN material_verified_at timestamptz,
  ADD COLUMN material_invalidated_at timestamptz,
  ADD CHECK (material_verified_at IS NULL OR material_invalidated_at IS NULL),
  ADD CHECK (latest_run_id IS NOT NULL OR (material_verified_at IS NULL AND material_invalidated_at IS NULL));
