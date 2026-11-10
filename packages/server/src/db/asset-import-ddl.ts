/** Additive, repeatable installation for both hosted Postgres and local PGlite. */
export const ASSET_IMPORT_DDL = `
CREATE TABLE IF NOT EXISTS asset_import_jobs (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  filename text NOT NULL,
  folder_id text,
  input_bytes bigint NOT NULL CHECK (input_bytes > 0),
  expanded_bytes bigint NOT NULL DEFAULT 0,
  reserved_bytes bigint NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
  file_count integer NOT NULL DEFAULT 0,
  ignored_count integer NOT NULL DEFAULT 0,
  preserve_folders boolean NOT NULL DEFAULT true,
  conflict text NOT NULL DEFAULT 'rename' CHECK (conflict IN ('rename','skip')),
  status text NOT NULL DEFAULT 'uploading' CHECK (status IN
    ('uploading','queued_inspect','inspecting','ready','queued','processing','completed','partial','failed','cancelled','expired')),
  error_code text,
  manifest_validated_at timestamptz,
  confirmed_at timestamptz,
  queued_at timestamptz,
  priority integer NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 2),
  lease_token text,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  upload_expires_at timestamptz NOT NULL DEFAULT now() + interval '1 hour',
  cleaned_at timestamptz,
  dismissed_at timestamptz
);
ALTER TABLE asset_import_jobs ADD COLUMN IF NOT EXISTS upload_expires_at timestamptz NOT NULL DEFAULT now() + interval '1 hour';
ALTER TABLE asset_import_jobs ADD COLUMN IF NOT EXISTS manifest_validated_at timestamptz;
ALTER TABLE asset_import_jobs ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;
ALTER TABLE asset_import_jobs ADD COLUMN IF NOT EXISTS queued_at timestamptz;
ALTER TABLE asset_import_jobs ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 2);
CREATE INDEX IF NOT EXISTS asset_import_owner_idx ON asset_import_jobs(user_id, created_at);
CREATE INDEX IF NOT EXISTS asset_import_worker_idx ON asset_import_jobs(status, lease_expires_at);
CREATE INDEX IF NOT EXISTS asset_import_owner_worker_idx ON asset_import_jobs(user_id, status, lease_expires_at);
CREATE INDEX IF NOT EXISTS asset_import_cleanup_idx ON asset_import_jobs(expires_at) WHERE cleaned_at IS NULL;
CREATE TABLE IF NOT EXISTS asset_import_entries (
  job_id text NOT NULL REFERENCES asset_import_jobs(id) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  path text NOT NULL,
  size_bytes bigint NOT NULL,
  mime_type text NOT NULL,
  asset_type text NOT NULL,
  asset_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','skipped','failed')),
  error_code text,
  PRIMARY KEY (job_id, ordinal),
  UNIQUE (job_id, path)
);
CREATE TABLE IF NOT EXISTS asset_import_retries (
  id text PRIMARY KEY,
  job_id text NOT NULL REFERENCES asset_import_jobs(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  accepted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS asset_import_retry_owner_idx ON asset_import_retries(user_id, accepted_at);
CREATE INDEX IF NOT EXISTS asset_import_retry_job_idx ON asset_import_retries(job_id, accepted_at);
-- These markers recover provable legacy state, not historical budget timestamps.
-- Never infer confirmation merely from a manifest: a quota failure also retains it.
UPDATE asset_import_jobs j SET manifest_validated_at=now()
WHERE manifest_validated_at IS NULL AND file_count>0
  AND EXISTS(SELECT 1 FROM asset_import_entries e WHERE e.job_id=j.id);
UPDATE asset_import_jobs j SET confirmed_at=now()
WHERE confirmed_at IS NULL AND (status IN ('queued','processing','partial','completed')
  OR EXISTS(SELECT 1 FROM asset_import_entries e WHERE e.job_id=j.id AND e.status IN ('succeeded','skipped','failed')));
UPDATE asset_import_jobs SET queued_at=created_at
WHERE queued_at IS NULL AND status IN ('queued_inspect','inspecting','queued','processing');
`;
