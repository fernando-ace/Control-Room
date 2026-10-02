import { describe, expect, it } from "vitest";
import { advance, apply, join, newMission, snapshot } from "../lib/engine";
import type { Room } from "../lib/types";
const base = 1000000;
function room(): Room {
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
    mission: newMission(base, () => 0),
    processed: [],
  };
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
  const t = second ? 90 : 12;
  command(r, "e", "power", "Shield", t);
  command(r, "c", "shield", second ? "Starboard" : "Port", t);
  command(r, "p", "heading", second ? 60 : 240, t);
  advance(r.mission!, base + (t + 12) * 1000);
}
describe("Solar Storm timestamp simulation", () => {
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
    command(r, "c", "shield", "Port", 12);
    command(r, "p", "heading", 240, 12);
    command(r, "e", "power", "Shield", 12);
    advance(r.mission!, base + 14000);
    command(r, "e", "power", "Balanced", 14);
    expect(r.mission!.holdSince[0]).toBeNull();
  });
  it("wrong resets cost ten hull and enforce cooldown", () => {
    const r = room();
    wave(r);
    command(r, "e", "isolate", "B", 51);
    command(r, "e", "vent", undefined, 51);
    const h = r.mission!.hull;
    command(r, "e", "reset", undefined, 51);
    expect(r.mission!.hull).toBe(h - 10);
    command(r, "e", "vent", undefined, 52);
    expect(() => command(r, "e", "reset", undefined, 52)).toThrow(
      "cooling down",
    );
  });
  it("repair prevents coolant damage including delayed requests", () => {
    const r = room();
    wave(r);
    command(r, "e", "isolate", "A", 51);
    command(r, "e", "vent", undefined, 51);
    command(r, "e", "reset", undefined, 51);
    const h = r.mission!.hull;
    advance(r.mission!, base + 89000);
    expect(r.mission!.hull).toBe(h);
  });
  it("coolant damage starts at 80 seconds and does not retroactively stop", () => {
    const r = room();
    wave(r);
    advance(r.mission!, base + 85000);
    expect(r.mission!.hull).toBeCloseTo(100 - 2 * (55 / 60) - 5);
  });
  it("full coordinated mission succeeds", () => {
    const r = room();
    wave(r);
    command(r, "e", "isolate", "A", 51);
    command(r, "e", "vent", undefined, 51);
    command(r, "e", "reset", undefined, 51);
    wave(r, true);
    command(r, "e", "power", "Engines", 130);
    command(r, "p", "heading", 180, 130);
    command(r, "p", "code", r.mission!.secrets.code, 130);
    command(r, "c", "authorize", undefined, 130);
    command(r, "p", "escape", undefined, 133);
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
    command(r, "e", "isolate", "B", 51);
    command(r, "e", "vent", undefined, 51);
    apply(r, "e", { type: "reset" }, base + 51000, "same-id");
    const h = r.mission!.hull;
    apply(r, "e", { type: "reset" }, base + 51000, "same-id");
    expect(r.mission!.hull).toBe(h);
  });
  it("reconnect keeps identity and role without an extra seat", () => {
    const r = room();
    join(r, "p", "Changed", base + 10);
    expect(r.players).toHaveLength(3);
    expect(r.players[1].role).toBe("Pilot");
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
    advance(r.mission!, base + 160000);
    command(r, "c", "retry", undefined, 161);
    expect(r.mission).toBeNull();
    expect(r.players.every((p) => !p.ready)).toBe(true);
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
