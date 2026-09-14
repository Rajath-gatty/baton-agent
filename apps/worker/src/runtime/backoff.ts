/**
 * Backoff for the runtime loops.
 *
 * **This is the mechanism that stops an unattended worker spending real money.** Every
 * tick can invoke a model, and a tick that fails for a persistent reason — a revoked
 * API key, a provider outage, a schema mismatch after a half-finished deploy — will fail
 * again immediately if nothing slows it down. A loop retrying model invocations for a
 * weekend while nobody is watching is the cheapest possible way to run up a bill on this
 * project, and it produces no new information after the first failure.
 *
 * Two separate protections, because they answer different questions:
 *
 *   - **Exponential delay** answers "how long before trying again", and handles the
 *     transient case. A provider hiccup resolves itself and the loop recovers with no
 *     intervention.
 *   - **A cap on consecutive failures** answers "when do we stop trying at all", and
 *     handles the persistent case. Delay alone is not enough: an exponential curve with
 *     a ceiling still retries forever, just more slowly, and a revoked key is not going
 *     to fix itself.
 *
 * When the cap is reached the loop stops and says why. It deliberately does **not**
 * exit the process. Coolify restarts a container that exits, which would reset the
 * counter and defeat the cap entirely — the restart loop the health-check design goes
 * out of its way to avoid. A stopped loop in a live container keeps `/health` green,
 * keeps the data API answering, and leaves the failure legible in the logs.
 *
 * Any success resets both, because the cap is about *consecutive* failures: a loop that
 * works nine times and fails once is healthy, and counting cumulative failures would
 * eventually stop a perfectly good worker.
 */

/** First delay after a failure. Short, because most first failures are transient. */
const DEFAULT_INITIAL_DELAY_MS = 1_000;

/**
 * Ceiling on the delay.
 *
 * Five minutes rather than something larger: past this the cap below is the thing that
 * should be acting, and a loop sleeping for an hour is indistinguishable from a hung one
 * to anybody reading logs.
 */
const DEFAULT_MAX_DELAY_MS = 5 * 60_000;

/**
 * How many consecutive failures before stopping.
 *
 * Eight, which with a doubling curve from one second is roughly nine minutes of
 * retrying. Long enough to ride out a provider restart, short enough that a genuinely
 * broken configuration is not retried all night.
 */
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 8;

export interface BackoffOptions {
  initialDelayMs?: number;
  maxDelayMs?: number;
  maxConsecutiveFailures?: number;
  /**
   * Jitter as a fraction of the delay, applied downward. Two loops that failed on the
   * same provider outage should not come back in lockstep for as long as the outage
   * lasts. Set to 0 in tests so a delay is exactly predictable.
   */
  jitter?: number;
  random?: () => number;
}

export class Backoff {
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxConsecutiveFailures: number;
  private readonly jitter: number;
  private readonly random: () => number;

  private consecutiveFailures = 0;

  constructor(options: BackoffOptions = {}) {
    this.initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.maxConsecutiveFailures =
      options.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
    this.jitter = options.jitter ?? 0.2;
    this.random = options.random ?? Math.random;
  }

  /** Consecutive failures since the last success. */
  get failures(): number {
    return this.consecutiveFailures;
  }

  /**
   * True once the loop should stop trying.
   *
   * Checked by the caller rather than enforced here, so the caller decides what to do
   * about it — log, mark state, keep serving HTTP — instead of this class deciding for
   * every loop that uses it.
   */
  get exhausted(): boolean {
    return this.consecutiveFailures >= this.maxConsecutiveFailures;
  }

  /** How many failures remain before {@link exhausted}. */
  get remaining(): number {
    return Math.max(0, this.maxConsecutiveFailures - this.consecutiveFailures);
  }

  /** A cycle completed. Resets both the delay and the cap. */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  /**
   * A cycle failed. Returns how long to wait before the next attempt.
   *
   * Returned rather than slept, so the caller can honour a shutdown signal instead of
   * being stuck inside a five-minute timer.
   */
  recordFailure(): number {
    this.consecutiveFailures += 1;
    return this.delayMs();
  }

  /** The delay implied by the current failure count. */
  delayMs(): number {
    if (this.consecutiveFailures === 0) return 0;

    // Doubling from the initial delay, clamped. `2 ** 30` and beyond overflows into
    // uselessly large numbers before the clamp would catch it, so the exponent is
    // bounded first.
    const exponent = Math.min(this.consecutiveFailures - 1, 30);
    const raw = Math.min(this.initialDelayMs * 2 ** exponent, this.maxDelayMs);

    if (this.jitter <= 0) return raw;

    // Downward only. Jittering upward could exceed maxDelayMs, and a documented ceiling
    // that is sometimes exceeded is worse than no ceiling.
    return Math.round(raw * (1 - this.jitter * this.random()));
  }
}
