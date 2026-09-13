/**
 * The authenticated shell.
 *
 * Every surface a signed-in coordinator sees renders inside this layout, so the
 * board strip and the two panels are mounted exactly once and are reachable from
 * every page — the register, the inventory, the briefs, and the set-aside lists.
 * That single mount is a hard product requirement: a per-page panel would let one
 * surface quietly lack its provenance or activity view, and the register's
 * trustworthiness depends on a claim being one gesture from its evidence
 * wherever it appears.
 *
 * The `(app)` route group carries no URL segment, so the paths stay `/`,
 * `/holdings`, `/briefs`, `/dismissed`, `/quiet`. Login lives outside this group
 * under the root layout, so the board strip never appears on the sign-in gate.
 *
 * A server component: it reads the last-run stamp through the seam and passes it
 * to the client header. The panels are client components that mount inert and
 * only open when the header or a `Claim` dispatches their event, so their
 * presence here costs nothing until a coordinator asks for them.
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
      {/* Mounted once, reachable from every surface. Inert until their event
          fires — the header opens the activity panel, any Claim opens the fact
          panel. */}
      <FactPanel />
      <ActivityPanel />
    </>
  );
}
