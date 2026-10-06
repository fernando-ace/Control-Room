import { Action, Mission, Player, ROLES, Room, Snapshot } from "./types";
import { createHash, randomBytes } from "node:crypto";
import type { MissionEvent, MissionVariant } from "./types";
const angle = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
export const phaseAt = (m: Mission, t: number) => {
  const e = (t - m.startAt) / 1000;
  return m.variant.stageStarts.findIndex((s) => e < s) === -1
    ? 4
    : m.variant.stageStarts.findIndex((s) => e < s);
};
const patterns: MissionVariant[] = [
  { name: "Sunstroke", order: ["storm-1", "coolant", "storm-2"], stageStarts: [12, 52, 94, 130], coolantAt: 52, intelRole: "Commander" },
  { name: "Cold Front", order: ["coolant", "storm-1", "storm-2"], stageStarts: [12, 50, 91, 130], coolantAt: 12, intelRole: "Engineer" },
  { name: "Double Flash", order: ["storm-1", "storm-2", "coolant"], stageStarts: [13, 54, 96, 132], coolantAt: 96, intelRole: "Pilot" },
  { name: "Black Ice", order: ["coolant", "storm-2", "storm-1"], stageStarts: [11, 57, 98, 134], coolantAt: 11, intelRole: "Commander" },
  { name: "Crosswind", order: ["storm-2", "coolant", "storm-1"], stageStarts: [14, 55, 95, 131], coolantAt: 55, intelRole: "Engineer" },
  { name: "Solar Echo", order: ["storm-2", "storm-1", "coolant"], stageStarts: [12, 51, 99, 135], coolantAt: 99, intelRole: "Pilot" },
];
export const missionPatterns = patterns;
export function ensureMissionVariant(room: Room) {
  const mission = room.mission as (Mission & { variant?: MissionVariant; seed?: string }) | null;
  if (!mission || mission.variant) return;
  const seed = createHash("sha256")
    .update(`legacy-solar-storm:${room.id}:${mission.startAt}`)
    .digest("hex")
    .slice(0, 32);
  mission.seed = seed;
  mission.variant = {
    name: "Solar Storm",
    order: ["storm-1", "coolant", "storm-2"],
    stageStarts: [12, 50, 90, 130],
    coolantAt: 80,
    intelRole: "Commander",
  };
  room.lastMissionSeed ??= seed;
  room.lastVariantName ??= mission.variant.name;
}
function seedStream(seed: string) {
  let state = 2166136261;
  for (const char of seed) state = Math.imul(state ^ char.charCodeAt(0), 16777619) >>> 0;
  return () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}
export function newMission(now: number, seed = randomBytes(16).toString("hex")): Mission {
  if (!/^[a-f\d]{32}$/i.test(seed)) throw new Error("Invalid mission seed");
  const random = seedStream(seed);
  const variant = structuredClone(patterns[Math.floor(random() * patterns.length)]);
  const broken = ["A", "B", "C"][Math.floor(random() * 3)];
  const headings = [240, 60, 180];
  return {
    seed,
    variant,
    startAt: now,
    evaluatedAt: now,
    deadlines: [...variant.stageStarts, 150].map((s) => now + s * 1000),
    hull: 100,
    heading: 180,
    target: 180,
    power: "Balanced",
    shield: "Off",
    heat: 20,
    isolated: null,
    vented: false,
    repairedAt: null,
    resetAt: null,
    holdSince: [null, null],
    completedAt: [null, null],
    codeEntered: "",
    authorizedAt: null,
    endedAt: null,
    result: null,
    reason: null,
    secrets: {
      headings,
      sectors: ["Port", "Starboard"],
      symbols: { A: "○", B: "△", C: "□" },
      broken,
      code: String(Math.floor(random() * 9000) + 1000),
    },
  };
}
const eventForPhase = (m: Mission, phase: number): MissionEvent | null =>
  phase >= 1 && phase <= 3 ? m.variant.order[phase - 1] : null;
const waveForEvent = (event: MissionEvent | null) =>
  event === "storm-1" ? 0 : event === "storm-2" ? 1 : -1;
const coolantStarted = (m: Mission, now: number) => now >= m.startAt + m.variant.coolantAt * 1000;
const coolantControlsOpen = (m: Mission, now: number) =>
  phaseAt(m, now) >= m.variant.order.indexOf("coolant") + 1 && phaseAt(m, now) < 4;
function protectedNow(m: Mission, wave: number, forward = false) {
  const delta = ((m.target - m.heading + 540) % 360) - 180;
  const h =
    m.heading +
    (forward && Math.abs(delta) > 1e-7 ? Math.sign(delta) * 1e-5 : 0);
  return (
    m.power === "Shield" &&
    m.shield === m.secrets.sectors[wave] &&
    angle(h, m.secrets.headings[wave]) <= 5 + 1e-7
  );
}
export function advance(m: Mission, now: number) {
  if (m.result || now <= m.evaluatedAt) return;
  const end = Math.min(now, m.startAt + 150000);
  while (m.evaluatedAt < end && !m.result) {
    const t = m.evaluatedAt,
      p = phaseAt(m, t),
      wave = waveForEvent(eventForPhase(m, p));
    const valid = wave >= 0 && protectedNow(m, wave, true);
    if (wave >= 0 && !m.completedAt[wave]) {
      if (valid && m.holdSince[wave] === null) m.holdSince[wave] = t;
      if (!valid) m.holdSince[wave] = null;
    }
    let next = Math.min(end, ...m.deadlines.filter((x) => x > t));
    const delta = ((m.target - m.heading + 540) % 360) - 180;
    // Split at movement/tolerance boundaries so a delayed sync produces exactly the same damage.
    if (Math.abs(delta) > 1e-7)
      next = Math.min(next, t + (Math.abs(delta) / 60) * 1000);
    if (wave >= 0 && Math.abs(delta) > 1e-7) {
      const direction = Math.sign(delta);
      for (const boundary of [
        m.secrets.headings[wave] - 5,
        m.secrets.headings[wave] + 5,
      ]) {
        const distance =
          (((direction * (boundary - m.heading)) % 360) + 360) % 360;
        if (distance > 1e-7 && distance <= Math.abs(delta) + 1e-7)
          next = Math.min(next, t + (distance / 60) * 1000);
      }
    }
    const hold = wave >= 0 ? m.holdSince[wave] : null;
    if (wave >= 0 && !m.completedAt[wave] && hold !== null)
      next = Math.min(next, hold + (wave === 0 ? 5000 : 8000));
    const storm = wave >= 0 && !m.completedAt[wave] && !valid ? 2 : 0;
    const coolant = coolantStarted(m, t) && !m.repairedAt ? 1 : 0;
    const rate = storm + coolant;
    if (rate > 0) next = Math.min(next, t + (m.hull / rate) * 1000);
    if (next <= t + 1e-8) {
      next = Math.min(end, t + 0.001);
    }
    const dt = (next - t) / 1000;
    m.hull = Math.max(0, m.hull - rate * dt);
    m.heading =
      (m.heading +
        Math.sign(delta) * Math.min(Math.abs(delta), 60 * dt) +
        360) %
      360;
    if (coolantStarted(m, t) && !m.repairedAt)
      m.heat = Math.min(100, m.heat + dt);
    m.evaluatedAt = next;
    if (
      wave >= 0 &&
      hold !== null &&
      next >= hold + (wave === 0 ? 5000 : 8000) - 1e-5 &&
      !m.completedAt[wave]
    )
      m.completedAt[wave] = next;
    if (m.hull <= 1e-7) {
      m.hull = 0;
      m.result = "defeat";
      m.endedAt = next;
      m.reason = "Hull integrity lost";
    }
  }
  if (!m.result && now >= m.startAt + 150000) {
    m.result = "defeat";
    m.endedAt = m.startAt + 150000;
    m.reason = "Escape window missed";
  }
}
function requireRole(player: Player, role: string) {
  if (player.role !== role)
    throw new Error("This control belongs to another station");
}
export function apply(
  room: Room,
  uid: string,
  action: Action,
  now: number,
  actionId: string,
) {
  const player = room.players.find((p) => p.id === uid);
  if (!player) throw new Error("Not a member of this room");
  if (room.processed.includes(actionId)) {
    if (room.mission) advance(room.mission, now);
    return;
  }
  if (room.mission) advance(room.mission, now);
  player.seenAt = now;
  const m = room.mission;
  if (action.type === "sync") return;
  if (action.type === "ready") {
    if (m) throw new Error("Mission already started");
    if (typeof action.value !== "boolean")
      throw new Error("Invalid ready state");
    player.ready = action.value;
  } else if (action.type === "swap") {
    if (uid !== room.hostId || m)
      throw new Error("Only the host can swap roles in the lobby");
    const other = room.players.find((p) => p.id === action.value);
    if (!other) throw new Error("Player not found");
    [player.role, other.role] = [other.role, player.role];
    room.players.forEach((p) => (p.ready = false));
  } else if (action.type === "start") {
    if (
      uid !== room.hostId ||
      m ||
      room.players.length !== 3 ||
      room.players.some((p) => !p.ready || now - p.seenAt > 15000)
    )
      throw new Error("Three connected, ready players are required");
    let seed = randomBytes(16).toString("hex");
    let mission = newMission(now, seed);
    while (seed === room.lastMissionSeed || mission.variant.name === room.lastVariantName) {
      seed = randomBytes(16).toString("hex");
      mission = newMission(now, seed);
    }
    room.lastMissionSeed = seed;
    room.lastVariantName = mission.variant.name;
    room.mission = mission;
  } else if (action.type === "retry") {
    if (uid !== room.hostId || !m?.result)
      throw new Error("Only the host can retry after a result");
    room.lastMissionSeed = m.seed;
    room.lastVariantName = m.variant.name;
    room.mission = null;
    room.players.forEach((p) => (p.ready = false));
  } else {
    if (!m || m.result) throw new Error("Mission is not active");
    const p = phaseAt(m, now);
    switch (action.type) {
      case "heading":
        requireRole(player, "Pilot");
        if (
          typeof action.value !== "number" ||
          !Number.isFinite(action.value) ||
          action.value < 0 ||
          action.value >= 360
        )
          throw new Error("Invalid heading");
        m.target = action.value;
        break;
      case "power":
        requireRole(player, "Engineer");
        if (!["Balanced", "Shield", "Engines"].includes(String(action.value)))
          throw new Error("Invalid power preset");
        m.power = action.value as Mission["power"];
        break;
      case "shield":
        requireRole(player, "Commander");
        if (!["Off", "Port", "Starboard"].includes(String(action.value)))
          throw new Error("Invalid shield sector");
        m.shield = action.value as Mission["shield"];
        break;
      case "isolate":
        requireRole(player, "Engineer");
        if (!coolantControlsOpen(m, now) || !["A", "B", "C"].includes(String(action.value)))
          throw new Error("Circuit control unavailable");
        m.isolated = String(action.value);
        m.vented = false;
        break;
      case "vent":
        requireRole(player, "Engineer");
        if (!coolantControlsOpen(m, now) || !m.isolated || m.repairedAt)
          throw new Error("Isolate a circuit before venting");
        m.vented = true;
        m.heat = Math.max(20, m.heat - 35);
        break;
      case "reset":
        requireRole(player, "Engineer");
        if (!coolantControlsOpen(m, now) || !m.isolated || !m.vented || m.repairedAt)
          throw new Error("Isolate, then vent, then reset");
        if (m.resetAt && now - m.resetAt < 3000)
          throw new Error("Reset cooling down");
        m.resetAt = now;
        if (m.isolated === m.secrets.broken) {
          m.repairedAt = now;
          m.heat = 20;
        } else {
          m.hull = Math.max(0, m.hull - 10);
          m.vented = false;
          if (m.hull === 0) {
            m.result = "defeat";
            m.reason = "Incorrect circuit reset destroyed hull";
            m.endedAt = now;
          }
        }
        break;
      case "code":
        requireRole(player, "Pilot");
        if (p !== 4 || !/^\d{4}$/.test(String(action.value)))
          throw new Error("Enter a four-digit code during escape");
        m.codeEntered = String(action.value);
        break;
      case "authorize":
        requireRole(player, "Commander");
        if (p !== 4) throw new Error("Escape window not open");
        m.authorizedAt = now;
        break;
      case "escape":
        requireRole(player, "Pilot");
        if (
          p !== 4 ||
          m.codeEntered !== m.secrets.code ||
          !m.authorizedAt ||
          m.power !== "Engines" ||
          angle(m.heading, m.secrets.headings[2]) > 5 ||
          !m.repairedAt ||
          m.completedAt.some((x) => x === null)
        )
          throw new Error(
            "Escape requires both storm holds, coolant repair, engine power, alignment, code, and authorization",
          );
        m.result = "victory";
        m.endedAt = now;
        m.reason = "Crew and spacecraft safe";
        break;
      default:
        throw new Error("Unknown action");
    }
    // Actions can break a hold at the same timestamp, before the next synchronization.
    [0, 1].forEach((w) => {
      if (!protectedNow(m, w)) m.holdSince[w] = null;
    });
  }
  room.processed = [...room.processed.slice(-255), actionId];
}
export function snapshot(room: Room, uid: string, now: number): Snapshot {
  const role = room.players.find((p) => p.id === uid)?.role;
  if (!role) throw new Error("Not a room member");
  const m = room.mission;
  return {
    id: room.id,
    code: room.code,
    hostId: room.hostId,
    revision: room.revision,
    players: room.players,
    me: uid,
    serverNow: now,
    mission: m
      ? {
          startAt: m.startAt,
          serverNow: now,
          deadlines: m.deadlines,
          phase: phaseAt(m, m.endedAt ?? now),
          hull: m.hull,
          completedAt: m.completedAt,
          repairedAt: m.repairedAt,
          endedAt: m.endedAt,
          result: m.result,
          reason: m.reason,
          variant: m.variant,
        }
      : null,
    station: !m
      ? {}
      : role === "Commander"
        ? {
            headings: m.secrets.headings,
            sectors: m.secrets.sectors,
            code: m.secrets.code,
            shield: m.shield,
            ...(m.variant.intelRole === "Commander" ? { brokenSymbol: m.secrets.symbols[m.secrets.broken] } : {}),
          }
        : role === "Pilot"
          ? {
              heading: m.heading,
              target: m.target,
              engineReady: m.power === "Engines",
              codeEntered: m.codeEntered,
              authorized: Boolean(m.authorizedAt),
            ...(m.variant.intelRole === "Pilot" ? { brokenSymbol: m.secrets.symbols[m.secrets.broken] } : {}),
            }
          : {
              power: m.power,
              heat: m.heat,
              isolated: m.isolated,
              vented: m.vented,
              symbols: m.secrets.symbols,
            ...(m.variant.intelRole === "Engineer" ? { brokenSymbol: m.secrets.symbols[m.secrets.broken] } : {}),
            },
  };
}
export function join(room: Room, uid: string, name: string, now: number) {
  if (room.blockedPlayers?.includes(uid))
    throw new Error("The host removed you from this room");
  const existing = room.players.find((p) => p.id === uid);
  if (existing) {
    existing.seenAt = now;
    return;
  }
  if (room.mission) throw new Error("Mission already started");
  if (room.players.length >= 3) throw new Error("Room is full");
  const role = ROLES.find((r) => !room.players.some((p) => p.role === r))!;
  room.players.push({ id: uid, name, role, ready: false, seenAt: now });
}
