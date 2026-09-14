/**
 * The admin UI. One page.
 *
 * Everything a signed-in coordinator can see is here, in four stops on one
 * scrolling document: Continuity, Who holds what, Briefs, and Set aside. The
 * board strip navigates within it, not between routes — there are no other
 * routes, apart from the sign-in gate.
 *
 * Why one page rather than five. This product is read, not operated: the
 * coordinator arrives, learns what the organisation is exposed to, and traces a
 * claim or two. Splitting that into routes made the reading a navigation problem
 * and made two guarantees fragile — that provenance is one gesture from any
 * claim, and that what Baton withheld sits on the same sheet as what it
 * surfaced. On one page both are structural: the fact panel is mounted once for
 * the whole document, and the quiet strip is a scroll away from the register
 * rather than a click into a different screen.
 *
 * The ordering claim is unchanged and binding: the state line, the register with
 * seven findings, and the quiet strip must all fall inside a 1440×900 first
 * viewport. The three stops below the fold are exactly the surfaces a
 * coordinator goes looking for, in the order they would.
 *
 * A server component. Every read goes through `lib/data.ts` in one pass, so the
 * fixture → Drizzle swap never touches this file, and the whole page is one
 * round of reads rather than five pages' worth.
 */

import {
  getBriefs,
  getDismissedFindings,
  getHoldingsByKind,
  getOpenQuestions,
  getQuietDecisions,
  getRegister,
  getRuns,
  getSinceYouLastLooked,
  getStateSentence,
  getUnreadBrief,
} from "@/lib/data";
import { ContinuitySection } from "@/components/ContinuitySection";
import { HoldingsSection } from "@/components/HoldingsSection";
import { BriefsSection } from "@/components/BriefsSection";
import { SetAsideSection } from "@/components/SetAsideSection";

export default async function AdminPage() {
  const [
    stateSentence,
    diffs,
    questions,
    unreadBrief,
    register,
    quiet,
    holdings,
    briefs,
    dismissed,
    runs,
  ] = await Promise.all([
    getStateSentence(),
    getSinceYouLastLooked(),
    getOpenQuestions(),
    getUnreadBrief(),
    getRegister(),
    getQuietDecisions(),
    getHoldingsByKind(),
    getBriefs(),
    getDismissedFindings(),
    getRuns(),
  ]);

  return (
    <main className="mx-auto w-full px-6 pt-2 pb-16" style={{ maxWidth: "78rem" }}>
      <ContinuitySection
        stateSentence={stateSentence}
        diffs={diffs}
        questions={questions}
        unreadBrief={unreadBrief}
        register={register}
        quiet={quiet}
      />
      <HoldingsSection groups={holdings} />
      <BriefsSection briefs={briefs} />
      <SetAsideSection dismissed={dismissed} quiet={quiet} runs={runs} />
    </main>
  );
}
