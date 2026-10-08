import assert from "node:assert/strict";
import test from "node:test";
import "../../scripts/test-local-schema.mjs";
import { db } from "./index.js";
import { sql } from "drizzle-orm";
import {
  installVoiceBilling,
  voiceBillingReady,
  requireVoiceBilling,
  voiceBillingDDL,
} from "./voice-billing.js";
import { randomUUID } from "node:crypto";

test("production Drizzle definitions match canonical readiness and installed privacy guards", async () => {
  await installVoiceBilling(db);
  assert.equal(await voiceBillingReady(db), true);
  // Probe-first readiness must not take DDL locks or rewrite a prepared schema.
  const executor = {
    execute: db.execute.bind(db),
    transaction() {
      throw Error("UNEXPECTED_DDL");
    },
  };
  await installVoiceBilling(executor as unknown as typeof db);
  for (const fragment of [
    "voice_call_counters",
    "voice_call_terminal",
    "voice_usage_receipt",
    "voice_usage_identity",
    "voice_balance_attempt",
    "voice_admitted_owner",
    "voice_session_delete",
    "voice_account_delete",
  ])
    assert.ok(voiceBillingDDL().includes(fragment));
});

test("removed guards, weakened partial uniqueness and altered defaults fail readiness before spending queries", async () => {
  await db.execute(
    sql`ALTER TABLE voice_calls ALTER COLUMN state DROP DEFAULT`,
  );
  assert.equal(await voiceBillingReady(db), false);
  await assert.rejects(requireVoiceBilling(db), /VOICE_SCHEMA_NOT_READY/);
  await db.execute(
    sql`ALTER TABLE voice_calls ALTER COLUMN state SET DEFAULT 'reserved'`,
  );
  await db.execute(sql`DROP INDEX voice_admitted_owner`);
  assert.equal(await voiceBillingReady(db), false);
  await db.execute(
    sql`CREATE UNIQUE INDEX voice_admitted_owner ON voice_calls(user_id) WHERE state<>'closed' AND admission_role='primary'`,
  );
  await db.execute(
    sql`ALTER TABLE play_sessions DISABLE TRIGGER voice_session_delete`,
  );
  assert.equal(await voiceBillingReady(db), false);
  await db.execute(
    sql`ALTER TABLE play_sessions ENABLE TRIGGER voice_session_delete`,
  );
  assert.equal(await voiceBillingReady(db), true);
});

test("nullable authority and unsafe public terminal/cost/counter values cannot bypass database checks", async () => {
  const base = sql`INSERT INTO voice_calls(id,transport,origin_session_id,origin_world_id,connection_id,journey_id,journey_epoch,card_attempt_id) VALUES('invalid','balance-realtime-ws','s','w','c','j',0,'a')`;
  await assert.rejects(db.execute(base)); // a fabricated account-deletion tombstone is also rejected by the trigger
  await assert.rejects(
    db.execute(
      sql`INSERT INTO voice_calls(id,transport,origin_session_id,origin_world_id,connection_id,journey_id,journey_epoch,card_attempt_id,account_deleted_at,privacy_tombstoned_at,receipt_availability) VALUES('invalid','balance-realtime-ws','s','w','c','j',0,'a',clock_timestamp(),clock_timestamp(),'redacted')`,
    ),
  );
  assert.equal(
    (await db.execute(sql`SELECT count(*) AS n FROM voice_calls`)).rows[0]!.n,
    0,
  );
  const owner = randomUUID(),
    wallet = randomUUID(),
    world = randomUUID(),
    session = randomUUID();
  await db.execute(
    sql`INSERT INTO "user"(id,name,email) VALUES(${owner},'Schema fixture',${owner + "@test.invalid"})`,
  );
  await db.execute(
    sql`INSERT INTO credit_wallets(id,user_id,balance,period_end) VALUES(${wallet},${owner},100,now()+interval '30 days')`,
  );
  await db.execute(
    sql`INSERT INTO worlds(id,creator_id,name) VALUES(${world},${owner},'Schema fixture')`,
  );
  await db.execute(
    sql`INSERT INTO play_sessions(id,user_id,world_id) VALUES(${session},${owner},${world})`,
  );
  await db.execute(
    sql`INSERT INTO voice_calls(id,user_id,wallet_id,session_id,origin_session_id,origin_world_id,connection_id,journey_id,journey_epoch,card_attempt_id,transport) VALUES('schema-call',${owner},${wallet},${session},${session},${world},'connection','journey',0,'attempt','balance-realtime-ws')`,
  );
  for (const patch of [
    "hold_minor=-1",
    "epoch=9007199254740992",
    "last_final_seq=-1",
    "state='closed'",
    "provider_state='open',accounting_state='complete'",
    "wallet_id=NULL",
    "transport='legacy-pilot-webrtc'",
    "account_deleted_at=clock_timestamp(),privacy_tombstoned_at=clock_timestamp(),receipt_availability='redacted',user_id=NULL,wallet_id=NULL",
  ])
    await assert.rejects(
      db.execute(
        sql.raw(`UPDATE voice_calls SET ${patch} WHERE id='schema-call'`),
      ),
    );
  for (const cost of ["NaN", "Infinity", "-0.1"])
    await assert.rejects(
      db.execute(
        sql`INSERT INTO voice_usage_events(id,call_id,kind,provider_event_id,model,rate_card_version,markup_numerator,markup_denominator,input_tokens,output_tokens,input_text_tokens,input_audio_tokens,cached_text_tokens,cached_audio_tokens,output_text_tokens,output_audio_tokens,payload_fingerprint,provider_cost_usd,usage_reference,debit_reference) VALUES('voice:schema-call:response:r','schema-call','response','r','test','v1',6,5,1,1,1,0,0,0,0,1,${"a".repeat(64)},${cost}::numeric,'voice:schema-call:response:r','voice:schema-call:response:r')`,
      ),
    );
  assert.equal(
    (await db.execute(sql`SELECT count(*) AS n FROM voice_usage_events`))
      .rows[0]!.n,
    0,
  );
});

test("failed canonical preparation rolls back every definition change", async () => {
  await db.execute(sql`DROP INDEX voice_admitted_owner`);
  await db.execute(
    sql`CREATE UNIQUE INDEX voice_admitted_owner ON voice_calls(user_id) WHERE state='active'`,
  );
  await db.execute(
    sql`CREATE OR REPLACE FUNCTION voice_call_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN /* ROLLBACK_PROBE */ RETURN NEW; END $$`,
  );
  try {
    await assert.rejects(installVoiceBilling(db), /VOICE_SCHEMA_NOT_READY/);
    const definition = (
      await db.execute(
        sql`SELECT prosrc FROM pg_proc WHERE proname='voice_call_guard' AND pronamespace=(SELECT oid FROM pg_namespace WHERE nspname=current_schema())`,
      )
    ).rows[0]!.prosrc;
    assert.ok(String(definition).includes("ROLLBACK_PROBE"));
  } finally {
    await db.execute(sql`DROP INDEX voice_admitted_owner`);
    await db.execute(
      sql`CREATE UNIQUE INDEX voice_admitted_owner ON voice_calls(user_id) WHERE state<>'closed' AND admission_role='primary'`,
    );
    await installVoiceBilling(db);
  }
});
