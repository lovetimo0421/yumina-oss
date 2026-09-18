import assert from "node:assert/strict";
import { once } from "node:events";
import net from "node:net";
import test from "node:test";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { armQueryDeadlines, findDatabaseQueryTimeout, withDatabaseQueryTimeout } from "./query-deadline.js";

// A local PostgreSQL wire peer exercises the real pg driver, pg-pool and
// Drizzle transaction cleanup. No database credentials or production writes.
function frame(type: string, payload: Buffer) {
  const result = Buffer.alloc(payload.length + 5);
  result.write(type); result.writeInt32BE(payload.length + 4, 1);
  payload.copy(result, 5); return result;
}
const ready = () => frame("Z", Buffer.from("I"));
const complete = (tag: string) => Buffer.concat([frame("C", Buffer.from(tag + "\0")), ready()]);

async function wirePeer() {
  const sockets = new Set<net.Socket>();
  const commands: string[] = [];
  let connections = 0;
  const server = net.createServer((socket) => {
    connections++; sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0), startup = true;
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= (startup ? 4 : 5)) {
        const length = buffer.readInt32BE(startup ? 0 : 1) + (startup ? 0 : 1);
        if (buffer.length < length) return;
        const message = buffer.subarray(0, length); buffer = buffer.subarray(length);
        if (startup) {
          startup = false;
          socket.write(Buffer.concat([frame("R", Buffer.alloc(4)), ready()]));
        } else if (message[0] === 81) {
          const query = message.subarray(5, -1).toString(); commands.push(query);
          if (query.includes("stall")) continue; // TCP lives, database never answers.
          if (query.includes("delayed")) { setTimeout(() => socket.write(complete("SELECT")), 30); continue; }
          if (query.includes("syntax_error")) {
            socket.write(Buffer.concat([frame("E", Buffer.from("SERROR\0C42601\0Msyntax error\0\0")), ready()]));
          } else socket.write(complete(query.split(" ")[0]!.toUpperCase()));
        } else if (message[0] === 88) socket.end();
      }
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const pool = new pg.Pool({ host: "127.0.0.1", port: (server.address() as net.AddressInfo).port,
    user: "test", password: "test", database: "test", ssl: false, max: 1, connectionTimeoutMillis: 1000 });
  pool.on("error", () => {});
  armQueryDeadlines(pool, "test", 60);
  return { pool, commands, connections: () => connections, async close() {
    for (const socket of sockets) socket.destroy();
    await pool.end(); await new Promise<void>((resolve) => server.close(() => resolve()));
  } };
}

test("a hung pooled write is rejected once, the socket is discarded, and a waiter gets a fresh connection", async () => {
  const peer = await wirePeer();
  try {
    let callbacks = 0;
    const failed = new Promise<Error>((resolve) => peer.pool.query("UPDATE stall", (error) => {
      callbacks++; resolve(error!);
    }));
    const waiting = peer.pool.query("SELECT healthy");
    const error = await failed;
    assert.equal((error as { code?: string }).code, "DB_QUERY_TIMEOUT");
    await waiting;
    assert.equal(callbacks, 1);
    assert.equal(peer.connections(), 2);
    assert.equal(peer.commands.filter((q) => q === "UPDATE stall").length, 1, "never replay an uncertain write");
    assert.equal(peer.pool.waitingCount, 0);
  } finally { await peer.close(); }
});

test("Drizzle transaction timeout survives rollback cleanup and does not recycle or commit the failed transaction", async () => {
  const peer = await wirePeer();
  try {
    const db = drizzle(peer.pool);
    await assert.rejects(db.transaction(async (tx) => {
      await tx.execute(sql.raw("UPDATE stall"));
    }), (error: unknown) => (error as { code?: string }).code === "DB_QUERY_TIMEOUT");
    await peer.pool.query("SELECT healthy");
    assert.equal(peer.connections(), 2);
    assert.equal(peer.commands.some((q) => /commit|rollback/i.test(q)), false,
      "a discarded connection cannot run more transaction commands");
  } finally { await peer.close(); }
});

test("HTTP handling can recognize a timeout inside Drizzle's statement error without misclassifying SQL failures", async () => {
  const peer = await wirePeer();
  try {
    const db = drizzle(peer.pool);
    await assert.rejects(db.execute(sql.raw("UPDATE stall")), (error: unknown) => {
      const timeout = findDatabaseQueryTimeout(error);
      assert.equal(timeout?.code, "DB_QUERY_TIMEOUT");
      assert.equal(timeout?.outcome, "unknown");
      return true;
    });
    await assert.rejects(db.execute(sql.raw("SELECT syntax_error")), (error: unknown) => {
      assert.equal(findDatabaseQueryTimeout(error), undefined);
      return true;
    });
  } finally { await peer.close(); }
});

test("a timed-out COMMIT is reported as an unknown outcome and is never replayed", async () => {
  const peer = await wirePeer();
  try {
    const client = await peer.pool.connect();
    try {
      await client.query("BEGIN");
      await assert.rejects(client.query("COMMIT /* stall */"), (error: unknown) =>
        (error as { code?: string; outcome?: string }).code === "DB_QUERY_TIMEOUT"
        && (error as { outcome?: string }).outcome === "unknown");
    } finally { client.release(); }
    await peer.pool.query("SELECT healthy");
    assert.equal(peer.commands.filter((q) => q.startsWith("COMMIT")).length, 1);
  } finally { await peer.close(); }
});

test("queued transaction commands cannot reach the server after a timeout", async () => {
  const peer = await wirePeer();
  try {
    const client = await peer.pool.connect();
    try {
      const results = await Promise.allSettled([client.query("UPDATE stall"), client.query("UPDATE queued")]);
      assert.ok(results.every((result) => result.status === "rejected"));
      assert.equal((client as unknown as { _queryable: boolean })._queryable, false);
      assert.equal(peer.commands.includes("UPDATE queued"), false);
    } finally { client.release(); }
    await peer.pool.query("SELECT healthy");
    assert.equal(peer.connections(), 2);
  } finally { await peer.close(); }
});

test("maintenance deadlines stay within their async scope and do not leak to later requests", async () => {
  const peer = await wirePeer();
  try {
    await withDatabaseQueryTimeout(120, async () => {
      await assert.rejects(peer.pool.query("SELECT stall"), (error: unknown) =>
        (error as { timeoutMs?: number }).timeoutMs === 120);
    });
    await assert.rejects(peer.pool.query("SELECT stall"), (error: unknown) =>
      (error as { timeoutMs?: number }).timeoutMs === 60);
  } finally { await peer.close(); }
});

test("a waiting pool query keeps its own deadline when another async scope releases the connection", async () => {
  const peer = await wirePeer();
  try {
    const maintenance = withDatabaseQueryTimeout(250, () => peer.pool.query("SELECT delayed"));
    const healthProbe = withDatabaseQueryTimeout(80, () => peer.pool.query("SELECT stall"));
    await maintenance;
    await assert.rejects(healthProbe, (error: unknown) => (error as { timeoutMs?: number }).timeoutMs === 80);
  } finally { await peer.close(); }
});

test("ordinary SQL errors still allow rollback and reuse, and healthy results pass through", async () => {
  const peer = await wirePeer();
  try {
    const client = await peer.pool.connect();
    await client.query("BEGIN");
    await assert.rejects(client.query("SELECT syntax_error"), (error: unknown) => (error as { code?: string }).code === "42601");
    const result = await client.query({ text: "ROLLBACK", rowMode: "array" });
    assert.equal(result.command, "ROLLBACK");
    client.release();
    await peer.pool.query("SELECT healthy");
    assert.equal(peer.connections(), 1);
  } finally { await peer.close(); }
});
