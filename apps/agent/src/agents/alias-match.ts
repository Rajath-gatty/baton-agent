/**
 * Deterministic alias matching — re-exported from `@baton/core`.
 *
 * The implementation moved to `packages/core/src/alias-match.ts` because two
 * callers need it and they must agree exactly. The Cartographer runs it here. The
 * worker runs it on records restored from `curator_cache`, which carry the Curator's
 * classification and records but no attributions — attributions depend on the alias
 * table as it stands at call time, and the cache is keyed on message content alone.
 *
 * Two copies would not fail a build or a test. They would silently stop agreeing,
 * and a mention that should have resolved to a person would quietly resolve to
 * nobody. This file stays so existing importers keep working and so the seam is
 * visible where the Cartographer reads.
 */

export {
  AliasIndex,
  editDistanceWithin,
  needsEscalation,
  normaliseAlias,
  type AliasMatch,
  type MatchMethod,
} from "@baton/core";
