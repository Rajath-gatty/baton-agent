import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Barlow, Barlow_Condensed } from "next/font/google";
import "./globals.css";

/*
 * Barlow and Barlow Condensed. One family, two widths: the upright carries body,
 * labels and data; the condensed carries the board lettering, status codes and the
 * state line. Barlow's letterforms come from signage grotesques, which is the
 * reason it is here rather than a UI default — this product's whole visual claim is
 * that it is a working chart, and a chart is set in signage type.
 *
 * Both are loaded through `next/font`, which self-hosts the files and emits them
 * with the CSS variables below, so there is no runtime request to Google and no
 * flash of an unstyled fallback. `display: "swap"` is still correct: text must be
 * readable while a face loads.
 *
 * The weights are exactly the ones used. Barlow 400/500/600 for body, emphasis and
 * the small labels; Condensed 500/600/700 because the board lettering needs a
 * heavier top end and no light one — a 300 in a condensed face at label size
 * disappears against newsprint grey. Adding an unused weight is not free: each is a
 * font file the first paint waits on.
 */
const barlow = Barlow({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-barlow",
  display: "swap",
  preload: true,
  fallback: ["ui-sans-serif", "system-ui", "Segoe UI", "sans-serif"],
});

const barlowCondensed = Barlow_Condensed({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-barlow-condensed",
  display: "swap",
  preload: true,
  fallback: ["ui-sans-serif", "system-ui", "Segoe UI", "sans-serif"],
});

export const metadata: Metadata = {
  title: "Baton",
  description: "A continuity risk register for volunteer groups.",
  robots: { index: false, follow: false },
};

/**
 * Desktop only, by design — there is no mobile layout, and the register is a chart
 * that cannot honestly be narrowed. The viewport is declared rather than left to
 * Next's default so a phone renders the document zoomed out and legible instead of
 * reflowing a chart into a column.
 */
export const viewport: Viewport = {
  width: "1280",
  themeColor: "#1a1f21",
};

/**
 * The direction contract. Emitted as a real HTML comment so it survives the
 * production build and can be audited against the render.
 */
const DIRECTION_CONTRACT = `
THESIS: A register that shows its own restraint. What Baton withheld sits on the same
sheet as what it surfaced, and every claim carries a visible thread back to the message
it came from. Refuses two worlds: the dark alerting console with red severity chips,
which would make continuity read as surveillance — the one reading this product forbids
in substance — and the soft cream-and-serif nonprofit editorial, which under-reads what
is at stake when the only record a group has is its group chat.

OWN-WORLD: A working ledger sheet. Grey-green newsprint ground, hairline rules, dense
ruled rows, condensed lettering carrying structure, one signage blue spent only on
primary action and current position, and status set in the product's own five-state
vocabulary.

SHAPE: One page, four stops — Continuity, Who holds what, Briefs, Set aside — behind a
single shared-passcode gate. Not five routes: the reading is continuous, the fact panel
is mounted once for the whole document, and what was withheld stays a scroll from what
was raised rather than a click into another screen.

STORY: The coordinator learns what the organisation is exposed to, sees that Baton held
some things back, and can trace any claim to the sentence a volunteer actually typed.

FIRST VIEWPORT: Board strip header with the last-run stamp; the state of the
organisation as one large condensed sentence; diff and waiting-on as a single meta row;
five to eight findings as ruled chart rows; the quiet-decisions strip at the sheet's
foot, expanded.

FORM: Product-derived ledger. Steered off a borrowed transit notation on the user's
instruction to stay faithful to what Baton is.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish
review, the verdict, and DESIGN.md
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${barlow.variable} ${barlowCondensed.variable}`}>
      <body>
        <div hidden dangerouslySetInnerHTML={{ __html: `<!--${DIRECTION_CONTRACT}-->` }} />
        {children}
      </body>
    </html>
  );
}
