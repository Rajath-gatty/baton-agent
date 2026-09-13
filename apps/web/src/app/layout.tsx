import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Barlow, Barlow_Condensed } from "next/font/google";
import "./globals.css";

/*
 * Barlow and Barlow Condensed. One family, two widths: the upright carries body,
 * labels and data; the condensed carries the board lettering, status codes and
 * the state line. Barlow's letterforms come from signage grotesques, which is the
 * reason it is here rather than a UI default.
 */
const barlow = Barlow({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-barlow",
  display: "swap",
});

const barlowCondensed = Barlow_Condensed({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-barlow-condensed",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Baton",
  description: "A continuity risk register for volunteer groups.",
  robots: { index: false, follow: false },
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
primary action and selection, and status set in the product's own five-state vocabulary.

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
