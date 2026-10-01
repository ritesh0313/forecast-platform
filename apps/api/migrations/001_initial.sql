CREATE TABLE IF NOT EXISTS series (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  frequency text NOT NULL CHECK (frequency IN ('D', 'h')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS series_tenant_idx ON series (tenant_id, created_at);

CREATE TABLE IF NOT EXISTS observations (
  tenant_id uuid NOT NULL,
  series_id uuid NOT NULL,
  timestamp timestamptz NOT NULL,
  value double precision NOT NULL CHECK (value > '-Infinity'::float8 AND value < 'Infinity'::float8),
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, series_id, timestamp),
  FOREIGN KEY (tenant_id, series_id) REFERENCES series (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS training_jobs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  series_id uuid NOT NULL,
  run_id uuid NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  config jsonb NOT NULL,
  observation_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  error text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 5),
  lease_token uuid,
  lease_until timestamptz,
  heartbeat_at timestamptz,
  available_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, series_id) REFERENCES series (tenant_id, id),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_job_per_series ON training_jobs (tenant_id, series_id) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS training_jobs_queue_idx ON training_jobs (status, created_at);
CREATE INDEX IF NOT EXISTS training_jobs_tenant_idx ON training_jobs (tenant_id, series_id, created_at DESC);

CREATE TABLE IF NOT EXISTS model_runs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  series_id uuid NOT NULL,
  job_id uuid NOT NULL UNIQUE,
  selected_model text NOT NULL,
  data_cutoff timestamptz NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, series_id) REFERENCES series (tenant_id, id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES training_jobs (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS model_runs_tenant_idx ON model_runs (tenant_id, series_id, created_at DESC);
