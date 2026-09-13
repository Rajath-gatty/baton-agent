import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  /**
   * The **built** schema, not `src`. drizzle-kit bundles the entry it is given and
   * does not remap NodeNext's `.js` specifiers back onto `.ts` files, so
   * `src/db/schema.ts` importing `../constants.js` fails to resolve under it. Every
   * workspace here compiles to `dist`, so pointing at the output costs nothing and
   * removes a whole class of "works under tsx, fails under drizzle-kit" confusion.
   *
   * `db:generate` builds first, so this is never stale.
   */
  schema: "./dist/db/schema.js",
  out: "./drizzle",
  strict: true,
  verbose: true,
  dbCredentials: {
    url: process.env["DATABASE_URL"] ?? "",
  },
});
