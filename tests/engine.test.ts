import { describe, expect, it } from "vitest";
import { advance, apply, ensureMissionVariant, join, missionPatterns, newMission, phaseAt, snapshot } from "../lib/engine";
import type { Mission, Room } from "../lib/types";

const base = 1_000_000;
let actionNumber = 0;

function seedForPattern(index: number) {
  const name = missionPatterns[index].name;
  for (let n = 0; n < 1000; n++) {
    const seed = n.toString(16).padStart(32, "0");
    if (newMission(base, seed).variant.name === name) return seed;
  }
  throw new Error("No seed found for mission pattern");
}
function room(seed = seedForPattern(0)): Room {
  const mission = newMission(base, seed);
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
    lastEmergencyKinds: [...mission.variant.emergencyKinds],
    processed: [],
  };
}
function act(r: Room, id: string, type: string, value: string | number | boolean | undefined, seconds: number) {
  apply(r, id, { type, value }, base + seconds * 1000, `test-action-${++actionNumber}`);
}

function recoverFlare(r: Room) {
  const m = r.mission!;
  const at = m.variant.stageStarts[0];
  act(r, "c", "shield", m.secrets.sectors[0], at);
  act(r, "p", "heading", m.secrets.headings[0], at);
  act(r, "e", "power", "Shield", at);
  advance(m, base + (at + 12) * 1000);
}
function recoverSecondEmergency(r: Room) {
  const m = r.mission!;
  const at = m.variant.stageStarts[1];
  const kind = m.variant.emergencyKinds[1];
  if (kind === "reactor-overheat") {
    const priority = m.secrets.answers[1];
    act(r, "c", "decision", priority, at);
    act(r, "p", "stabilize", true, at);
    act(r, "e", "power", priority === "Shields" ? "Shield" : "Balanced", at);
    act(r, "e", "systems", priority, at);
  } else {
    act(r, "c", "decision", "restore-comms", at);
    act(r, "p", "stabilize", true, at);
    act(r, "e", "power", "Balanced", at);
    act(r, "e", "systems", "restore-comms", at);
  }
  advance(m, base + (at + 14) * 1000);
}
function recoverThirdEmergency(r: Room) {
  const m = r.mission!;
  const at = m.variant.stageStarts[2];
  const kind = m.variant.emergencyKinds[2];
  if (kind === "debris-field") {
    act(r, "c", "decision", "safe", at);
    act(r, "p", "heading", m.secrets.headings[2], at);
    act(r, "e", "power", "Engines", at);
  } else {
    act(r, "c", "decision", m.secrets.answers[2], at);
    act(r, "p", "stabilize", true, at);
    act(r, "e", "systems", m.secrets.answers[2], at);
  }
  advance(m, base + (m.variant.stageStarts[3]) * 1000);
}
function surviveFinale(r: Room) {
  const m = r.mission!;
  const at = m.variant.stageStarts[3];
  act(r, "e", "power", "Engines", at);
  act(r, "p", "heading", m.secrets.headings[2], at);
  act(r, "c", "authorize", true, at);
  act(r, "p", "code", m.secrets.code, at);
  advance(m, base + (at + 10) * 1000);
  act(r, "p", "escape", true, at + 11);
}
function playSuccessfulMission(r: Room) {
  recoverFlare(r);
  recoverSecondEmergency(r);
  recoverThirdEmergency(r);
  surviveFinale(r);
}

describe("Emergency Interaction System", () => {
  it("generates a deterministic, varied mission from its server seed", () => {
    const seed = seedForPattern(2);
    const first = newMission(base, seed);
    expect(newMission(base, seed)).toEqual(first);
    expect(first.seed).toBe(seed);
    expect(new Set(first.variant.emergencyKinds).size).toBe(3);
    expect(first.variant.emergencyKinds[0]).toBe("solar-flare");
    expect(first.variant.stageStarts[0]).toBeGreaterThanOrEqual(10);
    expect(first.variant.stageStarts[0]).toBeLessThanOrEqual(15);
    expect(first.variant.stageStarts[3]).toBeGreaterThanOrEqual(125);
    expect(first.deadlines.at(-1)).toBe(base + 150_000);
    expect(first.variant.severity.every((severity) => severity >= 1 && severity <= 3)).toBe(true);
    expect(first.secrets.headings).not.toEqual([240, 60, 180]);
  });

  it("selects the full five-emergency set across deterministic mission variants", () => {
    const variants = missionPatterns.map((_, index) => newMission(base, seedForPattern(index)));
    expect(new Set(variants.map((mission) => mission.variant.name)).size).toBe(6);
    expect(new Set(variants.flatMap((mission) => mission.variant.emergencyKinds))).toEqual(new Set([
      "solar-flare", "reactor-overheat", "communications-failure", "debris-field", "sensor-disagreement",
    ]));
    for (const mission of variants) {
      expect(new Set(mission.variant.emergencyKinds).size).toBe(3);
      const [opening, second, third, finale] = mission.variant.stageStarts;
      expect(second - opening).toBeGreaterThanOrEqual(30);
      expect(third - second).toBeGreaterThanOrEqual(30);
      expect(finale).toBeGreaterThanOrEqual(125);
      expect(finale).toBeLessThanOrEqual(130);
    }
  });

  it("starts the first flare at the server deadline and resolves the three-role hold", () => {
    const r = room();
    const m = r.mission!;
    advance(m, base + 11_000);
    expect(m.hull).toBe(100);
    recoverFlare(r);
    expect(m.completedAt[0]).not.toBeNull();
    advance(m, base + (m.variant.stageStarts[1] - 1) * 1000);
    expect(m.emergencyResults[0]).toBeNull();
    advance(m, base + m.variant.stageStarts[1] * 1000);
    expect(m.emergencyResults[0]).toBe("recovered");
    expect(m.roleContributions).toMatchObject({ Commander: 1, Pilot: 1, Engineer: 1 });
  });

  it("makes a missed flare a recoverable degraded state with a shared consequence", () => {
    const r = room();
    const m = r.mission!;
    const close = m.variant.stageStarts[1];
    advance(m, base + close * 1000);
    expect(m.emergencyResults[0]).toBe("degraded");
    expect(m.hull).toBeLessThan(100);
    expect(m.hull).toBeGreaterThan(20);
    expect(m.shieldIntegrity).toBeLessThan(100);
    expect(m.result).toBeNull();
    expect(snapshot(r, "e", base + close * 1000).mission?.emergencyResults[0]).toBe("degraded");
  });

  it.each([0, 1, 2, 3, 4, 5])("allows a coordinated crew to survive generated pattern %i", (index) => {
    const r = room(seedForPattern(index));
    playSuccessfulMission(r);
    expect(r.mission!.result).toBe("victory");
    expect(r.mission!.emergencyResults).toEqual(["recovered", "recovered", "recovered"]);
    expect(r.mission!.hull).toBeGreaterThan(70);
    expect(r.mission!.roleContributions.Commander).toBeGreaterThan(0);
    expect(r.mission!.roleContributions.Pilot).toBeGreaterThan(0);
    expect(r.mission!.roleContributions.Engineer).toBeGreaterThan(0);
    expect(r.mission!.log.some((entry) => entry.text.includes("stabilized by the crew"))).toBe(true);
    expect(r.mission!.reason).toContain("together");
  });

  it("requires Commander, Pilot, and Engineer to combine different reactor actions", () => {
    const r = room(seedForPattern(0));
    recoverFlare(r);
    const at = r.mission!.variant.stageStarts[1];
    const priority = r.mission!.secrets.answers[1];
    act(r, "c", "decision", priority, at);
    act(r, "e", "power", "Balanced", at);
    if (priority === "Shields") {
      act(r, "e", "power", "Shield", at);
      act(r, "e", "systems", priority, at);
      expect(r.mission!.shieldIntegrity).toBe(100);
    } else {
      act(r, "e", "systems", priority, at);
    }
    expect(r.mission!.systemPriorityApplied).toBe(priority);
    expect(r.mission!.emergencyResults[1]).toBeNull();
    act(r, "p", "stabilize", true, at);
    advance(r.mission!, base + r.mission!.variant.stageStarts[2] * 1000);
    expect(r.mission!.emergencyResults[1]).toBe("recovered");
  });

  it("requires the called power route and aggressive movement raises reactor heat", () => {
    const r = room(seedForPattern(0));
    recoverFlare(r);
    const at = r.mission!.variant.stageStarts[1];
    const priority = r.mission!.secrets.answers[1];
    act(r, "c", "decision", priority, at);
    act(r, "p", "heading", 0, at);
    expect(() => act(r, "e", "systems", priority, at)).toThrow("power");
    advance(r.mission!, base + (at + 3) * 1000);
    expect(r.mission!.heat).toBeGreaterThan(20);
    act(r, "p", "stabilize", true, at + 3);
    act(r, "e", "power", priority === "Shields" ? "Shield" : "Balanced", at + 3);
    act(r, "e", "systems", priority, at + 3);
    expect(r.mission!.systemPriorityApplied).toBe(priority);
  });

  it("hides Command navigation data during comms loss and makes the Pilot the outside feed", () => {
    const r = room(seedForPattern(1));
    recoverFlare(r);
    const at = r.mission!.variant.stageStarts[1];
    act(r, "c", "decision", "restore-comms", at);
    const c = snapshot(r, "c", base + at * 1000);
    const p = snapshot(r, "p", base + at * 1000);
    expect(c.mission?.commsOnline).toBe(false);
    expect(c.station.headings).toBeUndefined();
    expect(c.station.code).toBeUndefined();
    expect(p.station.externalThreat).toBeDefined();
    act(r, "p", "stabilize", true, at);
    act(r, "e", "power", "Balanced", at);
    act(r, "e", "systems", "restore-comms", at);
    expect(snapshot(r, "c", base + at * 1000).mission?.commsOnline).toBe(true);
    expect(r.mission!.shieldIntegrity).toBe(90);
  });

  it("makes the debris route a safe-versus-fast tradeoff", () => {
    const r = room(seedForPattern(0));
    recoverFlare(r);
    recoverSecondEmergency(r);
    const m = r.mission!;
    const hull = m.hull;
    const at = m.variant.stageStarts[2];
    act(r, "c", "decision", "fast", at);
    act(r, "p", "heading", m.secrets.headings[2], at);
    act(r, "e", "power", "Engines", at);
    advance(m, base + m.variant.stageStarts[3] * 1000);
    expect(m.emergencyResults[2]).toBe("degraded");
    expect(m.hull).toBeLessThan(hull);
    expect(m.propulsion).toBeLessThan(100);
    expect(m.result).toBeNull();
  });

  it("gives three distinct clues for sensor disagreement without exposing the answer", () => {
    const r = room(seedForPattern(1));
    recoverFlare(r);
    recoverSecondEmergency(r);
    const at = r.mission!.variant.stageStarts[2];
    const c = snapshot(r, "c", base + at * 1000);
    const p = snapshot(r, "p", base + at * 1000);
    const e = snapshot(r, "e", base + at * 1000);
    expect(p.station.navigationTrace).toBeDefined();
    expect(e.station.sensorDiagnostic).toBeDefined();
    expect(c.station.sensorDiagnostic).toBeUndefined();
    expect(JSON.stringify([c, p, e])).not.toContain('"answers"');
    act(r, "c", "decision", r.mission!.secrets.answers[2], at);
    act(r, "p", "stabilize", true, at);
    act(r, "e", "systems", r.mission!.secrets.answers[2], at);
    advance(r.mission!, base + r.mission!.variant.stageStarts[3] * 1000);
    expect(r.mission!.emergencyResults[2]).toBe("recovered");
    expect(r.mission!.sensorsReliable).toBe(true);
  });

  it("lets the Engineer spend a limited finale kit to recover damaged systems", () => {
    const r = room();
    recoverFlare(r);
    const m = r.mission!;
    m.emergencyResults = ["degraded", "degraded", "degraded"];
    m.commsOnline = false;
    m.sensorsReliable = false;
    m.propulsion = 30;
    const at = m.variant.stageStarts[3];
    act(r, "e", "power", "Balanced", at);
    act(r, "e", "systems", "repair-comms", at);
    act(r, "e", "systems", "repair-propulsion", at);
    expect(m.commsOnline).toBe(true);
    expect(m.propulsion).toBe(60);
    expect(m.repairKits).toBe(0);
    expect(m.repairsUsed).toBe(2);
    expect(() => act(r, "e", "systems", "repair-sensors", at)).toThrow("No repair kits");
  });

  it("does not let an unresolved or badly damaged ship leave in the finale", () => {
    const r = room();
    const m = r.mission!;
    const at = m.variant.stageStarts[3];
    m.emergencyResults = ["recovered", "recovered", "degraded"];
    m.hull = 12;
    m.evaluatedAt = base + at * 1000;
    act(r, "e", "power", "Engines", at);
    act(r, "p", "heading", m.secrets.headings[2], at);
    act(r, "c", "authorize", true, at);
    act(r, "p", "code", m.secrets.code, at);
    expect(() => act(r, "p", "escape", true, at + 1)).toThrow("hull and propulsion reserve");
  });

  it("defeat records the cause and ends at the authoritative 150-second mark", () => {
    const r = room();
    r.mission!.emergencyResults = ["recovered", "recovered", "recovered"];
    r.mission!.completedAt = [base + 20_000, base + 110_000];
    r.mission!.evaluatedAt = base + 149_000;
    advance(r.mission!, base + 170_000);
    expect(r.mission!.result).toBe("defeat");
    expect(r.mission!.endedAt).toBe(base + 150_000);
    expect(r.mission!.reason).toBeTruthy();
    expect(r.mission!.emergencyResults[0]).toBe("recovered");
  });

  it("keeps coarse and frequent authoritative synchronization equivalent", () => {
    const a = room();
    const b = room();
    advance(a.mission!, base + 45_000);
    for (let t = 1; t <= 45; t++) advance(b.mission!, base + t * 1000);
    expect(a.mission).toEqual(b.mission);
  });

  it("keeps the three role information boundaries and shared configuration consistent", () => {
    const r = room();
    const c = snapshot(r, "c", base);
    const p = snapshot(r, "p", base);
    const e = snapshot(r, "e", base);
    expect(c.mission?.variant).toEqual(p.mission?.variant);
    expect(p.mission?.variant).toEqual(e.mission?.variant);
    expect(c.station.code).toBeDefined();
    expect(p.station.code).toBeUndefined();
    expect(e.station.code).toBeUndefined();
    expect(c.station.symbols).toBeUndefined();
    expect(p.station.symbols).toBeUndefined();
    expect(e.station.symbols).toBeDefined();
    expect(JSON.stringify([c, p, e])).not.toContain("secrets");
    expect(JSON.stringify([c, p, e])).not.toContain(r.mission!.seed);
    expect(JSON.stringify([c, p, e])).not.toContain(r.mission!.secrets.answers.join(""));
  });

  it("filters reactor, route, and sensor readings by role", () => {
    const r = room(seedForPattern(0));
    recoverFlare(r);
    const reactorAt = r.mission!.variant.stageStarts[1];
    expect(snapshot(r, "e", base + reactorAt * 1000).station.reactorReading).toBeDefined();
    expect(snapshot(r, "c", base + reactorAt * 1000).station.reactorReading).toBeUndefined();
    recoverSecondEmergency(r);
    const debrisAt = r.mission!.variant.stageStarts[2];
    expect(snapshot(r, "c", base + debrisAt * 1000).station.routeIntel).toBeDefined();
    expect(snapshot(r, "p", base + debrisAt * 1000).station.routeIntel).toBeUndefined();
  });

  it("reconstructs a legacy active mission without changing its timing or hull", () => {
    const r = room();
    const m = r.mission!;
    delete (m as Partial<Mission>).variant;
    delete (m as Partial<Mission>).emergencyResults;
    delete (m as Partial<Mission>).repairKits;
    m.hull = 73;
    m.evaluatedAt = base + 55_000;
    ensureMissionVariant(r);
    const result = structuredClone(r.mission);
    ensureMissionVariant(r);
    expect(r.mission).toEqual(result);
    expect(r.mission!.variant.stageStarts).toEqual([12, 50, 90, 130]);
    expect(r.mission!.hull).toBe(73);
    expect(r.mission!.evaluatedAt).toBe(base + 55_000);
    expect(r.mission!.repairKits).toBe(2);
  });

  it("deduplicates repeated actions and rejects role spoofing", () => {
    const r = room();
    const now = base + 1_000;
    apply(r, "e", { type: "power", value: "Shield" }, now, "same-action-id");
    const contribution = r.mission!.roleContributions.Engineer;
    apply(r, "e", { type: "power", value: "Shield" }, now, "same-action-id");
    expect(r.mission!.roleContributions.Engineer).toBe(contribution);
    expect(() => act(r, "p", "shield", "Port", 2)).toThrow("another station");
    expect(() => act(r, "e", "power", "Warp", 2)).toThrow("Invalid power");
  });

  it("keeps role identity on reconnect and room capacity at exactly three", () => {
    const r = room();
    join(r, "p", "Changed", base + 10);
    expect(r.players).toHaveLength(3);
    expect(r.players[1].role).toBe("Pilot");
    r.mission = null;
    expect(() => join(r, "x", "Fourth", base)).toThrow("full");
  });

  it("selects at least one new emergency type after a retry in the same room", () => {
    const r = room(seedForPattern(0));
    const previousKinds = [...r.mission!.variant.emergencyKinds];
    const previousSeed = r.mission!.seed;
    r.mission!.result = "defeat";
    r.mission!.endedAt = base + 10_000;
    act(r, "c", "retry", undefined, 11);
    r.players.forEach((player) => { player.ready = true; player.seenAt = base + 12_000; });
    act(r, "c", "start", undefined, 12);
    expect(r.mission!.seed).not.toBe(previousSeed);
    expect(r.mission!.variant.emergencyKinds.filter((kind) => kind !== "solar-flare" && !previousKinds.includes(kind))).toHaveLength(2);
    expect(r.mission!.emergencyResults).toEqual([null, null, null]);
    expect(r.mission!.repairKits).toBe(2);
    expect(r.mission!.roleContributions).toEqual({ Commander: 0, Pilot: 0, Engineer: 0 });
  });

  it("validates every generated stage boundary", () => {
    const m = newMission(base, seedForPattern(3));
    expect(phaseAt(m, base + (m.variant.stageStarts[0] - 1) * 1000)).toBe(0);
    expect(phaseAt(m, base + m.variant.stageStarts[0] * 1000)).toBe(1);
    expect(phaseAt(m, base + m.variant.stageStarts[1] * 1000)).toBe(2);
    expect(phaseAt(m, base + m.variant.stageStarts[2] * 1000)).toBe(3);
    expect(phaseAt(m, base + m.variant.stageStarts[3] * 1000)).toBe(4);
    expect(phaseAt(m, base + 150_000)).toBe(4);
  });
});
