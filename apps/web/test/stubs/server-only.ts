/**
 * A stand-in for the `server-only` package.
 *
 * The read and write seams import `server-only`, which is what makes a client
 * component importing them fail the build rather than shipping a Postgres client
 * to the browser. That package throws on import outside a React Server Component
 * environment, so a plain Node test runner cannot load the modules it guards.
 *
 * Aliased in `vitest.config.ts` to this empty module. The guard is preserved where
 * it does its work — the webpack build — and neutralised only for the test process,
 * which is a server by construction.
 */
export {};
