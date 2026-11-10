-- Reviewed B2 catalog preparation ONLY. Never run the broad model seed.
-- Two exact native IDs; their full modality card lives in admission snapshots.
-- model_id is NOT unique. Replace only this bounded billing-only subset.
BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM model_prices WHERE id IN ('native-voice:realtime:normal-v1','native-voice:transcribe:normal-v1')
   AND model_id NOT IN ('gpt-realtime-2.1','gpt-4o-transcribe')) THEN
   RAISE EXCEPTION 'NATIVE_VOICE_CATALOG_ID_COLLISION';
 END IF;
END $$;
DELETE FROM model_prices WHERE model_id IN ('gpt-realtime-2.1','gpt-4o-transcribe');
INSERT INTO model_prices(id,model_id,input_price_per_m,output_price_per_m,min_plan,markup_multiplier,is_active)
 VALUES('native-voice:realtime:normal-v1','gpt-realtime-2.1',4,24,'free',1.20,true),
       ('native-voice:transcribe:normal-v1','gpt-4o-transcribe',2.5,10,'free',1.20,true);
COMMIT;
