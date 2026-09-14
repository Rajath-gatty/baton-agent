/**
 * Backoff and the consecutive-failure cap.
 *
 * **What this protects is money, not correctness.** Every tick can invoke a model, so a
 * loop that fails for a persistent reason and retries immediately spends real money all
 * weekend and learns nothing after the first failure. The cap is the half that handles
 * the persistent case: exponential delay alone still retries forever, just more slowly,
 * and a revoked API key is not going to fix itself.
 *
 * Jitter is disabled throughout except in its own case, so a delay is exactly
 * predictable rather than "about right".
 */

import { describe, expect, it } from "vitest";
import { Backoff } from "../src/runtime/backoff.js";

describe("the delay curve", () => {
  it("does not delay before anything has failed", () => {
    expect(new Backoff({ jitter: 0 }).delayMs()).toBe(0);
  });

  it("doubles from the initial delay", () => {
    const backoff = new Backoff({ initialDelayMs: 1000, jitter: 0 });

    expect(backoff.recordFailure()).toBe(1000);
    expect(backoff.recordFailure()).toBe(2000);
    expect(backoff.recordFailure()).toBe(4000);
    expect(backoff.recordFailure()).toBe(8000);
  });

  it("clamps at the ceiling rather than growing without bound", () => {
    const backoff = new Backoff({ initialDelayMs: 1000, maxDelayMs: 5000, jitter: 0 });

    for (let i = 0; i < 20; i += 1) backoff.recordFailure();

    // A loop sleeping for an hour is indistinguishable from a hung one to anyone
    // reading logs, which is why there is a ceiling at all.
    expect(backoff.delayMs()).toBe(5000);
  });

  it("never exceeds the ceiling once jitter is applied", () => {
    // Jitter is downward only. A documented ceiling that is sometimes exceeded is worse
    // than no ceiling, because it is the number someone reasons about.
    const backoff = new Backoff({
      initialDelayMs: 1000,
      maxDelayMs: 4000,
      jitter: 0.5,
      random: () => 1,
      maxConsecutiveFailures: 100,
    });

    for (let i = 0; i < 10; i += 1) {
      const delay = backoff.recordFailure();
      expect(delay).toBeLessThanOrEqual(4000);
      expect(delay).toBeGreaterThan(0);
    }
  });

  it("survives a long failure streak without overflowing into nonsense", () => {
    // 2 ** 1000 is Infinity, and Infinity milliseconds is a loop that never returns.
    const backoff = new Backoff({
      initialDelayMs: 1000,
      maxDelayMs: 60_000,
      jitter: 0,
      maxConsecutiveFailures: 10_000,
    });

    for (let i = 0; i < 2000; i += 1) backoff.recordFailure();

    expect(Number.isFinite(backoff.delayMs())).toBe(true);
    expect(backoff.delayMs()).toBe(60_000);
  });
});

describe("the consecutive-failure cap", () => {
  it("is not exhausted while failures stay under the cap", () => {
    const backoff = new Backoff({ maxConsecutiveFailures: 3, jitter: 0 });

    backoff.recordFailure();
    backoff.recordFailure();

    expect(backoff.exhausted).toBe(false);
    expect(backoff.remaining).toBe(1);
  });

  it("is exhausted at the cap", () => {
    const backoff = new Backoff({ maxConsecutiveFailures: 3, jitter: 0 });

    backoff.recordFailure();
    backoff.recordFailure();
    backoff.recordFailure();

    expect(backoff.exhausted).toBe(true);
    expect(backoff.remaining).toBe(0);
  });

  it("counts consecutive failures, not cumulative ones", () => {
    // A loop that works nine times and fails once is healthy. Counting cumulatively
    // would eventually stop a perfectly good worker after a long uptime — and the
    // symptom would be a worker that silently stopped polling for no visible reason.
    const backoff = new Backoff({ maxConsecutiveFailures: 3, jitter: 0 });

    for (let i = 0; i < 10; i += 1) {
      backoff.recordFailure();
      backoff.recordFailure();
      backoff.recordSuccess();
    }

    expect(backoff.exhausted).toBe(false);
    expect(backoff.failures).toBe(0);
  });

  it("resets the delay on success, not just the count", () => {
    const backoff = new Backoff({ initialDelayMs: 1000, jitter: 0 });

    backoff.recordFailure();
    backoff.recordFailure();
    backoff.recordFailure();
    expect(backoff.delayMs()).toBe(4000);

    backoff.recordSuccess();
    expect(backoff.delayMs()).toBe(0);
    // And the next failure starts over rather than resuming the curve.
    expect(backoff.recordFailure()).toBe(1000);
  });
});
