import { Worker } from "node:worker_threads";
import pLimit from "p-limit";

export interface IndexJob {
  path: string;
  processed?: Array<{ filename: string; sha256: string; size: number; ok: boolean; error?: string | null }>;
  deletedSources?: string[];
}

// One CPU-heavy build at a time across Wikis; no unbounded worker creation.
const buildLimit = pLimit(1);
export function rebuildWikiIndex(job: IndexJob): Promise<{ pageCount: number }> {
  if (buildLimit.pendingCount >= 64) return Promise.reject(new Error("Wiki index queue is full"));
  return buildLimit(() => new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url.endsWith(".ts") ? "../../../dist/index-worker.mjs" : "./index-worker.mjs", import.meta.url), { workerData: job });
    let result: { pageCount: number } | undefined;
    let failure: Error | undefined;
    const timer = setTimeout(() => {
      failure = new Error("Wiki index build timed out");
      void worker.terminate();
    }, 120_000);
    worker.on("message", value => {
      if (value?.error) failure = new Error(value.error);
      else if (Number.isInteger(value?.pageCount) && value.pageCount >= 0) result = value;
      else failure = new Error("Invalid Wiki index worker response");
    });
    worker.on("error", error => { failure = error instanceof Error ? error : new Error(String(error)); });
    worker.on("exit", code => {
      clearTimeout(timer);
      if (failure || code !== 0 || !result) reject(failure ?? new Error(`Wiki index worker exited (${code})`));
      else resolve(result);
    });
  }));
}
