ALTER TABLE enterprise_model_usage ALTER COLUMN device_id DROP NOT NULL,
  ADD COLUMN purpose text NOT NULL DEFAULT 'interactive' CHECK (purpose IN ('interactive', 'demand_precheck')),
  ADD CHECK (device_id IS NOT NULL OR purpose = 'demand_precheck');
