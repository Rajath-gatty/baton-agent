/**
 * The roster: twenty people, fixed.
 *
 * Two things here are load-bearing rather than decorative.
 *
 * **Every alias kind appears.** Handle, display name, nickname, first name and role
 * reference are all represented across the roster, because identity resolution has a
 * coverage row and a path with no material has almost certainly never been tested.
 *
 * **Two people answer to "Priya".** The coordinator and one volunteer share a first
 * name, which is the ambiguity row: the same string resolving to two people is the
 * Cartographer's escalation signal, and without a real collision in the data that
 * branch never runs.
 *
 * The three demo roles are bound here, not afterwards. Meera holds the donation page
 * *and* is the volunteer who leaves on camera — if those were two different people the
 * orphan case would not fire, and it would fail silently with the brief simply
 * appearing empty.
 */

import type { PlanPerson } from "./plan-types.js";

/**
 * Compact roster source. Expanded into {@link PlanPerson} below so the alias forms
 * stay readable next to the name they belong to.
 */
interface RosterEntry {
  id: string;
  displayName: string;
  handle: string;
  nickname?: string;
  roleReference?: string;
  joinedAt?: string;
  leftAt?: string;
  isCoordinator?: boolean;
  demoRole?: PlanPerson["demoRole"];
}

const ROSTER: RosterEntry[] = [
  {
    id: "p01",
    displayName: "Priya Raghavan",
    handle: "@priya_pc",
    nickname: "Pri",
    roleReference: "the coordinator",
    isCoordinator: true,
    demoRole: "coordinator",
  },
  {
    // The orphan case and the approval case both run through her, which is why she is
    // the account that leaves on camera.
    id: "p02",
    displayName: "Meera Sundaram",
    handle: "@meera_s",
    nickname: "Meeru",
    demoRole: "leaver",
  },
  { id: "p03", displayName: "Anil Kumar", handle: "@anilk", nickname: "Anil bhai" },
  {
    // Shares a first name with the coordinator. This is the ambiguity row.
    id: "p04",
    displayName: "Priya Menon",
    handle: "@priyam_vet",
    roleReference: "the vet",
  },
  { id: "p05", displayName: "Suresh Iyer", handle: "@suresh_iyer", nickname: "Suri" },
  { id: "p06", displayName: "Kavya Reddy", handle: "@kavya_r" },
  { id: "p07", displayName: "Farhan Sheikh", handle: "@farhan_sh", nickname: "Fari" },
  { id: "p08", displayName: "Divya Nair", handle: "@divya_n", leftAt: "2026-06-18" },
  { id: "p09", displayName: "Rahul Bose", handle: "@rahulb" },
  { id: "p10", displayName: "Sneha Pillai", handle: "@sneha_p", roleReference: "the foster lead" },
  { id: "p11", displayName: "Vikram Shetty", handle: "@vikram_shetty", nickname: "Vik" },
  { id: "p12", displayName: "Aisha Khan", handle: "@aisha_k" },
  { id: "p13", displayName: "Gopal Krishnan", handle: "@gopalk", nickname: "Gopu" },
  { id: "p14", displayName: "Nandini Rao", handle: "@nandini_rao" },
  { id: "p15", displayName: "Imran Qureshi", handle: "@imranq" },
  { id: "p16", displayName: "Lakshmi Venkat", handle: "@lakshmi_v", nickname: "Lucky" },
  { id: "p17", displayName: "Tarun Joshi", handle: "@tarun_j" },
  { id: "p18", displayName: "Zoya Merchant", handle: "@zoya_m" },
  { id: "p19", displayName: "Harish Gowda", handle: "@harish_g", nickname: "Hari" },
  {
    // The seeded arrival, inside the window and before the live one, so the arrival
    // brief has been exercised before it runs on camera.
    id: "p20",
    displayName: "Ananya Bhat",
    handle: "@ananya_bhat",
    joinedAt: "2026-07-06",
    demoRole: "arriver",
  },
];

function expand(entry: RosterEntry): PlanPerson {
  const firstName = entry.displayName.split(" ")[0] ?? entry.displayName;
  const aliases: PlanPerson["aliases"] = [
    { alias: entry.displayName, kind: "display_name" },
    { alias: entry.handle, kind: "handle" },
    { alias: firstName, kind: "first_name" },
  ];
  if (entry.nickname !== undefined) aliases.push({ alias: entry.nickname, kind: "nickname" });
  if (entry.roleReference !== undefined) {
    aliases.push({ alias: entry.roleReference, kind: "role_reference" });
  }

  return {
    id: entry.id,
    displayName: entry.displayName,
    aliases,
    joinedAt: entry.joinedAt ?? null,
    leftAt: entry.leftAt ?? null,
    isCoordinator: entry.isCoordinator ?? false,
    demoRole: entry.demoRole ?? null,
  };
}

export function buildRoster(): PlanPerson[] {
  return ROSTER.map(expand);
}

/** Everyone in the group on a given date, so filler is never sent by someone absent. */
export function activeOn(people: PlanPerson[], date: string): PlanPerson[] {
  return people.filter(
    (person) =>
      (person.joinedAt === null || person.joinedAt <= date) &&
      (person.leftAt === null || person.leftAt > date),
  );
}
