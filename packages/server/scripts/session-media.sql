CREATE TABLE IF NOT EXISTS session_media (
  id text PRIMARY KEY, user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  filename text NOT NULL, hash text NOT NULL, object_key text NOT NULL, thumbnail_key text NOT NULL,
  size_bytes bigint NOT NULL CHECK(size_bytes >= 0), width integer NOT NULL, height integer NOT NULL,
  status text NOT NULL DEFAULT 'ready' CHECK(status IN ('ready','deleting','deleted')),
  revision integer NOT NULL DEFAULT 1, unreferenced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS session_media_hash_uq ON session_media(user_id,hash) WHERE status='ready';
CREATE INDEX IF NOT EXISTS session_media_owner_idx ON session_media(user_id,created_at,id);
CREATE INDEX IF NOT EXISTS session_media_deleting_idx ON session_media(id) WHERE status='deleting';
CREATE INDEX IF NOT EXISTS session_media_unreferenced_idx ON session_media(unreferenced_at) WHERE status='ready' AND unreferenced_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS session_media_uploads (
  id text PRIMARY KEY, user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  session_id text REFERENCES play_sessions(id) ON DELETE SET NULL,
  entry_id text NOT NULL, filename text NOT NULL, content_type text NOT NULL,
  input_bytes bigint NOT NULL, reserved_bytes bigint NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}', temp_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','complete','expired')),
  attempt text, attempts jsonb NOT NULL DEFAULT '[]', processing_at timestamptz, media_id text REFERENCES session_media(id),
  expires_at timestamptz NOT NULL, cleaned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS session_media_upload_owner_idx ON session_media_uploads(user_id,created_at);
CREATE INDEX IF NOT EXISTS session_media_upload_cleanup_idx ON session_media_uploads(expires_at) WHERE cleaned_at IS NULL;
CREATE TABLE IF NOT EXISTS session_media_refs (
  id text PRIMARY KEY, media_id text NOT NULL REFERENCES session_media(id) ON DELETE CASCADE,
  session_id text REFERENCES play_sessions(id) ON DELETE CASCADE,
  checkpoint_id text REFERENCES checkpoints(id) ON DELETE CASCADE,
  share_id text REFERENCES shared_playthroughs(id) ON DELETE CASCADE,
  entry_id text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}', version integer NOT NULL DEFAULT 1,
  added_at timestamptz NOT NULL DEFAULT clock_timestamp(), removed_at timestamptz,
  CHECK(num_nonnulls(session_id,checkpoint_id,share_id)=1)
);
CREATE UNIQUE INDEX IF NOT EXISTS session_media_live_entry_uq ON session_media_refs(session_id,entry_id) WHERE session_id IS NOT NULL AND removed_at IS NULL;
CREATE INDEX IF NOT EXISTS session_media_ref_file_idx ON session_media_refs(media_id);
CREATE INDEX IF NOT EXISTS session_media_ref_session_idx ON session_media_refs(session_id,added_at,removed_at);
CREATE INDEX IF NOT EXISTS session_media_ref_checkpoint_idx ON session_media_refs(checkpoint_id);
CREATE INDEX IF NOT EXISTS session_media_ref_share_idx ON session_media_refs(share_id);
CREATE TABLE IF NOT EXISTS session_media_documents (
  id text PRIMARY KEY, session_id text REFERENCES play_sessions(id) ON DELETE CASCADE,
  checkpoint_id text REFERENCES checkpoints(id) ON DELETE CASCADE,
  share_id text REFERENCES shared_playthroughs(id) ON DELETE CASCADE,
  value jsonb NOT NULL DEFAULT '{}', version integer NOT NULL,
  added_at timestamptz NOT NULL DEFAULT clock_timestamp(), removed_at timestamptz,
  CHECK(num_nonnulls(session_id,checkpoint_id,share_id)=1)
);
CREATE UNIQUE INDEX IF NOT EXISTS session_media_document_live_uq ON session_media_documents(session_id) WHERE removed_at IS NULL AND session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS session_media_document_share_idx ON session_media_documents(share_id);
CREATE INDEX IF NOT EXISTS session_media_document_checkpoint_idx ON session_media_documents(checkpoint_id);

-- Touch every affected file's revision. Deletion previews therefore detect new
-- snapshots/references, not merely changes to the filename.
CREATE OR REPLACE FUNCTION session_media_touch_ref() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'DELETE' THEN
    UPDATE session_media SET revision=revision+1,unreferenced_at=NULL WHERE id=NEW.media_id;
  ELSE
    UPDATE session_media SET revision=revision+1,
      unreferenced_at=CASE WHEN NOT EXISTS(SELECT 1 FROM session_media_refs WHERE media_id=OLD.media_id)
        THEN COALESCE(unreferenced_at,now()) ELSE NULL END WHERE id=OLD.media_id;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS session_media_touch ON session_media_refs;
CREATE TRIGGER session_media_touch AFTER INSERT OR UPDATE OR DELETE ON session_media_refs FOR EACH ROW EXECUTE FUNCTION session_media_touch_ref();

-- Snapshot references in the SAME transaction as the existing snapshot. Lock
-- the account before copying so upload/unlink cannot race the snapshot.
CREATE OR REPLACE FUNCTION session_media_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id text; source_id text; cutoff timestamptz;
BEGIN
  IF TG_TABLE_NAME='checkpoints' THEN
    source_id:=NEW.session_id;
    SELECT user_id INTO owner_id FROM play_sessions WHERE id=source_id;
  ELSIF TG_TABLE_NAME='shared_playthroughs' THEN
    source_id:=NEW.source_session_id; owner_id:=NEW.sharer_user_id;
  ELSE
    source_id:=NEW.parent_session_id; owner_id:=NEW.user_id;
    IF source_id IS NULL THEN RETURN NEW; END IF;
    SELECT created_at AT TIME ZONE 'UTC' INTO cutoff FROM messages
      WHERE id=NEW.branched_from_message_id AND session_id=source_id;
    cutoff:=COALESCE(cutoff,clock_timestamp());
  END IF;
  PERFORM id FROM "user" WHERE id=owner_id FOR UPDATE;
  -- A world creator / a cross-account fork is never a grant to private media.
  IF NOT EXISTS(SELECT 1 FROM play_sessions WHERE id=source_id AND user_id=owner_id) THEN RETURN NEW; END IF;
  -- Branches inherit the timeline through their fork point, because cloned
  -- messages retain their original timestamps. Keeping only the current rows
  -- (or resetting added_at) would lose images when branching an inherited turn.
  -- Later source removals must not leak into the child's independent timeline.
  INSERT INTO session_media_refs(id,media_id,session_id,checkpoint_id,share_id,entry_id,metadata,version,added_at,removed_at)
  SELECT gen_random_uuid()::text,r.media_id,
    CASE WHEN TG_TABLE_NAME='play_sessions' THEN NEW.id END,
    CASE WHEN TG_TABLE_NAME='checkpoints' THEN NEW.id END,
    CASE WHEN TG_TABLE_NAME='shared_playthroughs' THEN NEW.id END,
    r.entry_id,r.metadata,r.version,
    CASE WHEN TG_TABLE_NAME='play_sessions' THEN r.added_at ELSE clock_timestamp() END,
    CASE WHEN TG_TABLE_NAME='play_sessions' AND r.removed_at<=cutoff THEN r.removed_at END
  FROM session_media_refs r JOIN session_media m ON m.id=r.media_id
  WHERE r.session_id=source_id AND m.status='ready'
    AND ((TG_TABLE_NAME<>'play_sessions' AND r.removed_at IS NULL)
      OR (TG_TABLE_NAME='play_sessions' AND r.added_at<=cutoff));
  INSERT INTO session_media_documents(id,session_id,checkpoint_id,share_id,value,version,added_at,removed_at)
  SELECT gen_random_uuid()::text,
    CASE WHEN TG_TABLE_NAME='play_sessions' THEN NEW.id END,
    CASE WHEN TG_TABLE_NAME='checkpoints' THEN NEW.id END,
    CASE WHEN TG_TABLE_NAME='shared_playthroughs' THEN NEW.id END,
    d.value,d.version,
    CASE WHEN TG_TABLE_NAME='play_sessions' THEN d.added_at ELSE clock_timestamp() END,
    CASE WHEN TG_TABLE_NAME='play_sessions' AND d.removed_at<=cutoff THEN d.removed_at END
    FROM session_media_documents d WHERE d.session_id=source_id
    AND ((TG_TABLE_NAME<>'play_sessions' AND d.removed_at IS NULL)
      OR (TG_TABLE_NAME='play_sessions' AND d.added_at<=cutoff));
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS session_media_checkpoint_snapshot ON checkpoints;
CREATE TRIGGER session_media_checkpoint_snapshot AFTER INSERT ON checkpoints FOR EACH ROW EXECUTE FUNCTION session_media_snapshot();
DROP TRIGGER IF EXISTS session_media_share_snapshot ON shared_playthroughs;
CREATE TRIGGER session_media_share_snapshot AFTER INSERT ON shared_playthroughs FOR EACH ROW EXECUTE FUNCTION session_media_snapshot();
DROP TRIGGER IF EXISTS session_media_branch_snapshot ON play_sessions;
CREATE TRIGGER session_media_branch_snapshot AFTER INSERT ON play_sessions FOR EACH ROW EXECUTE FUNCTION session_media_snapshot();
