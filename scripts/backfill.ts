/**
 * backfill.ts
 *
 * Normalises and pre-filters the seeded transcript, then sends candidates to
 * `ingest` in batches of ten, strictly ordered by `sent_at`. Supersession is
 * order-dependent, so processing a contradiction backwards silently inverts a
 * fact.
 *
 * Cache lookups happen **before** batches are formed, and batches are assembled
 * only from misses. Caching whole batches instead would be nearly worthless,
 * since batch composition changes on every run and one new message would
 * invalidate nine cached classifications.
 *
 * Holds the pipeline advisory lock throughout, so live ingest waits. Then one
 * `assess` pass produces the initial register.
 */

async function main(): Promise<void> {
  console.log("backfill: not implemented");
  return Promise.resolve();
}

await main();
