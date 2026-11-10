export const TURN_IMAGE_TASK_DDLS = [`CREATE TABLE IF NOT EXISTS turn_image_tasks (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  message_id text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  charge jsonb,
  created_at timestamp NOT NULL DEFAULT now(),
  expires_at timestamp NOT NULL DEFAULT now() + interval '10 minutes'
)`, `CREATE INDEX IF NOT EXISTS turn_image_tasks_pending_idx ON turn_image_tasks(expires_at) WHERE status = 'running'`];
