-- Additive native voice lifecycle. Keep this file canonical for preparation and local provisioning.
CREATE TABLE IF NOT EXISTS voice_calls (
 id text PRIMARY KEY,
 user_id text REFERENCES "user"(id) ON DELETE SET NULL,
 wallet_id text REFERENCES credit_wallets(id) ON DELETE SET NULL,
 session_id text REFERENCES play_sessions(id) ON DELETE SET NULL,
 origin_session_id text, origin_world_id text, connection_id text,
 journey_id text, journey_epoch bigint, card_attempt_id text,
 transport text NOT NULL, admission_role text NOT NULL DEFAULT 'primary',
 parent_call_id text REFERENCES voice_calls(id) ON DELETE RESTRICT,
 legacy_reservation_id text,
 state text NOT NULL DEFAULT 'reserved', provider_state text NOT NULL DEFAULT 'not-created',
 creation_outcome text NOT NULL DEFAULT 'not-attempted', accounting_state text NOT NULL DEFAULT 'pending',
 provider_id text, provider_config_ref text, provider_observed_at timestamptz, observation_source_id text,
 hard_expires_at timestamptz, close_confirmed_at timestamptz, terminal_reason text,
 owner_instance text, epoch bigint NOT NULL DEFAULT 0,
 hold_minor bigint NOT NULL DEFAULT 0, hold_until timestamptz,
 pcm_samples bigint NOT NULL DEFAULT 0, responses bigint NOT NULL DEFAULT 0, commits bigint NOT NULL DEFAULT 0,
 last_final_seq bigint NOT NULL DEFAULT 0,
 privacy_tombstoned_at timestamptz, account_deleted_at timestamptz, deleted_audit_identity text,
 receipt_availability text NOT NULL DEFAULT 'live',
 legacy_usage_snapshot jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 rate_snapshot jsonb,
 CONSTRAINT voice_call_pricing CHECK (rate_snapshot IS NULL OR (transport='balance-realtime-ws' AND jsonb_typeof(rate_snapshot)='object' AND octet_length(rate_snapshot::text)<=4096)),
 CONSTRAINT voice_call_enums CHECK (transport IN ('balance-realtime-ws','legacy-pilot-webrtc') AND admission_role IN ('primary','legacy-cleanup') AND state IN ('reserved','connecting','active','finishing','cleanup-pending','closed') AND provider_state IN ('not-created','open','unconfirmed','close-confirmed','hard-expired') AND creation_outcome IN ('not-attempted','proven-not-created','observed','unknown') AND accounting_state IN ('pending','complete','incomplete','not-applicable') AND receipt_availability IN ('live','redacted')),
 CONSTRAINT voice_call_counters CHECK (epoch BETWEEN 0 AND 9007199254740991 AND hold_minor BETWEEN 0 AND 9007199254740991 AND pcm_samples BETWEEN 0 AND 9007199254740991 AND responses BETWEEN 0 AND 9007199254740991 AND commits BETWEEN 0 AND 9007199254740991 AND last_final_seq BETWEEN 0 AND 9007199254740991 AND (journey_epoch IS NULL OR journey_epoch BETWEEN 0 AND 9007199254740991)),
 CONSTRAINT voice_call_authority CHECK ((account_deleted_at IS NULL AND user_id IS NOT NULL AND (transport='legacy-pilot-webrtc' OR wallet_id IS NOT NULL)) OR (account_deleted_at IS NOT NULL AND user_id IS NULL AND wallet_id IS NULL AND hold_minor=0 AND receipt_availability='redacted' AND privacy_tombstoned_at IS NOT NULL)),
 CONSTRAINT voice_call_transport CHECK ((transport='balance-realtime-ws' AND origin_session_id IS NOT NULL AND origin_world_id IS NOT NULL AND connection_id IS NOT NULL AND journey_id IS NOT NULL AND journey_epoch IS NOT NULL AND card_attempt_id IS NOT NULL AND legacy_reservation_id IS NULL AND admission_role='primary' AND parent_call_id IS NULL AND accounting_state<>'not-applicable') OR (transport='legacy-pilot-webrtc' AND wallet_id IS NULL AND hold_minor=0 AND legacy_reservation_id IS NOT NULL AND accounting_state='not-applicable' AND last_final_seq=0 AND pcm_samples=0 AND responses=0 AND commits=0)),
 CONSTRAINT voice_call_child CHECK ((admission_role='primary' AND parent_call_id IS NULL) OR (admission_role='legacy-cleanup' AND transport='legacy-pilot-webrtc' AND parent_call_id IS NOT NULL AND provider_id IS NOT NULL AND state IN ('cleanup-pending','closed'))),
 CONSTRAINT voice_call_terminal CHECK (transport='legacy-pilot-webrtc' OR ((accounting_state<>'complete' OR provider_state='close-confirmed' OR (provider_state='not-created' AND creation_outcome='proven-not-created')) AND (state<>'closed' OR (hold_minor=0 AND ((provider_state='close-confirmed' AND accounting_state IN ('complete','incomplete') AND close_confirmed_at IS NOT NULL) OR (provider_state='hard-expired' AND accounting_state='incomplete' AND provider_observed_at IS NOT NULL AND hard_expires_at IS NOT NULL) OR (provider_state='not-created' AND creation_outcome='proven-not-created' AND accounting_state='complete' AND provider_id IS NULL)))))),
 CONSTRAINT voice_call_expiry CHECK ((hard_expires_at IS NULL AND provider_observed_at IS NULL) OR (provider_id IS NOT NULL AND provider_observed_at IS NOT NULL AND hard_expires_at=provider_observed_at+interval '65 minutes')),
 CONSTRAINT voice_call_privacy CHECK ((privacy_tombstoned_at IS NULL AND receipt_availability='live') OR (privacy_tombstoned_at IS NOT NULL AND receipt_availability='redacted')),
 CONSTRAINT voice_call_session CHECK (transport='legacy-pilot-webrtc' OR session_id IS NOT NULL OR privacy_tombstoned_at IS NOT NULL),
 CONSTRAINT voice_call_bounds CHECK (length(id)<=240 AND (provider_id IS NULL OR provider_id ~ '^[A-Za-z0-9_-]{1,200}$') AND (connection_id IS NULL OR length(connection_id) BETWEEN 1 AND 200) AND (journey_id IS NULL OR length(journey_id) BETWEEN 1 AND 200) AND (card_attempt_id IS NULL OR length(card_attempt_id) BETWEEN 1 AND 200) AND (hold_minor=0 OR hold_until IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS voice_admitted_owner ON voice_calls(user_id) WHERE state<>'closed' AND admission_role='primary';
CREATE UNIQUE INDEX IF NOT EXISTS voice_balance_connection ON voice_calls(user_id,origin_session_id,connection_id) WHERE transport='balance-realtime-ws';
CREATE UNIQUE INDEX IF NOT EXISTS voice_balance_attempt ON voice_calls(user_id,origin_session_id,journey_id,journey_epoch,card_attempt_id) WHERE transport='balance-realtime-ws';
CREATE UNIQUE INDEX IF NOT EXISTS voice_legacy_primary ON voice_calls(legacy_reservation_id) WHERE admission_role='primary' AND legacy_reservation_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS voice_legacy_identity ON voice_calls(legacy_reservation_id,provider_id) WHERE legacy_reservation_id IS NOT NULL AND provider_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS voice_provider_identity ON voice_calls(provider_id) WHERE provider_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS voice_wallet_holds ON voice_calls(wallet_id,hold_until) WHERE hold_minor>0;
CREATE INDEX IF NOT EXISTS voice_cleanup ON voice_calls(hard_expires_at,id) WHERE state<>'closed';
CREATE INDEX IF NOT EXISTS voice_session_lookup ON voice_calls(session_id,id);

CREATE TABLE IF NOT EXISTS voice_usage_events (
 id text PRIMARY KEY, call_id text NOT NULL REFERENCES voice_calls(id) ON DELETE RESTRICT,
 kind text NOT NULL, provider_event_id text NOT NULL,
 model text NOT NULL, rate_card_version text NOT NULL, markup_numerator integer NOT NULL, markup_denominator integer NOT NULL,
 input_tokens bigint, output_tokens bigint, input_text_tokens bigint, input_audio_tokens bigint,
 cached_text_tokens bigint, cached_audio_tokens bigint, output_text_tokens bigint, output_audio_tokens bigint,
 payload_fingerprint text NOT NULL,
 provider_cost_usd numeric(24,12), credits_minor bigint, billing_state text NOT NULL DEFAULT 'pending',
 usage_log_id text REFERENCES usage_logs(id) ON DELETE SET NULL,
 credit_transaction_id text REFERENCES credit_transactions(id) ON DELETE SET NULL,
 usage_reference text NOT NULL, debit_reference text NOT NULL,
 accepted_final jsonb, private_fingerprint text, final_seq bigint, receipt_redacted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 accounting_detail jsonb,
 CONSTRAINT voice_usage_enums CHECK (kind IN ('response','transcription') AND billing_state IN ('pending','debited','not-charged','unbilled','invalid')),
 CONSTRAINT voice_usage_identity CHECK (id='voice:'||call_id||':'||kind||':'||provider_event_id AND length(provider_event_id) BETWEEN 1 AND 220 AND payload_fingerprint ~ '^[a-f0-9]{64}$' AND markup_numerator=6 AND markup_denominator=5),
 CONSTRAINT voice_usage_counters CHECK ((input_tokens IS NULL OR input_tokens BETWEEN 0 AND 9007199254740991) AND (output_tokens IS NULL OR output_tokens BETWEEN 0 AND 9007199254740991) AND (input_text_tokens IS NULL OR input_text_tokens BETWEEN 0 AND 9007199254740991) AND (input_audio_tokens IS NULL OR input_audio_tokens BETWEEN 0 AND 9007199254740991) AND (cached_text_tokens IS NULL OR cached_text_tokens BETWEEN 0 AND 9007199254740991) AND (cached_audio_tokens IS NULL OR cached_audio_tokens BETWEEN 0 AND 9007199254740991) AND (output_text_tokens IS NULL OR output_text_tokens BETWEEN 0 AND 9007199254740991) AND (output_audio_tokens IS NULL OR output_audio_tokens BETWEEN 0 AND 9007199254740991) AND ((input_tokens IS NOT NULL AND output_tokens IS NOT NULL AND input_text_tokens IS NOT NULL AND input_audio_tokens IS NOT NULL AND cached_text_tokens IS NOT NULL AND cached_audio_tokens IS NOT NULL AND output_text_tokens IS NOT NULL AND output_audio_tokens IS NOT NULL AND cached_text_tokens<=input_text_tokens AND cached_audio_tokens<=input_audio_tokens AND input_tokens=input_text_tokens+input_audio_tokens AND output_tokens=output_text_tokens+output_audio_tokens) OR (billing_state IN ('pending','invalid','unbilled') AND accounting_detail IS NOT NULL AND accounting_detail->'complete'='false'::jsonb)) AND (credits_minor IS NULL OR credits_minor BETWEEN 0 AND 9007199254740991) AND (final_seq IS NULL OR final_seq BETWEEN 1 AND 9007199254740991)),
 CONSTRAINT voice_usage_evidence CHECK ((accounting_detail IS NULL OR (jsonb_typeof(accounting_detail)='object' AND octet_length(accounting_detail::text)<=8192 AND jsonb_typeof(accounting_detail->'snapshot')='object' AND jsonb_typeof(accounting_detail->'complete')='boolean' AND jsonb_typeof(accounting_detail->'issues')='array' AND jsonb_typeof(accounting_detail->'reported')='object' AND accounting_detail-ARRAY['snapshot','complete','issues','reported']='{}'::jsonb AND accounting_detail ?& ARRAY['snapshot','complete','issues','reported'] AND (accounting_detail->'reported')-ARRAY['totalTokens','cachedTokens']='{}'::jsonb AND (accounting_detail->'reported') ?& ARRAY['totalTokens','cachedTokens']) IS TRUE) AND (billing_state NOT IN ('debited','not-charged') OR accounting_detail IS NULL OR accounting_detail->'complete'='true'::jsonb)),
 CONSTRAINT voice_usage_cost CHECK (provider_cost_usd IS NULL OR (provider_cost_usd>=0 AND provider_cost_usd<'Infinity'::numeric AND provider_cost_usd<>'NaN'::numeric)),
 CONSTRAINT voice_usage_receipt CHECK ((final_seq IS NULL AND accepted_final IS NULL AND private_fingerprint IS NULL) OR (final_seq IS NOT NULL AND ((accepted_final IS NOT NULL AND private_fingerprint IS NOT NULL AND receipt_redacted_at IS NULL AND octet_length(accepted_final::text)<=32768) OR (accepted_final IS NULL AND private_fingerprint IS NULL AND receipt_redacted_at IS NOT NULL)))),
 CONSTRAINT voice_usage_links CHECK ((billing_state<>'debited' OR credits_minor>0) AND (billing_state<>'not-charged' OR credits_minor=0))
);
CREATE UNIQUE INDEX IF NOT EXISTS voice_usage_identity_key ON voice_usage_events(call_id,kind,provider_event_id);
CREATE UNIQUE INDEX IF NOT EXISTS voice_usage_sequence ON voice_usage_events(call_id,final_seq) WHERE final_seq IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS voice_usage_log_link ON voice_usage_events(usage_log_id) WHERE usage_log_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS voice_debit_link ON voice_usage_events(credit_transaction_id) WHERE credit_transaction_id IS NOT NULL;


-- B2 additive upgrade from reviewed B1, preserving rows/identities.
ALTER TABLE voice_calls ADD COLUMN IF NOT EXISTS rate_snapshot jsonb;
ALTER TABLE voice_usage_events ADD COLUMN IF NOT EXISTS accounting_detail jsonb;
ALTER TABLE voice_usage_events ALTER COLUMN input_tokens DROP NOT NULL;
ALTER TABLE voice_usage_events ALTER COLUMN output_tokens DROP NOT NULL;
ALTER TABLE voice_usage_events ALTER COLUMN input_text_tokens DROP NOT NULL;
ALTER TABLE voice_usage_events ALTER COLUMN input_audio_tokens DROP NOT NULL;
ALTER TABLE voice_usage_events ALTER COLUMN cached_text_tokens DROP NOT NULL;
ALTER TABLE voice_usage_events ALTER COLUMN cached_audio_tokens DROP NOT NULL;
ALTER TABLE voice_usage_events ALTER COLUMN output_text_tokens DROP NOT NULL;
ALTER TABLE voice_usage_events ALTER COLUMN output_audio_tokens DROP NOT NULL;
ALTER TABLE voice_calls DROP CONSTRAINT IF EXISTS voice_call_pricing;
ALTER TABLE voice_calls ADD CONSTRAINT voice_call_pricing CHECK (rate_snapshot IS NULL OR (transport='balance-realtime-ws' AND jsonb_typeof(rate_snapshot)='object' AND octet_length(rate_snapshot::text)<=4096));
ALTER TABLE voice_usage_events DROP CONSTRAINT IF EXISTS voice_usage_counters;
ALTER TABLE voice_usage_events ADD CONSTRAINT voice_usage_counters CHECK ((input_tokens IS NULL OR input_tokens BETWEEN 0 AND 9007199254740991) AND (output_tokens IS NULL OR output_tokens BETWEEN 0 AND 9007199254740991) AND (input_text_tokens IS NULL OR input_text_tokens BETWEEN 0 AND 9007199254740991) AND (input_audio_tokens IS NULL OR input_audio_tokens BETWEEN 0 AND 9007199254740991) AND (cached_text_tokens IS NULL OR cached_text_tokens BETWEEN 0 AND 9007199254740991) AND (cached_audio_tokens IS NULL OR cached_audio_tokens BETWEEN 0 AND 9007199254740991) AND (output_text_tokens IS NULL OR output_text_tokens BETWEEN 0 AND 9007199254740991) AND (output_audio_tokens IS NULL OR output_audio_tokens BETWEEN 0 AND 9007199254740991) AND ((input_tokens IS NOT NULL AND output_tokens IS NOT NULL AND input_text_tokens IS NOT NULL AND input_audio_tokens IS NOT NULL AND cached_text_tokens IS NOT NULL AND cached_audio_tokens IS NOT NULL AND output_text_tokens IS NOT NULL AND output_audio_tokens IS NOT NULL AND cached_text_tokens<=input_text_tokens AND cached_audio_tokens<=input_audio_tokens AND input_tokens=input_text_tokens+input_audio_tokens AND output_tokens=output_text_tokens+output_audio_tokens) OR (billing_state IN ('pending','invalid','unbilled') AND accounting_detail IS NOT NULL AND accounting_detail->'complete'='false'::jsonb)) AND (credits_minor IS NULL OR credits_minor BETWEEN 0 AND 9007199254740991) AND (final_seq IS NULL OR final_seq BETWEEN 1 AND 9007199254740991));
ALTER TABLE voice_usage_events DROP CONSTRAINT IF EXISTS voice_usage_evidence;
ALTER TABLE voice_usage_events ADD CONSTRAINT voice_usage_evidence CHECK ((accounting_detail IS NULL OR (jsonb_typeof(accounting_detail)='object' AND octet_length(accounting_detail::text)<=8192 AND jsonb_typeof(accounting_detail->'snapshot')='object' AND jsonb_typeof(accounting_detail->'complete')='boolean' AND jsonb_typeof(accounting_detail->'issues')='array' AND jsonb_typeof(accounting_detail->'reported')='object' AND accounting_detail-ARRAY['snapshot','complete','issues','reported']='{}'::jsonb AND accounting_detail ?& ARRAY['snapshot','complete','issues','reported'] AND (accounting_detail->'reported')-ARRAY['totalTokens','cachedTokens']='{}'::jsonb AND (accounting_detail->'reported') ?& ARRAY['totalTokens','cachedTokens']) IS TRUE) AND (billing_state NOT IN ('debited','not-charged') OR accounting_detail IS NULL OR accounting_detail->'complete'='true'::jsonb));

-- Functions use the trigger's owning schema: isolated tests never consult public tables.
CREATE OR REPLACE FUNCTION voice_call_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p record; wallet_owner text; incomplete_usage boolean;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.rate_snapshot IS DISTINCT FROM OLD.rate_snapshot THEN RAISE EXCEPTION 'VOICE_IMMUTABLE_PRICING'; END IF;
  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN RAISE EXCEPTION 'VOICE_IMMUTABLE_IDENTITY'; END IF;
  IF ROW(NEW.id,NEW.transport,NEW.admission_role,NEW.parent_call_id,NEW.legacy_reservation_id,NEW.origin_session_id,NEW.origin_world_id,NEW.connection_id,NEW.journey_id,NEW.journey_epoch,NEW.card_attempt_id) IS DISTINCT FROM ROW(OLD.id,OLD.transport,OLD.admission_role,OLD.parent_call_id,OLD.legacy_reservation_id,OLD.origin_session_id,OLD.origin_world_id,OLD.connection_id,OLD.journey_id,OLD.journey_epoch,OLD.card_attempt_id) THEN RAISE EXCEPTION 'VOICE_IMMUTABLE_IDENTITY'; END IF;
  IF (OLD.provider_id IS NOT NULL AND NEW.provider_id IS DISTINCT FROM OLD.provider_id) OR (OLD.state='closed' AND NEW.state<>'closed') OR NEW.epoch<OLD.epoch OR NEW.last_final_seq<OLD.last_final_seq OR (OLD.privacy_tombstoned_at IS NOT NULL AND NEW.privacy_tombstoned_at IS DISTINCT FROM OLD.privacy_tombstoned_at) OR (OLD.account_deleted_at IS NOT NULL AND NEW.account_deleted_at IS DISTINCT FROM OLD.account_deleted_at) THEN RAISE EXCEPTION 'VOICE_IMMUTABLE_LIFECYCLE'; END IF;
  IF OLD.account_deleted_at IS NULL AND NEW.account_deleted_at IS NOT NULL AND current_setting('yumina.voice_deleting_account',true) IS DISTINCT FROM OLD.user_id THEN RAISE EXCEPTION 'VOICE_DELETION_REQUIRED'; END IF;
  IF OLD.account_deleted_at IS NULL AND NEW.account_deleted_at IS NULL AND (NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.wallet_id IS DISTINCT FROM OLD.wallet_id) THEN RAISE EXCEPTION 'VOICE_IMMUTABLE_AUTHORITY'; END IF;
  IF NEW.session_id IS DISTINCT FROM OLD.session_id AND (NEW.session_id IS NOT NULL OR NEW.privacy_tombstoned_at IS NULL) THEN RAISE EXCEPTION 'VOICE_IMMUTABLE_SESSION'; END IF;
  IF OLD.accounting_state='incomplete' AND NEW.accounting_state='complete' THEN RAISE EXCEPTION 'VOICE_ACCOUNTING_INCOMPLETE'; END IF;
  IF NEW.privacy_tombstoned_at IS NOT NULL AND NEW.last_final_seq>OLD.last_final_seq THEN RAISE EXCEPTION 'VOICE_TRANSCRIPTS_UNAVAILABLE'; END IF;
 END IF;
 IF TG_OP='INSERT' AND NEW.account_deleted_at IS NOT NULL AND NEW.admission_role<>'legacy-cleanup' THEN RAISE EXCEPTION 'VOICE_DELETION_REQUIRED'; END IF;
 IF NEW.transport='balance-realtime-ws' AND NEW.accounting_state='complete' THEN
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.voice_usage_events WHERE call_id=$1 AND (billing_state NOT IN (''debited'',''not-charged'') OR usage_log_id IS NULL OR (billing_state=''debited'' AND credit_transaction_id IS NULL)))',TG_TABLE_SCHEMA) INTO incomplete_usage USING NEW.id;
  IF incomplete_usage THEN RAISE EXCEPTION 'VOICE_ACCOUNTING_INCOMPLETE'; END IF;
 END IF;
 IF NEW.wallet_id IS NOT NULL THEN EXECUTE format('SELECT user_id FROM %I.credit_wallets WHERE id=$1',TG_TABLE_SCHEMA) INTO wallet_owner USING NEW.wallet_id; IF wallet_owner IS DISTINCT FROM NEW.user_id THEN RAISE EXCEPTION 'VOICE_WALLET_OWNER'; END IF; END IF;
 IF NEW.admission_role='legacy-cleanup' THEN
  EXECUTE format('SELECT * FROM %I.voice_calls WHERE id=$1',TG_TABLE_SCHEMA) INTO p USING NEW.parent_call_id;
  IF p.id IS NULL OR p.admission_role<>'primary' OR p.transport<>'legacy-pilot-webrtc' OR p.legacy_reservation_id IS DISTINCT FROM NEW.legacy_reservation_id OR p.origin_world_id IS DISTINCT FROM NEW.origin_world_id OR p.origin_session_id IS DISTINCT FROM NEW.origin_session_id OR p.user_id IS DISTINCT FROM NEW.user_id OR p.account_deleted_at IS DISTINCT FROM NEW.account_deleted_at THEN RAISE EXCEPTION 'VOICE_INVALID_CLEANUP_PARENT'; END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS voice_call_guard ON voice_calls;
CREATE TRIGGER voice_call_guard BEFORE INSERT OR UPDATE ON voice_calls FOR EACH ROW EXECUTE FUNCTION voice_call_guard();

CREATE OR REPLACE FUNCTION voice_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c record;
BEGIN
 EXECUTE format('SELECT * FROM %I.voice_calls WHERE id=$1 FOR UPDATE',TG_TABLE_SCHEMA) INTO c USING NEW.call_id;
 IF c.transport IS DISTINCT FROM 'balance-realtime-ws' THEN RAISE EXCEPTION 'VOICE_LEGACY_JOURNAL_FORBIDDEN'; END IF;
 IF c.rate_snapshot IS NOT NULL AND (NEW.accounting_detail IS NULL OR NEW.accounting_detail->'snapshot' IS DISTINCT FROM c.rate_snapshot) THEN RAISE EXCEPTION 'VOICE_IMMUTABLE_PRICING'; END IF;
 IF NEW.accepted_final IS NOT NULL AND (NEW.billing_state IN ('unbilled','invalid') OR NEW.accounting_detail->'complete'='false'::jsonb) THEN RAISE EXCEPTION 'VOICE_ACCOUNTING_INCOMPLETE'; END IF;
 IF NEW.accepted_final IS NOT NULL AND (c.user_id IS NULL OR c.session_id IS NULL OR c.privacy_tombstoned_at IS NOT NULL OR c.account_deleted_at IS NOT NULL) THEN RAISE EXCEPTION 'VOICE_TRANSCRIPTS_UNAVAILABLE'; END IF;
 IF c.privacy_tombstoned_at IS NOT NULL AND NEW.final_seq IS NOT NULL AND (TG_OP='INSERT' OR OLD.final_seq IS NULL) THEN RAISE EXCEPTION 'VOICE_TRANSCRIPTS_UNAVAILABLE'; END IF;
 IF c.state='closed' AND NEW.final_seq IS NOT NULL AND (TG_OP='INSERT' OR OLD.final_seq IS NULL) THEN RAISE EXCEPTION 'VOICE_CALL_CLOSED'; END IF;
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.id,NEW.call_id,NEW.kind,NEW.provider_event_id,NEW.model,NEW.rate_card_version,NEW.markup_numerator,NEW.markup_denominator,NEW.input_tokens,NEW.output_tokens,NEW.input_text_tokens,NEW.input_audio_tokens,NEW.cached_text_tokens,NEW.cached_audio_tokens,NEW.output_text_tokens,NEW.output_audio_tokens,NEW.payload_fingerprint,NEW.accounting_detail,NEW.usage_reference,NEW.debit_reference) IS DISTINCT FROM ROW(OLD.id,OLD.call_id,OLD.kind,OLD.provider_event_id,OLD.model,OLD.rate_card_version,OLD.markup_numerator,OLD.markup_denominator,OLD.input_tokens,OLD.output_tokens,OLD.input_text_tokens,OLD.input_audio_tokens,OLD.cached_text_tokens,OLD.cached_audio_tokens,OLD.output_text_tokens,OLD.output_audio_tokens,OLD.payload_fingerprint,OLD.accounting_detail,OLD.usage_reference,OLD.debit_reference) THEN RAISE EXCEPTION 'VOICE_USAGE_CONFLICT'; END IF;
  IF OLD.accepted_final IS NOT NULL AND NEW.accepted_final IS NOT NULL AND ROW(NEW.accepted_final,NEW.private_fingerprint) IS DISTINCT FROM ROW(OLD.accepted_final,OLD.private_fingerprint) THEN RAISE EXCEPTION 'VOICE_FINAL_CONFLICT'; END IF;
  IF (OLD.usage_log_id IS NOT NULL AND NEW.usage_log_id IS NOT NULL AND NEW.usage_log_id IS DISTINCT FROM OLD.usage_log_id) OR (OLD.credit_transaction_id IS NOT NULL AND NEW.credit_transaction_id IS NOT NULL AND NEW.credit_transaction_id IS DISTINCT FROM OLD.credit_transaction_id) OR (OLD.billing_state<>'pending' AND ((OLD.usage_log_id IS NULL AND NEW.usage_log_id IS NOT NULL) OR (OLD.credit_transaction_id IS NULL AND NEW.credit_transaction_id IS NOT NULL))) THEN RAISE EXCEPTION 'VOICE_USAGE_CONFLICT'; END IF;
  IF (OLD.final_seq IS NOT NULL AND NEW.final_seq IS DISTINCT FROM OLD.final_seq) OR (OLD.receipt_redacted_at IS NOT NULL AND NEW.accepted_final IS NOT NULL) OR (OLD.billing_state<>'pending' AND NOT (c.account_deleted_at IS NOT NULL AND OLD.billing_state='unbilled' AND OLD.provider_cost_usd IS NULL AND OLD.credits_minor IS NULL AND NEW.billing_state='unbilled') AND ROW(NEW.billing_state,NEW.credits_minor,NEW.provider_cost_usd) IS DISTINCT FROM ROW(OLD.billing_state,OLD.credits_minor,OLD.provider_cost_usd)) THEN RAISE EXCEPTION 'VOICE_USAGE_CONFLICT'; END IF;
 END IF;
 -- Retain late measured evidence without reopening physical transport or
 -- continuing to advertise a completed accounting prerequisite.
 IF c.state='closed' AND c.accounting_state='complete' AND (NEW.billing_state NOT IN ('debited','not-charged') OR NEW.usage_log_id IS NULL OR (NEW.billing_state='debited' AND NEW.credit_transaction_id IS NULL)) THEN
  EXECUTE format('UPDATE %I.voice_calls SET accounting_state=''incomplete'',updated_at=clock_timestamp() WHERE id=$1',TG_TABLE_SCHEMA) USING NEW.call_id;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS voice_event_guard ON voice_usage_events;
CREATE TRIGGER voice_event_guard BEFORE INSERT OR UPDATE ON voice_usage_events FOR EACH ROW EXECUTE FUNCTION voice_event_guard();

CREATE OR REPLACE FUNCTION voice_session_delete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c record; stamp timestamptz:=clock_timestamp();
BEGIN
 FOR c IN EXECUTE format('SELECT id FROM %I.voice_calls WHERE session_id=$1 ORDER BY id FOR UPDATE',TG_TABLE_SCHEMA) USING OLD.id LOOP
  EXECUTE format('UPDATE %I.voice_calls SET privacy_tombstoned_at=coalesce(privacy_tombstoned_at,$2),receipt_availability=''redacted'',state=CASE WHEN state=''closed'' THEN state ELSE ''cleanup-pending'' END,updated_at=$2 WHERE id=$1',TG_TABLE_SCHEMA) USING c.id,stamp;
  EXECUTE format('UPDATE %I.voice_usage_events SET accepted_final=NULL,private_fingerprint=NULL,receipt_redacted_at=CASE WHEN final_seq IS NOT NULL THEN coalesce(receipt_redacted_at,$2) ELSE receipt_redacted_at END,updated_at=$2 WHERE call_id=$1',TG_TABLE_SCHEMA) USING c.id,stamp;
 END LOOP;
 RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS voice_session_delete ON play_sessions;
CREATE TRIGGER voice_session_delete BEFORE DELETE ON play_sessions FOR EACH ROW EXECUTE FUNCTION voice_session_delete();

-- Account legacy reconciliation is installed below with the exact A1 proof predicate.
CREATE OR REPLACE FUNCTION voice_legacy_proof(p_schema text,p_root text,p_user text,p_world text,p_call text)
RETURNS TABLE(observed_at timestamptz,source_id text,usage_snapshot jsonb) LANGUAGE plpgsql AS $$
BEGIN
 RETURN QUERY EXECUTE format($query$
-- A1 proof begin
SELECT min(created_at) AT TIME ZONE 'UTC' AS observed_at, (array_agg(id ORDER BY created_at,id))[1] AS source_id,
 jsonb_build_object('input',sum(prompt_tokens),'output',sum(completion_tokens),'total',sum(total_tokens),'costUsd',CASE WHEN count(provider_cost_usd)=count(*) THEN sum(provider_cost_usd)::text ELSE NULL END) AS usage_snapshot
FROM %I.usage_logs
WHERE user_id=$2 AND analytics_world_id IS NOT DISTINCT FROM $3 AND $3 IS NOT NULL AND token_measurement='provider'
 AND created_at>=(SELECT created_at FROM %I.usage_logs WHERE id=$1) AND created_at<=(clock_timestamp() AT TIME ZONE 'UTC')
 AND prompt_tokens>=0 AND completion_tokens>=0 AND total_tokens=prompt_tokens+completion_tokens
 AND ((endpoint='voice-pilot' AND model='gpt-realtime-2.1' AND left(id,length('voice-pilot:'||$4||':response:'))='voice-pilot:'||$4||':response:' AND substring(id FROM length('voice-pilot:'||$4||':response:')+1) ~ '^[A-Za-z0-9_-]{1,200}$')
  OR (endpoint='voice-pilot-transcription' AND model='gpt-4o-transcribe' AND left(id,length('voice-pilot:'||$4||':transcription:'))='voice-pilot:'||$4||':transcription:' AND substring(id FROM length('voice-pilot:'||$4||':transcription:')+1) ~ '^[A-Za-z0-9_-]{1,200}:[0-9]{1,8}$'))
-- A1 proof end
$query$,p_schema,p_schema) USING p_root,p_user,p_world,p_call;
END $$;

CREATE OR REPLACE FUNCTION voice_reconcile_legacy(p_schema text,p_owner text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE root record; parent record; obligation record; proof record; primary_id text; child_id text; terminal boolean; expired boolean;
BEGIN
 -- Caller has the owner gate and, if spending, its wallet before these calls.
 FOR root IN EXECUTE format('SELECT * FROM %I.voice_calls WHERE user_id=$1 ORDER BY id FOR UPDATE',p_schema) USING p_owner LOOP END LOOP;
 FOR root IN EXECUTE format('SELECT * FROM %I.usage_logs WHERE user_id=$1 AND endpoint=''voice-pilot-reservation'' ORDER BY id',p_schema) USING p_owner LOOP
  primary_id:='legacy:'||root.id;
  EXECUTE format('INSERT INTO %I.voice_calls(id,user_id,origin_session_id,origin_world_id,transport,legacy_reservation_id,state,creation_outcome,accounting_state) VALUES($1,$2,$3,$4,''legacy-pilot-webrtc'',$5,''closed'',$6,''not-applicable'') ON CONFLICT (legacy_reservation_id) WHERE admission_role=''primary'' AND legacy_reservation_id IS NOT NULL DO NOTHING',p_schema)
   USING primary_id,p_owner,root.session_id,root.analytics_world_id,root.id,CASE WHEN root.provider_request_id IS NULL THEN 'unknown' ELSE 'observed' END;
  EXECUTE format('SELECT id FROM %I.voice_calls WHERE legacy_reservation_id=$1 AND admission_role=''primary''',p_schema) INTO primary_id USING root.id;
  EXECUTE format('SELECT * FROM %I.voice_calls WHERE id=$1',p_schema) INTO parent USING primary_id;
  FOR obligation IN EXECUTE format('SELECT provider_request_id,bool_and(generation_time_ms IS NOT NULL) AS terminal FROM %I.usage_logs WHERE user_id=$1 AND analytics_world_id IS NOT DISTINCT FROM $2 AND (id=$3 OR (endpoint=''voice-pilot-cleanup-ownership'' AND model=''voice-pilot-cleanup:''||$3 AND token_measurement=''not-applicable'')) AND provider_request_id IS NOT NULL GROUP BY provider_request_id ORDER BY provider_request_id',p_schema) USING p_owner,root.analytics_world_id,root.id LOOP
   IF obligation.provider_request_id !~ '^[A-Za-z0-9_-]{1,200}$' THEN RAISE EXCEPTION 'VOICE_INVALID_LEGACY_ID'; END IF;
   EXECUTE format('SELECT * FROM %I.voice_legacy_proof($1,$2,$3,$4,$5)',p_schema) INTO proof USING p_schema,root.id,p_owner,root.analytics_world_id,obligation.provider_request_id;
   EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.usage_logs WHERE id=$1 AND user_id=$2 AND analytics_world_id IS NOT DISTINCT FROM $3 AND provider_request_id=$4 AND endpoint=''voice-pilot-hard-expiry-accounting-incomplete'' AND model=''voice-pilot-hard-expiry-accounting-incomplete'' AND token_measurement=''not-applicable'' AND prompt_tokens=0 AND completion_tokens=0 AND total_tokens=0 AND provider_cost_usd IS NULL)',p_schema) INTO expired USING 'voice-pilot-hard-expiry:'||root.id||':'||obligation.provider_request_id,p_owner,root.analytics_world_id,obligation.provider_request_id;
   child_id:='legacy-cleanup:'||md5(root.id||chr(31)||obligation.provider_request_id);
   EXECUTE format('INSERT INTO %I.voice_calls(id,user_id,origin_session_id,origin_world_id,transport,admission_role,parent_call_id,legacy_reservation_id,provider_id,state,provider_state,creation_outcome,accounting_state,provider_observed_at,observation_source_id,hard_expires_at,legacy_usage_snapshot) VALUES($1,$2,$3,$4,''legacy-pilot-webrtc'',''legacy-cleanup'',$5,$6,$7,$8,$9,''observed'',''not-applicable'',$10,$11,$10+interval ''65 minutes'',$12) ON CONFLICT (legacy_reservation_id,provider_id) WHERE legacy_reservation_id IS NOT NULL AND provider_id IS NOT NULL DO UPDATE SET provider_observed_at=CASE WHEN voice_calls.provider_observed_at IS NULL THEN excluded.provider_observed_at ELSE least(voice_calls.provider_observed_at,excluded.provider_observed_at) END,hard_expires_at=CASE WHEN voice_calls.provider_observed_at IS NULL THEN excluded.hard_expires_at ELSE least(voice_calls.provider_observed_at,excluded.provider_observed_at)+interval ''65 minutes'' END,observation_source_id=CASE WHEN voice_calls.provider_observed_at IS NULL OR excluded.provider_observed_at<voice_calls.provider_observed_at THEN excluded.observation_source_id ELSE voice_calls.observation_source_id END,legacy_usage_snapshot=excluded.legacy_usage_snapshot',p_schema)
    USING child_id,p_owner,parent.origin_session_id,parent.origin_world_id,primary_id,root.id,obligation.provider_request_id,CASE WHEN obligation.terminal THEN 'closed' ELSE 'cleanup-pending' END,CASE WHEN obligation.terminal THEN CASE WHEN expired THEN 'hard-expired' ELSE 'close-confirmed' END ELSE 'unconfirmed' END,proof.observed_at,proof.source_id,proof.usage_snapshot;
  END LOOP;
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION voice_account_delete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c record; stamp timestamptz:=clock_timestamp(); previous_setting text:=current_setting('yumina.voice_deleting_account',true);
BEGIN
 EXECUTE format('SELECT %I.voice_reconcile_legacy($1,$2)',TG_TABLE_SCHEMA) USING TG_TABLE_SCHEMA,OLD.id;
 PERFORM set_config('yumina.voice_deleting_account',OLD.id,true);
 FOR c IN EXECUTE format('SELECT id FROM %I.voice_calls WHERE user_id=$1 ORDER BY id FOR UPDATE',TG_TABLE_SCHEMA) USING OLD.id LOOP END LOOP;
 FOR c IN EXECUTE format('SELECT id FROM %I.voice_calls WHERE user_id=$1 ORDER BY (admission_role=''primary'') DESC,id',TG_TABLE_SCHEMA) USING OLD.id LOOP
  EXECUTE format('UPDATE %I.voice_calls SET account_deleted_at=$2,privacy_tombstoned_at=coalesce(privacy_tombstoned_at,$2),receipt_availability=''redacted'',hold_minor=0,user_id=NULL,wallet_id=NULL,deleted_audit_identity=coalesce(deleted_audit_identity,CASE WHEN current_setting(''yumina.voice_deletion_identity_user'',true)=$3 THEN nullif(current_setting(''yumina.voice_deletion_audit_identity'',true),'''') ELSE NULL END),state=CASE WHEN state=''closed'' THEN state ELSE ''cleanup-pending'' END,updated_at=$2 WHERE id=$1',TG_TABLE_SCHEMA) USING c.id,stamp,OLD.id;
  EXECUTE format('UPDATE %I.voice_usage_events SET accepted_final=NULL,private_fingerprint=NULL,receipt_redacted_at=CASE WHEN final_seq IS NOT NULL THEN coalesce(receipt_redacted_at,$2) ELSE receipt_redacted_at END,updated_at=$2 WHERE call_id=$1',TG_TABLE_SCHEMA) USING c.id,stamp;
 END LOOP;
 PERFORM set_config('yumina.voice_deleting_account',coalesce(previous_setting,''),true);
 RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS voice_account_delete ON "user";
CREATE TRIGGER voice_account_delete BEFORE DELETE ON "user" FOR EACH ROW EXECUTE FUNCTION voice_account_delete();
