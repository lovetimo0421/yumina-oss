import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import "../../scripts/test-local-schema.mjs";
import { db } from "./index.js";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { installVoiceBilling, voiceBillingReady } from "./voice-billing.js";

test("actual reviewed B1 DDL upgrades atomically to dedicated immutable pricing and nullable evidence", async () => {
  // This entire process is credential-stripped in-memory PGlite. The pinned
  // fixture is the exact B1 canonical DDL at e07d88c, not a simulated schema.
  await db.execute(
    sql.raw("DROP TABLE voice_usage_events,voice_calls CASCADE"),
  );
  const client = db.$client;
  assert.ok(client instanceof PGlite);
  await client.exec(
    await readFile(
      new URL("./fixtures/voice-billing-b1.sql", import.meta.url),
      "utf8",
    ),
  );
  const owner = randomUUID(),
    wallet = randomUUID(),
    world = randomUUID(),
    session = randomUUID();
  await db.execute(
    sql`INSERT INTO "user"(id,name,email) VALUES(${owner},'B1 retained',${owner + "@test.invalid"})`,
  );
  await db.execute(
    sql`INSERT INTO credit_wallets(id,user_id,balance,period_end) VALUES(${wallet},${owner},100,now()+interval '30 days')`,
  );
  await db.execute(
    sql`INSERT INTO worlds(id,creator_id,name) VALUES(${world},${owner},'B1 retained')`,
  );
  await db.execute(
    sql`INSERT INTO play_sessions(id,user_id,world_id) VALUES(${session},${owner},${world})`,
  );
  await db.execute(
    sql`INSERT INTO voice_calls(id,user_id,wallet_id,session_id,origin_session_id,origin_world_id,connection_id,journey_id,journey_epoch,card_attempt_id,transport,state,provider_id,creation_outcome,provider_state,last_final_seq) VALUES('b1-retained',${owner},${wallet},${session},${session},${world},'c','j',0,'a','balance-realtime-ws','active','p_b1','observed','open',1)`,
  );
  await db.execute(
    sql`INSERT INTO voice_usage_events(id,call_id,kind,provider_event_id,model,rate_card_version,markup_numerator,markup_denominator,input_tokens,output_tokens,input_text_tokens,input_audio_tokens,cached_text_tokens,cached_audio_tokens,output_text_tokens,output_audio_tokens,payload_fingerprint,provider_cost_usd,billing_state,usage_reference,debit_reference,accepted_final,private_fingerprint,final_seq) VALUES('voice:b1-retained:response:old','b1-retained','response','old','gpt-realtime-2.1','b1-version',6,5,1,1,1,0,0,0,1,0,${"a".repeat(64)},'0.000028','unbilled','voice:b1-retained:response:old','voice:b1-retained:response:old','[{"itemId":"old","contentIndex":0,"role":"assistant","text":"Private old final"}]'::jsonb,${"b".repeat(64)},1)`,
  );
  await db.execute(sql`DELETE FROM play_sessions WHERE id=${session}`);
  const before = (
    await db.execute(
      sql`SELECT * FROM voice_usage_events WHERE call_id='b1-retained'`,
    )
  ).rows[0]!;
  assert.equal(
    await voiceBillingReady(db),
    false,
    "B1 alone cannot claim B2 pricing readiness",
  );
  await installVoiceBilling(db);
  assert.equal(await voiceBillingReady(db), true);
  const columns = (
    await db.execute(
      sql`SELECT table_name,column_name,is_nullable FROM information_schema.columns WHERE table_name IN ('voice_calls','voice_usage_events')`,
    )
  ).rows;
  assert.ok(
    columns.some(
      (c) =>
        c.table_name === "voice_calls" && c.column_name === "rate_snapshot",
    ),
  );
  assert.ok(
    columns.some(
      (c) =>
        c.table_name === "voice_usage_events" &&
        c.column_name === "accounting_detail",
    ),
  );
  assert.ok(
    columns.some(
      (c) =>
        c.table_name === "voice_usage_events" &&
        c.column_name === "input_text_tokens" &&
        c.is_nullable === "YES",
    ),
  );
  const after = (
    await db.execute(
      sql`SELECT * FROM voice_usage_events WHERE call_id='b1-retained'`,
    )
  ).rows[0]!;
  assert.equal(after.accounting_detail, null);
  delete after.accounting_detail;
  assert.deepEqual(after, before);
  assert.equal(after.accepted_final, null);
  assert.equal(after.final_seq, 1);
  assert.equal(
    (
      await db.execute(
        sql`SELECT rate_snapshot FROM voice_calls WHERE id='b1-retained'`,
      )
    ).rows[0]!.rate_snapshot,
    null,
  );
  await assert.rejects(
    db.execute(
      sql`UPDATE voice_usage_events SET accounting_detail='{}'::jsonb WHERE call_id='b1-retained'`,
    ),
  );
  await assert.rejects(
    db.execute(
      sql`INSERT INTO voice_usage_events(id,call_id,kind,provider_event_id,model,rate_card_version,markup_numerator,markup_denominator,input_tokens,output_tokens,input_text_tokens,input_audio_tokens,cached_text_tokens,cached_audio_tokens,output_text_tokens,output_audio_tokens,payload_fingerprint,accounting_detail,usage_reference,debit_reference) VALUES('voice:b1-retained:response:invalid-detail','b1-retained','response','invalid-detail','test','v',6,5,0,0,0,0,0,0,0,0,${"a".repeat(64)},'{}'::jsonb,'voice:b1-retained:response:invalid-detail','voice:b1-retained:response:invalid-detail')`,
    ),
  );
  await installVoiceBilling(db);
  assert.equal(await voiceBillingReady(db), true);
});
