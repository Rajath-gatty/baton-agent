/**
 * Continuity — the dashboard and the landing screen.
 *
 * Absent by design, and this is binding: no question box anywhere in this app.
 * The coordinator reads what Baton decided; they do not interrogate it. A text
 * field inviting a question reframes the whole product as retrieval.
 *
 * The screen's order, top to bottom, is fixed: header with last-run status and
 * navigation, the state of the organisation in one sentence, the
 * since-you-last-looked diff, a slim line for questions awaiting an answer, a
 * new-brief banner when one is unread, the ranked register of five to eight
 * finding cards, and the quiet-decisions strip. The state line, register and
 * quiet-decisions strip must fit the first viewport — a judge pausing the video
 * here should understand the product without narration.
 */

export default function ContinuityPage() {
  return (
    <main>
      <h1>Baton</h1>
      <p>A continuity risk register for volunteer groups.</p>
    </main>
  );
}
