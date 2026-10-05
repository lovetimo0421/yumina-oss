// Admission history is independent of storage objects: deleting or cancelling
// an upload must not refund its rolling budget, and retries must not recharge it.
export const CREATIVE_UPLOAD_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS creative_upload_admissions (
    user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    source_kind text NOT NULL CHECK (source_kind IN ('file','archive')),
    operation_id text NOT NULL,
    bytes bigint NOT NULL CHECK (bytes >= 0),
    admitted_at timestamp NOT NULL DEFAULT clock_timestamp(),
    completed_at timestamp,
    PRIMARY KEY (user_id, source_kind, operation_id)
  )`,
  `ALTER TABLE creative_upload_admissions ADD COLUMN IF NOT EXISTS completed_at timestamp`,
  `CREATE INDEX IF NOT EXISTS creative_upload_admissions_window_idx
    ON creative_upload_admissions(user_id, admitted_at)`,
];
