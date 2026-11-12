import { parentPort, workerData } from "node:worker_threads";
import { scanWikiDir, writeIndex } from "./index-builder.js";
import { initIndexDb, withWriteDb, recordSourceIngestResult, deleteSources } from "./index-db.js";
import type { IndexJob } from "./index-worker-client.js";

// No HTTP server or manager metadata in this worker. The existing SQLite WAL
// transaction publishes all index tables together; readers retain a full index.
const job = workerData as IndexJob;
try {
  const pages = scanWikiDir(job.path);
  initIndexDb(job.path);
  withWriteDb(job.path, db => {
    writeIndex(db, pages);
    for (const source of job.processed ?? []) recordSourceIngestResult(db, source);
    if (job.deletedSources?.length) deleteSources(db, job.deletedSources);
  });
  parentPort!.postMessage({ pageCount: pages.length });
} catch (error) {
  parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
