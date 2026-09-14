/**
 * The authenticated shell.
 *
 * The admin UI is a single page, and this is the frame around it: the board strip
 * at the top, the page itself, and the two panels mounted exactly once. That
 * single mount is a hard product requirement rather than an optimisation — the
 * register's trustworthiness depends on any claim, anywhere in the document,
 * being one gesture from its evidence, and a panel mounted per surface would let
 * one surface quietly lack it.
 *
 * The `(app)` route group carries no URL segment, so the admin UI sits at `/`.
 * Login lives outside this group under the root layout, so the board strip never
 * appears on the sign-in gate — which is also why the gate remains a separate
 * route: a page that renders protected content cannot be the page that decides
 * whether to show it.
 *
 * A server component: it reads the last-run stamp through the seam and passes it
 * to the client header. The panels are client components that mount inert and only
 * open when the header or a `Claim` dispatches their event, so their presence here
 * costs nothing until a coordinator asks for them.
 */

import type { ReactNode } from "react";
import { getLastRun } from "@/lib/data";
import { formatRelativeAge } from "@/lib/format";
import { AppHeader } from "@/components/AppHeader";
import { FactPanel } from "@/components/FactPanel";
import { ActivityPanel } from "@/components/ActivityPanel";

/** "swept 14 minutes ago" — the last-run stamp for the board strip. */
function sweptLabel(finishedAt: string | null | undefined): string {
  if (!finishedAt) return "no sweep recorded yet";
  return `swept ${formatRelativeAge(finishedAt)}`;
}

export default async function AppLayout({ children }: { children: ReactNode }) {
  const lastRun = await getLastRun();

  return (
    <>
      <AppHeader lastRunLabel={sweptLabel(lastRun?.finishedAt)} />
      {children}
      {/* Mounted once for the whole document. Inert until their event fires — the
          header opens the activity panel, any Claim opens the fact panel. */}
      <FactPanel />
      <ActivityPanel />
    </>
  );
}
