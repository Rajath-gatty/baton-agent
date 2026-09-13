/**
 * Who holds what — the standing inventory.
 *
 * This is the "who has what spreadsheet" chore, maintained automatically. It is
 * a plain accounting of the assets the organisation depends on, grouped by all
 * six asset kinds in the fixed `ASSET_KINDS` order, so the register reads as a
 * complete ledger rather than only the kinds that happen to have entries.
 *
 * Density is correct here: a working inventory has many rows, and the tired
 * coordinator reading it at the end of the day is scanning, not studying. Each
 * row is one holding — a claim (traceable via `Claim`), a holder, a coverage
 * count, confidence, the last time the holder was seen exercising it, and a
 * status code. Two shapes are shown distinctly because they are two of the four
 * raw finding subtypes: the holder=null row (no one has been seen holding it,
 * a loose end) and the personal-resource row (relied on but not owned).
 *
 * Nothing here is about a person. A holder name is an attribute of a holding —
 * who has been *seen* exercising a capability — never a subject, never a score.
 *
 * A server component: it reads the seam and renders. The only interactive parts
 * are the `Claim` controls, which are client primitives.
 */

import Link from "next/link";
import type { AssetKind, FactStatus } from "@baton/core";
import { getHoldingsByKind, type HoldingsGroup } from "@/lib/data";
import type { Asset, Holding } from "@/lib/types";
import {
  assetKindLabel,
  formatDate,
  formatRelativeAge,
} from "@/lib/format";
import { Confidence, Eyebrow, Sheet, StatusCode } from "@/components/primitives";

export const metadata = {
  title: "Who holds what — Baton",
};

export default async function HoldingsPage() {
  const groups = await getHoldingsByKind();

  // A holding is "covered" when someone has been seen exercising it. This count
  // is the whole register's answer to "how thin is this?", summarised for the
  // page header without a chart — a plain sentence, because charts are absent
  // by design.
  const allHoldings = groups.flatMap((g) => g.entries.flatMap((e) => e.holdings));
  const totalHoldings = allHoldings.length;
  const unheld = allHoldings.filter((h) => h.holder === null).length;
  const personal = allHoldings.filter((h) => h.isPersonalResource).length;

  return (
    <main className="mx-auto max-w-[68rem] px-6 py-10">
      <header className="mb-8">
        <div className="flex items-baseline justify-between gap-4">
          <div>
            <Eyebrow>Standing inventory</Eyebrow>
            <h1 className="board-type text-head leading-none mt-1">Who holds what</h1>
          </div>
          <Link
            href="/"
            className="text-meta text-ink-muted underline decoration-rule-strong underline-offset-2 hover:decoration-signal"
          >
            Back to continuity
          </Link>
        </div>
        <p className="text-dense text-ink-muted mt-3 max-w-prose">
          {inventorySummary(totalHoldings, unheld, personal)}
        </p>
      </header>

      <div className="grid gap-8">
        {groups.map((group) => (
          <KindSection key={group.kind} group={group} />
        ))}
      </div>
    </main>
  );
}

/** A one-sentence, chart-free reading of the inventory's shape. */
function inventorySummary(total: number, unheld: number, personal: number): string {
  if (total === 0) {
    return "Nothing is on the inventory yet — the register has recorded no assets the organisation depends on.";
  }
  const parts: string[] = [];
  if (unheld > 0) {
    parts.push(
      `${unheld === 1 ? "one asset has" : `${unheld} assets have`} no one seen holding it`,
    );
  }
  if (personal > 0) {
    parts.push(
      `${personal === 1 ? "one is" : `${personal} are`} a volunteer's own resource the group relies on but does not own`,
    );
  }
  const tail = parts.length > 0 ? `, of which ${joinWithAnd(parts)}` : "";
  return `${total} holding${total === 1 ? "" : "s"} across six kinds${tail}.`;
}

function joinWithAnd(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  const head = parts.slice(0, -1).join(", ");
  const last = parts[parts.length - 1];
  return `${head} and ${last}`;
}

// ── one asset kind ───────────────────────────────────────────────────────────

/**
 * One kind's block. Every kind is shown even when empty, because a kind with no
 * assets is itself information — the group depends on nothing of that sort yet,
 * which reads as good news, not an error.
 */
function KindSection({ group }: { group: HoldingsGroup }) {
  const rowCount = group.entries.reduce((n, e) => n + Math.max(e.holdings.length, 1), 0);

  return (
    <section aria-labelledby={`kind-${group.kind}`}>
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <h2 id={`kind-${group.kind}`} className="board-type text-sub leading-none">
          {assetKindLabel(group.kind)}
        </h2>
        <span className="text-label eyebrow" aria-hidden="true">
          {group.entries.length === 0
            ? "none recorded"
            : `${rowCount} ${rowCount === 1 ? "row" : "rows"}`}
        </span>
      </div>

      {group.entries.length === 0 ? (
        <EmptyKind kind={group.kind} />
      ) : (
        <Sheet className="overflow-hidden">
          <HoldingsTable group={group} />
        </Sheet>
      )}
    </section>
  );
}

/** A kind with no assets. Phrased as good news, not a gap. */
function EmptyKind({ kind }: { kind: AssetKind }) {
  return (
    <Sheet className="px-4 py-3">
      <p className="text-meta text-ink-muted">
        Nothing of this kind is on the register — the organisation depends on no{" "}
        {assetKindLabel(kind).toLowerCase()} that Baton has seen.
      </p>
    </Sheet>
  );
}

// ── the ruled table ──────────────────────────────────────────────────────────

/**
 * The dense chart. A real table so screen readers announce it as one: assets
 * are row-group headers, holdings are the rows. An asset with no holding at all
 * still gets a row that says so, so an unowned asset is never silently missing.
 */
const GRID = "grid-cols-[minmax(16rem,1.6fr)_minmax(9rem,1fr)_5.5rem_5rem_7rem_5rem]";

function HoldingsTable({ group }: { group: HoldingsGroup }) {
  return (
    <table className="w-full border-collapse text-left">
      <caption className="sr-only">
        {assetKindLabel(group.kind)} assets and who has been seen holding each.
      </caption>
      <thead>
        <tr className={`grid ${GRID} bg-sheet-alt border-b border-rule`}>
          <Th>Asset & note</Th>
          <Th>Held by</Th>
          <Th align="right">Coverage</Th>
          <Th align="right">Conf.</Th>
          <Th align="right">Last seen</Th>
          <Th align="right">Status</Th>
        </tr>
      </thead>
      <tbody>
        {group.entries.map((entry) => (
          <AssetRows key={entry.asset.id} asset={entry.asset} holdings={entry.holdings} />
        ))}
      </tbody>
    </table>
  );
}

function AssetRows({ asset, holdings }: { asset: Asset; holdings: Holding[] }) {
  if (holdings.length === 0) {
    // An asset the register knows about but has seen no one holding.
    return (
      <tr className={`chart-row grid ${GRID} px-3 py-2`}>
        <AssetCell asset={asset} />
        <UnheldCell />
        <Td align="right">0</Td>
        <Td align="right">
          <span className="text-ink-faint" aria-hidden="true">
            —
          </span>
          <span className="sr-only">no confidence recorded</span>
        </Td>
        <Td align="right">
          <span className="text-ink-faint" aria-hidden="true">
            —
          </span>
        </Td>
        <Td align="right">
          <StatusCode status={holdingStatus(asset, null)} />
        </Td>
      </tr>
    );
  }

  const coverage = holdings.filter((h) => h.holder !== null).length;

  return (
    <>
      {holdings.map((holding, i) => (
        <tr key={holding.id} className={`chart-row grid ${GRID} px-3 py-2`}>
          {/* The asset label repeats only on the first holding of that asset;
              subsequent rows indent under it so multi-holder assets read as a
              group without a visual guessing game. */}
          {i === 0 ? (
            <AssetCell asset={asset} />
          ) : (
            <Td>
              <span className="text-ink-faint pl-3" aria-hidden="true">
                ↳
              </span>{" "}
              <span className="sr-only">{asset.label}, also</span>
              <span className="text-dense text-ink-muted">{holding.note}</span>
            </Td>
          )}

          <HolderCell holding={holding} />

          <Td align="right">
            <span className="tabular-nums">{coverage}</span>
            <span className="sr-only">
              {coverage === 1 ? "one holder seen" : `${coverage} holders seen`}
            </span>
          </Td>

          <Td align="right">
            <Confidence value={coverageConfidence(asset, holding)} />
          </Td>

          <Td align="right">
            {holding.lastSeenAt ? (
              <time
                dateTime={holding.lastSeenAt}
                className="text-meta text-ink-muted"
                title={formatDate(holding.lastSeenAt)}
              >
                {formatRelativeAge(holding.lastSeenAt)}
              </time>
            ) : (
              <span className="text-ink-faint" aria-hidden="true">
                never seen
              </span>
            )}
          </Td>

          <Td align="right">
            <StatusCode status={holdingStatus(asset, holding)} />
          </Td>
        </tr>
      ))}
    </>
  );
}

// ── cells ──────────────────────────────────────────────────────────────────

function AssetCell({ asset }: { asset: Asset }) {
  return (
    <Td>
      <span className="text-dense text-ink">{asset.label}</span>
      {asset.sensitivity === "sensitive" ? (
        <span
          className="ml-2 code code-held align-middle"
          title="Sensitive — approvals for this go to the coordinator privately"
        >
          SENS
        </span>
      ) : null}
      <span className="block text-meta text-ink-muted mt-0.5">{asset.description}</span>
    </Td>
  );
}

/** The holder=null row, shown distinctly: it is a loose end, not a blank. */
function UnheldCell() {
  return (
    <Td>
      <span className="text-dense text-status-held board-type">No one seen</span>
      <span className="sr-only">
        No one has been seen holding this; it rests unowned.
      </span>
    </Td>
  );
}

function HolderCell({ holding }: { holding: Holding }) {
  if (holding.holder === null) {
    return <UnheldCell />;
  }
  return (
    <Td>
      <span className="text-dense text-ink">{holding.holder}</span>
      {holding.isPersonalResource ? (
        <span
          className="block text-label eyebrow text-status-unverified mt-0.5"
          // Marked distinctly: a personal resource is relied on but not owned —
          // a different kind of exposure from a normal holding.
        >
          Personal resource · not the org&apos;s
        </span>
      ) : null}
    </Td>
  );
}

// ── header & body cells ──────────────────────────────────────────────────────

function Th({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      scope="col"
      className={`px-3 py-2 eyebrow ${align === "right" ? "text-right" : "text-left"}`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <td className={`self-baseline ${align === "right" ? "text-right" : "text-left"}`}>
      {children}
    </td>
  );
}

// ── status derivation ────────────────────────────────────────────────────────

/**
 * A holding's status in the product's five-state vocabulary. This is a *view*
 * mapping only — a holding has no persisted `FactStatus`; we read one from its
 * shape so the status column speaks the same language as the rest of the
 * product. Unowned reads as held-for-attention; a personal resource reads as
 * unverified (relied on, not the organisation's); everything else is active.
 */
function holdingStatus(_asset: Asset, holding: Holding | null): FactStatus {
  if (holding === null || holding.holder === null) return "pending_approval";
  if (holding.isPersonalResource) return "unverified";
  return "active";
}

/**
 * A rough confidence for the row's coverage: an unseen or unowned holding reads
 * low, a personal resource mid, a confirmed org holding high. This is a reading
 * aid for the meter, derived from the holding's shape, not a stored score about
 * anyone.
 */
function coverageConfidence(_asset: Asset, holding: Holding): number {
  if (holding.holder === null) return 0.2;
  if (holding.isPersonalResource) return 0.55;
  if (holding.lastSeenAt === null) return 0.4;
  return 0.85;
}
