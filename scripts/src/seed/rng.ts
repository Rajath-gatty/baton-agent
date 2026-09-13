/**
 * A tiny deterministic PRNG (mulberry32) and the date helpers the plan needs.
 *
 * Determinism is not a nicety here. The plan output is committed as a fixture so a
 * regenerated transcript exercises the same paths, and `Math.random()` would make
 * every regeneration a different transcript with a different coverage report — which
 * would turn a fail-closed check into a coin flip.
 */

export interface Rng {
  /** Float in [0, 1). */
  next(): number;
  /** Integer in [0, bound). */
  int(bound: number): number;
  /** One element, or throws on an empty list — an empty pool is a bug, not a case. */
  pick<T>(items: readonly T[]): T;
  /** A new array, shuffled. Fisher-Yates. */
  shuffle<T>(items: readonly T[]): T[];
  /** `count` distinct elements, or all of them if the pool is smaller. */
  sample<T>(items: readonly T[], count: number): T[];
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const int = (bound: number): number => Math.floor(next() * bound);

  const pick = <T>(items: readonly T[]): T => {
    const item = items[int(items.length)];
    if (item === undefined) throw new Error("cannot pick from an empty list");
    return item;
  };

  const shuffle = <T>(items: readonly T[]): T[] => {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = int(i + 1);
      const a = out[i] as T;
      const b = out[j] as T;
      out[i] = b;
      out[j] = a;
    }
    return out;
  };

  return { next, int, pick, shuffle, sample: (items, count) => shuffle(items).slice(0, count) };
}

/** `YYYY-MM-DD` arithmetic in UTC, so a local timezone cannot shift a planned date. */
export function addDays(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let offset = 0; offset <= daysBetween(from, to); offset += 1) {
    out.push(addDays(from, offset));
  }
  return out;
}

/** 0 = Sunday. Used to keep weekday chatter lighter than weekend event days. */
export function weekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}
