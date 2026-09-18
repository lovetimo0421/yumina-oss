import { randomUUID } from "node:crypto";

// No credentials, URLs, account identifiers or request bodies. boot_id also
// distinguishes process restarts within the same Railway replica identity.
const bootId = randomUUID();
export const runtimeIdentity = Object.freeze({
  region: process.env.RAILWAY_REPLICA_REGION ?? process.env.RAILWAY_REGION ?? "unknown",
  replica_id: process.env.RAILWAY_REPLICA_ID ?? bootId,
  deployment_id: process.env.RAILWAY_DEPLOYMENT_ID ?? "local",
  service_id: process.env.RAILWAY_SERVICE_ID ?? "local",
  process_id: process.pid,
  boot_id: bootId,
});
