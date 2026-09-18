// UTC enforcement — MUST be imported before anything that touches Date.
//
// Our Postgres timestamps are `timestamp without time zone` and are read back as
// UTC (db/index.ts sets a type parser that appends "Z"). For that convention to
// be correct, every WRITER must also be UTC: node-postgres serializes a JS Date
// into such a column using the process's LOCAL timezone, so a non-UTC process
// stores skewed wall-clock times (e.g. a UTC-7 machine writes 07:13 for a 14:13
// instant). The same risk applies to local-time date math (getMonth/getHours/
// new Date("YYYY-MM-DD…")).
//
// Production sets TZ=UTC in the Dockerfile; this guard covers `pnpm dev` and any
// ad-hoc script that imports the server, especially on non-UTC dev machines.
// Setting process.env.TZ before the first Date use makes V8 resolve all dates in
// UTC for the lifetime of the process.
if (!process.env.TZ) {
  process.env.TZ = "UTC";
}
