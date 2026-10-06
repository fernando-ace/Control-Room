import { describe, expect, it } from "vitest";
import { advance, apply, ensureMissionVariant, join, missionPatterns, newMission, snapshot } from "../lib/engine";
import type { Room } from "../lib/types";
const base = 1000000;
function seedForPattern(index: number) {
  for (let n = 0; n < 1000; n++) {
    const seed = n.toString(16).padStart(32, "0");
    if (missionPatterns.findIndex((p) => p.name === newMission(base, seed).variant.name) === index) return seed;
  }
  throw new Error("No seed found for mission pattern");
}
const canonicalSeed = seedForPattern(0);
function room(): Room {
  const mission = newMission(base, canonicalSeed);
  return {
    id: "room",
    code: "ABCDEF",
    hostId: "c",
    revision: 0,
    createdAt: base,
    players: [
      { id: "c", name: "C", role: "Commander", ready: true, seenAt: base },
      { id: "p", name: "P", role: "Pilot", ready: true, seenAt: base },
      { id: "e", name: "E", role: "Engineer", ready: true, seenAt: base },
    ],
    mission,
    lastMissionSeed: mission.seed,
    lastVariantName: mission.variant.name,
    processed: [],
  };
}
function roomWithMission(mission: ReturnType<typeof newMission>): Room {
  return { ...room(), mission, lastMissionSeed: mission.seed };
}
let seq = 0;
function command(
  r: Room,
  id: string,
  type: string,
  value: string | number | boolean | undefined,
  t: number,
) {
  apply(r, id, { type, value }, base + t * 1000, `action-${++seq}`);
}
function wave(r: Room, second = false) {
  const m = r.mission!;
  const event = second ? "storm-2" : "storm-1";
  const stage = m.variant.order.indexOf(event) + 1;
  const t = m.variant.stageStarts[stage - 1];
  const index = second ? 1 : 0;
  command(r, "e", "power", "Shield", t);
  command(r, "c", "shield", m.secrets.sectors[index], t);
  command(r, "p", "heading", m.secrets.headings[index], t);
  advance(m, base + (t + 12) * 1000);
}
describe("Solar Storm timestamp simulation", () => {
  it("generates the same authored sequence from an identical seed", () => {
    const first = newMission(base, canonicalSeed);
    expect(newMission(base, canonicalSeed)).toEqual(first);
    expect(first.seed).toBe(canonicalSeed);
  });
  it("makes six deterministic sequences with bounded opening, stages, and escape", () => {
    const variants = missionPatterns.map((_, index) => newMission(base, seedForPattern(index)));
    expect(new Set(variants.map((mission) => mission.variant.name)).size).toBe(6);
    expect(new Set(variants.map((mission) => mission.variant.order.join(","))).size).toBe(6);
    for (const mission of variants) {
      const [opening, second, third, escape] = mission.variant.stageStarts;
      expect(opening).toBeGreaterThanOrEqual(10);
      expect(opening).toBeLessThanOrEqual(15);
      expect(second - opening).toBeGreaterThanOrEqual(30);
      expect(third - second).toBeGreaterThanOrEqual(30);
      expect(escape - third).toBeGreaterThanOrEqual(25);
      expect(escape).toBeLessThanOrEqual(140);
      expect(mission.deadlines.at(-1)).toBe(base + 150000);
      expect(mission.variant.order.filter((event) => event.startsWith("storm"))).toHaveLength(2);
      expect(mission.variant.order).toContain("coolant");
      expect(mission.variant.coolantAt).toBe(mission.variant.stageStarts[mission.variant.order.indexOf("coolant")]);
    }
    for (const [index, mission] of variants.entries()) {
      const r = roomWithMission(mission);
      const stations = [snapshot(r, "c", base), snapshot(r, "p", base), snapshot(r, "e", base)];
      expect(stations.find((station) => station.station.brokenSymbol)?.players.find((p) => p.id === stations.find((s) => s.station.brokenSymbol)?.me)?.role).toBe(missionPatterns[index].intelRole);
      expect(stations.filter((station) => station.station.brokenSymbol)).toHaveLength(1);
      expect(stations[0].station.code).toBeDefined();
      expect(stations[1].station.heading).toBeDefined();
      expect(stations[2].station.power).toBeDefined();
    }
  });
  it("reconstructs legacy in-progress Solar Storm rooms without changing their timings", () => {
    const r = room();
    const mission = r.mission! as { variant?: unknown; seed?: string };
    delete mission.variant;
    delete mission.seed;
    delete r.lastMissionSeed;
    ensureMissionVariant(r);
    const first = structuredClone(r.mission);
    ensureMissionVariant(r);
    expect(r.mission).toEqual(first);
    expect(r.mission!.variant).toMatchObject({
      name: "Solar Storm",
      order: ["storm-1", "coolant", "storm-2"],
      stageStarts: [12, 50, 90, 130],
      coolantAt: 80,
    });
    expect(r.mission!.seed).toMatch(/^[a-f\d]{32}$/i);
  });
  it("allows a coordinated three-role solution for every generated sequence", () => {
    for (let index = 0; index < missionPatterns.length; index++) {
      const r = roomWithMission(newMission(base, seedForPattern(index)));
      for (let stage = 1; stage <= 3; stage++) {
        const event = r.mission!.variant.order[stage - 1];
        const t = r.mission!.variant.stageStarts[stage - 1];
        if (event === "coolant") {
          const circuit = r.mission!.secrets.broken;
          command(r, "e", "isolate", circuit, t);
          command(r, "e", "vent", undefined, t);
          command(r, "e", "reset", undefined, t);
        } else {
          const wave = event === "storm-1" ? 0 : 1;
          command(r, "c", "shield", r.mission!.secrets.sectors[wave], t);
          command(r, "e", "power", "Shield", t);
          command(r, "p", "heading", r.mission!.secrets.headings[wave], t);
          advance(r.mission!, base + (t + 12) * 1000);
        }
      }
      const escape = r.mission!.variant.stageStarts[3];
      command(r, "e", "power", "Engines", escape);
      command(r, "p", "heading", r.mission!.secrets.headings[2], escape);
      command(r, "p", "code", r.mission!.secrets.code, escape);
      command(r, "c", "authorize", undefined, escape);
      command(r, "p", "escape", undefined, escape + 3);
      expect(r.mission!.result, r.mission!.variant.name).toBe("victory");
    }
  });
  it("first emergency begins at 12 seconds and precise damage starts then", () => {
    const r = room();
    advance(r.mission!, base + 13000);
    expect(r.mission!.hull).toBe(98);
  });
  it("delayed sync equals frequent sync across all boundaries", () => {
    const a = room(),
      b = room();
    advance(a.mission!, base + 149000);
    for (let t = 1; t <= 149; t++) advance(b.mission!, base + t * 1000);
    expect(a.mission).toEqual(b.mission);
    expect(a.mission!.result).toBe("defeat");
  });
  it("maneuver and hold complete without intermediate requests", () => {
    const r = room();
    wave(r);
    expect(r.mission!.completedAt[0]).not.toBeNull();
    expect(r.mission!.hull).toBeCloseTo(100 - 2 * (55 / 60), 5);
  });

  it("a maneuver through the alignment zone only protects inside that zone", () => {
    const r = room();
    r.mission!.heading = 230;
    r.mission!.target = 250;
    r.mission!.power = "Shield";
    r.mission!.shield = "Port";
    r.mission!.evaluatedAt = base + 12000;
    advance(r.mission!, base + 13000);
    expect(r.mission!.hull).toBeCloseTo(100 - 2 * (1 - 10 / 60), 5);
    expect(r.mission!.completedAt[0]).toBeNull();
  });
  it("moving out of alignment immediately ends a hold and resumes damage", () => {
    const r = room();
    r.mission!.heading = 240;
    r.mission!.target = 300;
    r.mission!.power = "Shield";
    r.mission!.shield = "Port";
    r.mission!.evaluatedAt = base + 12000;
    advance(r.mission!, base + 13000);
    expect(r.mission!.hull).toBeCloseTo(100 - 2 * (1 - 5 / 60), 5);
    expect(r.mission!.holdSince[0]).toBeNull();
  });
  it("wrap-around headings take the shortest path", () => {
    const r = room();
    r.mission!.heading = 350;
    r.mission!.target = 10;
    advance(r.mission!, base + 500);
    expect(r.mission!.heading).toBe(10);
  });
  it("changing power interrupts a hold immediately", () => {
    const r = room();
    const t = r.mission!.variant.stageStarts[0];
    command(r, "c", "shield", r.mission!.secrets.sectors[0], t);
    command(r, "p", "heading", r.mission!.secrets.headings[0], t);
    command(r, "e", "power", "Shield", t);
    advance(r.mission!, base + (t + 2) * 1000);
    command(r, "e", "power", "Balanced", t + 2);
    expect(r.mission!.holdSince[0]).toBeNull();
  });
  it("wrong resets cost ten hull and enforce cooldown", () => {
    const r = room();
    wave(r);
    const t = r.mission!.variant.stageStarts[r.mission!.variant.order.indexOf("coolant")];
    const wrong = ["A", "B", "C"].find((circuit) => circuit !== r.mission!.secrets.broken)!;
    command(r, "e", "isolate", wrong, t);
    command(r, "e", "vent", undefined, t);
    const h = r.mission!.hull;
    command(r, "e", "reset", undefined, t);
    expect(r.mission!.hull).toBe(h - 10);
    command(r, "e", "vent", undefined, t + 1);
    expect(() => command(r, "e", "reset", undefined, t + 1)).toThrow(
      "cooling down",
    );
  });
  it("repair prevents coolant damage including delayed requests", () => {
    const r = room();
    wave(r);
    const t = r.mission!.variant.stageStarts[r.mission!.variant.order.indexOf("coolant")];
    command(r, "e", "isolate", r.mission!.secrets.broken, t);
    command(r, "e", "vent", undefined, t);
    command(r, "e", "reset", undefined, t);
    const h = r.mission!.hull;
    advance(r.mission!, base + (t + 8) * 1000);
    expect(r.mission!.hull).toBe(h);
  });
  it("coolant damage starts with its scheduled event and does not retroactively stop", () => {
    const r = room();
    wave(r);
    const t = r.mission!.variant.stageStarts[r.mission!.variant.order.indexOf("coolant")];
    advance(r.mission!, base + (t + 5) * 1000);
    expect(r.mission!.hull).toBeCloseTo(100 - 2 * (55 / 60) - 5);
  });
  it("keeps an unrepaired coolant leak damaging the ship during escape", () => {
    const r = room();
    r.mission!.completedAt = [base + 20000, base + 100000];
    r.mission!.evaluatedAt = base + 120000;
    advance(r.mission!, base + 135000);
    expect(r.mission!.hull).toBe(85);
  });
  it("full coordinated mission succeeds", () => {
    const r = room();
    wave(r);
    const coolant = r.mission!.variant.stageStarts[r.mission!.variant.order.indexOf("coolant")];
    command(r, "e", "isolate", r.mission!.secrets.broken, coolant);
    command(r, "e", "vent", undefined, coolant);
    command(r, "e", "reset", undefined, coolant);
    wave(r, true);
    const escape = r.mission!.variant.stageStarts[3];
    command(r, "e", "power", "Engines", escape);
    command(r, "p", "heading", r.mission!.secrets.headings[2], escape);
    command(r, "p", "code", r.mission!.secrets.code, escape);
    command(r, "c", "authorize", undefined, escape);
    command(r, "p", "escape", undefined, escape + 3);
    expect(r.mission!.result).toBe("victory");
    expect(r.mission!.hull).toBeGreaterThan(90);
  });
  it("missed departure fails exactly at the deadline", () => {
    const r = room();
    r.mission!.completedAt = [base + 20000, base + 105000];
    r.mission!.repairedAt = base + 51000;
    advance(r.mission!, base + 170000);
    expect(r.mission!.result).toBe("defeat");
    expect(r.mission!.endedAt).toBe(base + 150000);
  });
  it("no controls can resurrect a failed mission", () => {
    const r = room();
    advance(r.mission!, base + 160000);
    expect(() => command(r, "e", "power", "Shield", 161)).toThrow("not active");
  });
  it("private information is filtered by station", () => {
    const r = room();
    const c = snapshot(r, "c", base),
      p = snapshot(r, "p", base),
      e = snapshot(r, "e", base);
    expect(c.station.code).toBeDefined();
    expect(p.station.code).toBeUndefined();
    expect(e.station.code).toBeUndefined();
    expect(c.station.symbols).toBeUndefined();
    expect(p.station.symbols).toBeUndefined();
    expect(e.station.symbols).toBeDefined();
    expect(c.station.brokenSymbol).toBeDefined();
    expect(e.station.brokenSymbol).toBeUndefined();
    expect(c.mission?.variant).toEqual(e.mission?.variant);
    expect(JSON.stringify(c)).not.toContain(r.mission!.seed);
    expect(JSON.stringify(p.mission)).not.toContain("secrets");
  });
  it("role spoofing is rejected", () => {
    expect(() => command(room(), "p", "shield", "Port", 12)).toThrow(
      "another station",
    );
  });
  it("deduplicates commands", () => {
    const r = room();
    wave(r);
    const coolant = r.mission!.variant.stageStarts[r.mission!.variant.order.indexOf("coolant")];
    command(r, "e", "isolate", r.mission!.secrets.broken, coolant);
    command(r, "e", "vent", undefined, coolant);
    apply(r, "e", { type: "reset" }, base + coolant * 1000, "same-id");
    const h = r.mission!.hull;
    apply(r, "e", { type: "reset" }, base + coolant * 1000, "same-id");
    expect(r.mission!.hull).toBe(h);
  });
  it("reconnect keeps identity and role without an extra seat", () => {
    const r = room();
    join(r, "p", "Changed", base + 10);
    expect(r.players).toHaveLength(3);
    expect(r.players[1].role).toBe("Pilot");
    expect(snapshot(r, "p", base + 10).mission?.variant).toEqual(snapshot(r, "c", base + 10).mission?.variant);
  });
  it("fourth player cannot join", () => {
    const r = room();
    r.mission = null;
    expect(() => join(r, "x", "Fourth", base)).toThrow("full");
  });
  it("host swaps roles and resets readiness", () => {
    const r = room();
    r.mission = null;
    command(r, "c", "swap", "p", 0);
    expect(r.players[0].role).toBe("Pilot");
    expect(r.players[1].role).toBe("Commander");
    expect(r.players.every((p) => !p.ready)).toBe(true);
  });
  it("host remains host after swapping and can retry", () => {
    const r = room();
    const previousVariant = r.mission!.variant.name;
    r.mission!.completedAt = [base + 20000, base + 110000];
    r.mission!.repairedAt = base + 60000;
    r.mission!.isolated = "C";
    r.mission!.vented = true;
    r.mission!.codeEntered = "1234";
    advance(r.mission!, base + 160000);
    command(r, "c", "retry", undefined, 161);
    expect(r.mission).toBeNull();
    expect(r.players.every((p) => !p.ready)).toBe(true);
    const previousSeed = r.lastMissionSeed;
    r.players.forEach((p) => { p.ready = true; p.seenAt = base + 162000; });
    command(r, "c", "start", undefined, 162);
    expect(r.mission!.seed).not.toBe(previousSeed);
    expect(r.mission!.variant.name).not.toBe(previousVariant);
    expect(r.mission!.variant).toEqual(newMission(base + 162000, r.mission!.seed).variant);
    expect(r.mission!.completedAt).toEqual([null, null]);
    expect(r.mission!.repairedAt).toBeNull();
    expect(r.mission!.isolated).toBeNull();
    expect(r.mission!.vented).toBe(false);
    expect(r.mission!.codeEntered).toBe("");
    expect(r.players.map((p) => p.role)).toEqual(["Commander", "Pilot", "Engineer"]);
  });
  it("start requires all three players connected and ready", () => {
    const r = room();
    r.mission = null;
    r.players[1].ready = false;
    expect(() => command(r, "c", "start", undefined, 0)).toThrow("ready");
  });
  it("cannot escape while objectives remain incomplete", () => {
    const r = room();
    r.mission!.hull = 1000;
    advance(r.mission!, base + 130000);
    expect(() => command(r, "p", "escape", undefined, 131)).toThrow("requires");
  });
  it("action values are validated", () => {
    const r = room();
    expect(() => command(r, "p", "heading", NaN, 0)).toThrow("Invalid");
    expect(() => command(r, "e", "power", "Bogus", 0)).toThrow("Invalid");
  });
});
