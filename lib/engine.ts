import { Action, Mission, Player, ROLES, Room, Snapshot } from "./types";
import { createHash, randomBytes } from "node:crypto";
import type { EmergencyKind, MissionEvent, MissionVariant, Role } from "./types";
const angle = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
export const phaseAt = (m: Mission, t: number) => {
  const e = (t - m.startAt) / 1000;
  return m.variant.stageStarts.findIndex((s) => e < s) === -1
    ? 4
    : m.variant.stageStarts.findIndex((s) => e < s);
};
const patterns: MissionVariant[] = [
  { name: "Sunstroke", order: ["storm-1", "coolant", "storm-2"], stageStarts: [12, 48, 86, 126], coolantAt: 48, intelRole: "Commander", emergencyKinds: ["solar-flare", "reactor-overheat", "debris-field"], severity: [2, 2, 2] },
  { name: "Cold Front", order: ["storm-1", "coolant", "storm-2"], stageStarts: [12, 48, 86, 126], coolantAt: 48, intelRole: "Engineer", emergencyKinds: ["solar-flare", "communications-failure", "sensor-disagreement"], severity: [2, 1, 2] },
  { name: "Double Flash", order: ["storm-1", "coolant", "storm-2"], stageStarts: [13, 49, 87, 127], coolantAt: 49, intelRole: "Pilot", emergencyKinds: ["solar-flare", "reactor-overheat", "sensor-disagreement"], severity: [3, 2, 1] },
  { name: "Black Ice", order: ["storm-1", "coolant", "storm-2"], stageStarts: [11, 47, 85, 125], coolantAt: 47, intelRole: "Commander", emergencyKinds: ["solar-flare", "communications-failure", "debris-field"], severity: [2, 2, 3] },
  { name: "Crosswind", order: ["storm-1", "coolant", "storm-2"], stageStarts: [14, 50, 88, 128], coolantAt: 50, intelRole: "Engineer", emergencyKinds: ["solar-flare", "reactor-overheat", "debris-field"], severity: [1, 3, 2] },
  { name: "Solar Echo", order: ["storm-1", "coolant", "storm-2"], stageStarts: [12, 49, 87, 127], coolantAt: 49, intelRole: "Pilot", emergencyKinds: ["solar-flare", "communications-failure", "sensor-disagreement"], severity: [3, 1, 3] },
];
export const missionPatterns = patterns;
export function ensureMissionVariant(room: Room) {
  const mission = room.mission as (Mission & { variant?: MissionVariant; seed?: string }) | null;
  if (!mission) return;
  const seed = createHash("sha256")
    .update(`legacy-solar-storm:${room.id}:${mission.startAt}`)
    .digest("hex")
    .slice(0, 32);
  mission.seed ??= seed;
  mission.variant ??= {
    name: "Solar Storm",
    order: ["storm-1", "coolant", "storm-2"],
    stageStarts: [12, 50, 90, 130],
    coolantAt: 80,
    intelRole: "Commander",
    emergencyKinds: ["solar-flare", "reactor-overheat", "debris-field"],
    severity: [2, 2, 2],
  };
  mission.variant.emergencyKinds ??= ["solar-flare", "reactor-overheat", "debris-field"];
  mission.variant.severity ??= [2, 2, 2];
  mission.secrets.answers ??= ["Port", "Cooling", "A"];
  mission.emergencyResults ??= [mission.completedAt?.[0] ? "recovered" : null, mission.repairedAt ? "recovered" : null, mission.completedAt?.[1] ? "recovered" : null];
  mission.currentEventIndex ??= -1;
  mission.commsOnline ??= true;
  mission.sensorsReliable ??= true;
  mission.propulsion ??= 100;
  mission.shieldIntegrity ??= 100;
  mission.lifeSupport ??= 100;
  mission.repairKits ??= 2;
  mission.repairsUsed ??= 0;
  mission.eventDecision ??= null;
  mission.eventCourse ??= null;
  mission.eventStabilized ??= false;
  mission.commsRestoredAt ??= null;
  mission.coolingApplied ??= Boolean(mission.repairedAt);
  mission.unreliableChosen ??= null;
  mission.systemPriorityApplied ??= null;
  mission.finaleReadyAt ??= null;
  mission.roleContributions ??= { Commander: 0, Pilot: 0, Engineer: 0 };
  mission.log ??= [];
  room.lastMissionSeed ??= mission.seed;
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
  variant.severity = [1 + Math.floor(random() * 3), 1 + Math.floor(random() * 3), 1 + Math.floor(random() * 3)];
  const headings = [Math.floor(random() * 360), Math.floor(random() * 360), Math.floor(random() * 360)];
  const flareSide = ["Port", "Starboard"][Math.floor(random() * 2)] as "Port" | "Starboard";
  const otherSide = (flareSide === "Port" ? "Starboard" : "Port") as "Port" | "Starboard";
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
    commsOnline: true,
    sensorsReliable: true,
    propulsion: 100,
    shieldIntegrity: 100,
    lifeSupport: 100,
    repairKits: 2,
    repairsUsed: 0,
    emergencyResults: [null, null, null],
    currentEventIndex: -1,
    eventDecision: null,
    eventCourse: null,
    eventStabilized: false,
    commsRestoredAt: null,
    coolingApplied: false,
    unreliableChosen: null,
    systemPriorityApplied: null,
    finaleReadyAt: null,
    roleContributions: { Commander: 0, Pilot: 0, Engineer: 0 },
    log: [],
    secrets: {
      headings,
      sectors: [flareSide, otherSide],
      symbols: { A: "○", B: "△", C: "□" },
      broken,
      code: String(Math.floor(random() * 9000) + 1000),
      answers: [
        ["Port", "Starboard"][Math.floor(random() * 2)],
        ["Cooling", "Shields", "Life support"][Math.floor(random() * 3)],
        ["A", "B", "C"][Math.floor(random() * 3)],
      ],
    },
  };
}
const eventForPhase = (m: Mission, phase: number): MissionEvent | null =>
  phase >= 1 && phase <= 3 ? m.variant.order[phase - 1] : null;
const waveForEvent = (event: MissionEvent | null) =>
  event === "storm-1" ? 0 : event === "storm-2" ? 1 : -1;
const kindForPhase = (m: Mission, phase: number): EmergencyKind | null =>
  phase >= 1 && phase <= 3 ? m.variant.emergencyKinds[phase - 1] : null;
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
function record(m: Mission, at: number, role: Role | "Ship", text: string) {
  m.log = [...m.log, { at, role, text }].slice(-24);
  if (role !== "Ship") m.roleContributions[role]++;
}
function eventSucceeded(m: Mission, index: number) {
  const kind = m.variant.emergencyKinds[index];
  if (kind === "solar-flare") return Boolean(m.completedAt[0]);
  if (kind === "reactor-overheat")
    return m.eventStabilized && m.eventDecision === m.secrets.answers[index] && m.systemPriorityApplied === m.secrets.answers[index];
  if (kind === "communications-failure")
    return Boolean(m.commsRestoredAt && m.eventStabilized && m.eventDecision === "restore-comms");
  if (kind === "debris-field")
    return m.eventDecision === "safe" && m.power === "Engines" && angle(m.heading, m.secrets.headings[2]) <= 5;
  return m.unreliableChosen === m.secrets.answers[index] && m.eventDecision === m.secrets.answers[index] && m.eventStabilized;
}
function activateEvent(m: Mission, phase: number) {
  const activeIndex = phase >= 1 && phase <= 3 ? phase - 1 : -1;
  if (m.currentEventIndex === activeIndex) return;
  m.currentEventIndex = activeIndex;
  m.eventDecision = null;
  m.eventCourse = null;
  m.eventStabilized = false;
  m.coolingApplied = false;
  m.commsRestoredAt = null;
  m.unreliableChosen = null;
  m.systemPriorityApplied = null;
  const kind = kindForPhase(m, phase);
  if (kind === "communications-failure") {
    m.commsOnline = false;
    record(m, m.startAt + m.variant.stageStarts[phase - 1] * 1000, "Ship", "Communications relay failed");
  }
  if (kind === "sensor-disagreement") {
    m.sensorsReliable = false;
    record(m, m.startAt + m.variant.stageStarts[phase - 1] * 1000, "Ship", "Navigation sensors disagree");
  }
}
function closeEmergency(m: Mission, index: number, at: number) {
  if (m.emergencyResults[index]) return;
  const kind = m.variant.emergencyKinds[index];
  if (eventSucceeded(m, index)) {
    m.emergencyResults[index] = "recovered";
    record(m, at, "Ship", `${kind.replaceAll("-", " ")} stabilized by the crew`);
    if (kind === "communications-failure") {
      m.commsOnline = true;
      m.sensorsReliable = true;
    }
    return;
  }
  m.emergencyResults[index] = "degraded";
  const severity = m.variant.severity[index];
  if (kind === "solar-flare") {
    m.hull = Math.max(0, m.hull - 4 * severity);
    m.shieldIntegrity = Math.max(15, m.shieldIntegrity - 25 * severity);
    m.power = "Balanced";
  } else if (kind === "reactor-overheat") {
    m.hull = Math.max(0, m.hull - 5 * severity);
    m.heat = Math.min(100, m.heat + 18 * severity);
    m.propulsion = Math.max(20, m.propulsion - 15 * severity);
  } else if (kind === "communications-failure") {
    m.commsOnline = false;
    m.sensorsReliable = false;
    m.hull = Math.max(0, m.hull - 4 * severity);
  } else if (kind === "debris-field") {
    m.hull = Math.max(0, m.hull - 7 * severity);
    m.propulsion = Math.max(15, m.propulsion - 25 * severity);
  } else {
    m.sensorsReliable = false;
    m.hull = Math.max(0, m.hull - 5 * severity);
  }
  record(m, at, "Ship", `${kind.replaceAll("-", " ")} left the ship degraded`);
  if (m.hull <= 0) {
    m.hull = 0;
    m.result = "defeat";
    m.endedAt = at;
    m.reason = `${kind.replaceAll("-", " ")} collapsed hull integrity`;
  }
}
export function advance(m: Mission, now: number) {
  if (m.result || now <= m.evaluatedAt) return;
  const end = Math.min(now, m.startAt + 150000);
  while (m.evaluatedAt < end && !m.result) {
    const t = m.evaluatedAt,
      p = phaseAt(m, t),
      wave = waveForEvent(eventForPhase(m, p));
    for (let index = 0; index < 3; index++) {
      const closeAt = m.startAt + m.variant.stageStarts[index + 1] * 1000;
      if (t >= closeAt && !m.emergencyResults[index]) closeEmergency(m, index, closeAt);
    }
    if (m.result) break;
    activateEvent(m, p);
    const currentKind = kindForPhase(m, p);
    if (currentKind === "communications-failure" && !m.commsRestoredAt) m.commsOnline = false;
    if (currentKind === "sensor-disagreement" && !m.sensorsReliable) m.sensorsReliable = false;
    const valid = wave >= 0 && protectedNow(m, wave, true);
    if (wave >= 0 && !m.completedAt[wave]) {
      if (valid && m.holdSince[wave] === null) m.holdSince[wave] = t;
      if (!valid) m.holdSince[wave] = null;
    }
    let next = Math.min(end, ...m.deadlines.filter((x) => x > t));
    const delta = ((m.target - m.heading + 540) % 360) - 180;
    const movementRate = Math.max(8, (m.power === "Shield" ? 42 : 60) * (m.propulsion / 100));
    // Split at movement/tolerance boundaries so a delayed sync produces exactly the same damage.
    if (Math.abs(delta) > 1e-7)
      next = Math.min(next, t + (Math.abs(delta) / movementRate) * 1000);
    if (wave >= 0 && Math.abs(delta) > 1e-7) {
      const direction = Math.sign(delta);
      for (const boundary of [
        m.secrets.headings[wave] - 5,
        m.secrets.headings[wave] + 5,
      ]) {
        const distance =
          (((direction * (boundary - m.heading)) % 360) + 360) % 360;
        if (distance > 1e-7 && distance <= Math.abs(delta) + 1e-7)
          next = Math.min(next, t + (distance / movementRate) * 1000);
      }
    }
    const hold = wave >= 0 ? m.holdSince[wave] : null;
    if (wave >= 0 && !m.completedAt[wave] && hold !== null)
      next = Math.min(next, hold + (wave === 0 ? 5000 : 8000));
    const kind = kindForPhase(m, p);
    const storm = wave >= 0 && kind === "solar-flare" && !m.completedAt[wave] && !valid ? 1 : 0;
    const coolant = kind === "reactor-overheat" && !m.coolingApplied ? Math.max(0.5, m.heat / 100) : 0;
    const rate = storm + coolant;
    if (rate > 0) next = Math.min(next, t + (m.hull / rate) * 1000);
    if (next <= t + 1e-8) {
      next = Math.min(end, t + 0.001);
    }
    const dt = (next - t) / 1000;
    m.hull = Math.max(0, m.hull - rate * dt);
    m.heading =
      (m.heading +
        Math.sign(delta) * Math.min(Math.abs(delta), movementRate * dt) +
        360) %
      360;
    if (kind === "reactor-overheat" && !m.coolingApplied) {
      const movingHard = Math.abs(delta) > 1e-7 && !m.eventStabilized;
      m.heat = Math.min(100, m.heat + (m.eventStabilized ? 0.25 : movingHard ? 1.8 : 0.9) * dt);
    }
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
  for (let index = 0; index < 3 && !m.result; index++) {
    const closeAt = m.startAt + m.variant.stageStarts[index + 1] * 1000;
    if (end >= closeAt && !m.emergencyResults[index]) closeEmergency(m, index, closeAt);
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
    const repeatsNoNewEmergency = (candidate: Mission) => Boolean(room.lastEmergencyKinds?.length && candidate.variant.emergencyKinds.filter((kind) => kind !== "solar-flare" && !room.lastEmergencyKinds!.includes(kind)).length < 2);
    while (seed === room.lastMissionSeed || mission.variant.name === room.lastVariantName || repeatsNoNewEmergency(mission)) {
      seed = randomBytes(16).toString("hex");
      mission = newMission(now, seed);
    }
    room.lastMissionSeed = seed;
    room.lastVariantName = mission.variant.name;
    room.lastEmergencyKinds = [...mission.variant.emergencyKinds];
    room.mission = mission;
  } else if (action.type === "retry") {
    if (uid !== room.hostId || !m?.result)
      throw new Error("Only the host can retry after a result");
    room.lastMissionSeed = m.seed;
    room.lastVariantName = m.variant.name;
    room.lastEmergencyKinds = [...m.variant.emergencyKinds];
    room.mission = null;
    room.players.forEach((p) => (p.ready = false));
  } else {
    if (!m || m.result) throw new Error("Mission is not active");
    const p = phaseAt(m, now);
    activateEvent(m, p);
    const kind = kindForPhase(m, p);
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
        record(m, now, "Pilot", `Course set to ${Math.round(action.value)} degrees`);
        break;
      case "power":
        requireRole(player, "Engineer");
        if (!["Balanced", "Shield", "Engines"].includes(String(action.value)))
          throw new Error("Invalid power preset");
        m.power = action.value as Mission["power"];
        if (m.power === "Engines") m.propulsion = Math.min(100, m.propulsion + 8);
        record(m, now, "Engineer", `Power routed to ${m.power}`);
        break;
      case "shield":
        requireRole(player, "Commander");
        if (!["Off", "Port", "Starboard"].includes(String(action.value)))
          throw new Error("Invalid shield sector");
        m.shield = action.value as Mission["shield"];
        record(m, now, "Commander", `Shield sector set to ${m.shield}`);
        break;
      case "decision":
        requireRole(player, "Commander");
        if (p < 1 || p > 3 || typeof action.value !== "string")
          throw new Error("No emergency decision is available");
        if (kind === "reactor-overheat" && !["Cooling", "Shields", "Life support"].includes(action.value))
          throw new Error("Choose a listed reactor priority");
        if (kind === "communications-failure" && !["restore-comms", "protect-shields"].includes(action.value))
          throw new Error("Choose whether to restore communications or protect shields");
        if (kind === "debris-field" && !["safe", "fast"].includes(action.value))
          throw new Error("Choose a safe or fast debris route");
        if (kind === "sensor-disagreement" && !["A", "B", "C"].includes(action.value))
          throw new Error("Choose which sensor signal to trust");
        if (kind === "solar-flare") throw new Error("Set the shield sector for the flare");
        m.eventDecision = action.value;
        record(m, now, "Commander", `Emergency priority: ${action.value}`);
        break;
      case "stabilize":
        requireRole(player, "Pilot");
        if (p < 1 || p > 3 || !["reactor-overheat", "communications-failure", "sensor-disagreement"].includes(String(kind)))
          throw new Error("Stabilization is unavailable during this emergency");
        m.eventStabilized = true;
        record(m, now, "Pilot", "Ship stabilized on the emergency vector");
        break;
      case "systems": {
        requireRole(player, "Engineer");
        if (p === 4 && action.value === "final-cool") {
          m.coolingApplied = true;
          m.heat = Math.max(25, m.heat - 30);
          record(m, now, "Engineer", "Finale reactor heat dumped");
          break;
        }
        if (p === 4 && typeof action.value === "string" && ["repair-comms", "repair-sensors", "repair-propulsion", "repair-shields"].includes(action.value)) {
          if (m.repairKits <= 0) throw new Error("No repair kits remain for the finale");
          if (m.power !== "Balanced") throw new Error("Route Balanced power before using a repair kit");
          if (action.value === "repair-comms") { m.commsOnline = true; record(m, now, "Engineer", "Communications repaired during the finale"); }
          if (action.value === "repair-sensors") { m.sensorsReliable = true; record(m, now, "Engineer", "Navigation sensors recalibrated during the finale"); }
          if (action.value === "repair-propulsion") { m.propulsion = Math.min(100, m.propulsion + 30); record(m, now, "Engineer", "Propulsion restored during the finale"); }
          if (action.value === "repair-shields") { m.shieldIntegrity = Math.min(100, m.shieldIntegrity + 30); record(m, now, "Engineer", "Shield integrity restored during the finale"); }
          m.repairKits--;
          m.repairsUsed++;
          break;
        }
        if (p < 1 || p > 3 || typeof action.value !== "string")
          throw new Error("No subsystem action is available");
        if (kind === "reactor-overheat" && ["Cooling", "Shields", "Life support"].includes(action.value)) {
          if (m.eventDecision !== action.value) throw new Error("Follow Command’s reactor priority call");
          if (action.value === "Cooling") {
            if (m.power !== "Balanced") throw new Error("Route Balanced power before cooling the reactor");
            m.coolingApplied = true;
            m.heat = Math.max(25, m.heat - 30);
            record(m, now, "Engineer", "Reactor cooling engaged");
          } else if (action.value === "Shields") {
            if (m.power !== "Shield") throw new Error("Route Shield power before reinforcing the shield reserve");
            m.shieldIntegrity = Math.min(100, m.shieldIntegrity + 20);
            record(m, now, "Engineer", "Shield reserve reinforced against reactor stress");
          } else {
            if (m.power !== "Balanced") throw new Error("Route Balanced power before supporting life support");
            m.lifeSupport = Math.min(100, m.lifeSupport + 20);
            record(m, now, "Engineer", "Life support protected through the reactor spike");
          }
          m.systemPriorityApplied = action.value;
        } else if (kind === "communications-failure" && action.value === "restore-comms") {
          if (m.power !== "Balanced") throw new Error("Route Balanced power before restoring communications");
          m.commsRestoredAt = now;
          m.commsOnline = true;
          m.sensorsReliable = true;
          m.shieldIntegrity = Math.max(15, m.shieldIntegrity - 10);
          record(m, now, "Engineer", "Communications restored; shield reserve diverted");
        } else if (kind === "sensor-disagreement" && /^[ABC]$/.test(action.value)) {
          m.unreliableChosen = action.value;
          m.sensorsReliable = action.value === m.secrets.answers[p - 1];
          record(m, now, "Engineer", `Diagnostic isolated signal ${action.value}`);
        } else {
          throw new Error("Subsystem action does not match the active emergency");
        }
        break;
      }
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
        record(m, now, "Pilot", "Escape code entered");
        break;
      case "authorize":
        requireRole(player, "Commander");
        if (p !== 4) throw new Error("Escape window not open");
        m.authorizedAt = now;
        record(m, now, "Commander", "Escape authorized");
        break;
      case "escape": {
        const degradedCount = m.emergencyResults.filter((result) => result === "degraded").length;
        const hullFloor = 15 + degradedCount * 4;
        const propulsionFloor = 12 + degradedCount * 3;
        requireRole(player, "Pilot");
        if (
          p !== 4 ||
          m.codeEntered !== m.secrets.code ||
          !m.authorizedAt ||
          m.power !== "Engines" ||
          angle(m.heading, m.secrets.headings[2]) > 5 ||
          m.emergencyResults.some((x) => x === null) ||
          m.hull < hullFloor ||
          m.propulsion < propulsionFloor ||
          m.shieldIntegrity < 10 ||
          (m.heat >= 95 && !m.coolingApplied)
        )
          throw new Error(
            "Escape needs recovered emergency records, hull and propulsion reserve, engine power, a safe heading, code, and Command authorization",
          );
        m.result = "victory";
        m.endedAt = now;
        m.finaleReadyAt = now;
        m.reason = "The crew survived the storm together";
        record(m, now, "Ship", "Storm cleared; ship systems stabilizing");
        break;
      }
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
          heat: m.heat,
          completedAt: m.completedAt,
          repairedAt: m.repairedAt,
          endedAt: m.endedAt,
          result: m.result,
          reason: m.reason,
          variant: m.variant,
          commsOnline: m.commsOnline,
          sensorsReliable: m.sensorsReliable,
          propulsion: m.propulsion,
          shieldIntegrity: m.shieldIntegrity,
          lifeSupport: m.lifeSupport,
          repairKits: m.repairKits,
          repairsUsed: m.repairsUsed,
          emergencyResults: m.emergencyResults,
          eventDecision: m.eventDecision,
          eventStabilized: m.eventStabilized,
          coolingApplied: m.coolingApplied,
          unreliableChosen: m.unreliableChosen,
          systemPriorityApplied: m.systemPriorityApplied,
          finaleReadyAt: m.finaleReadyAt,
          log: m.log,
          roleContributions: m.roleContributions,
        }
      : null,
    station: !m
      ? {}
      : role === "Commander"
        ? {
            emergencyKind: kindForPhase(m, phaseAt(m, m.endedAt ?? now)) ?? undefined,
            ...(m.commsOnline ? { headings: m.secrets.headings, sectors: m.secrets.sectors, code: m.secrets.code } : { ...(phaseAt(m, m.endedAt ?? now) === 4 ? { code: m.secrets.code } : {}) }),
            shield: m.shield,
            impactDirection: kindForPhase(m, phaseAt(m, m.endedAt ?? now)) === "solar-flare" ? m.secrets.sectors[0] : undefined,
            threatSeverity: m.variant.severity[Math.max(0, Math.min(2, phaseAt(m, m.endedAt ?? now) - 1))],
            procedure: kindForPhase(m, phaseAt(m, m.endedAt ?? now)) === "reactor-overheat" ? m.secrets.answers[1] : undefined,
            routeIntel: kindForPhase(m, phaseAt(m, m.endedAt ?? now)) === "debris-field" ? `Safe corridor ${m.secrets.headings[2]}°; fast route risks the outer hull.` : undefined,
            sensorForecast: kindForPhase(m, phaseAt(m, m.endedAt ?? now)) === "sensor-disagreement" ? `Star map predicts ${m.secrets.headings[2]}°. Compare with Pilot’s gyro before deciding.` : undefined,
            decision: m.eventDecision,
            ...(m.variant.intelRole === "Commander" ? { brokenSymbol: m.secrets.symbols[m.secrets.broken] } : {}),
          }
        : role === "Pilot"
          ? {
              emergencyKind: kindForPhase(m, phaseAt(m, m.endedAt ?? now)) ?? undefined,
              heading: m.heading,
              target: m.target,
              engineReady: m.power === "Engines",
              codeEntered: m.codeEntered,
              authorized: Boolean(m.authorizedAt),
              navigationTrace: kindForPhase(m, phaseAt(m, m.endedAt ?? now)) === "debris-field" ? `Debris return peaks near ${m.secrets.headings[2]}°.` : kindForPhase(m, phaseAt(m, m.endedAt ?? now)) === "sensor-disagreement" ? `Inertial gyro holds ${Math.round(m.heading)}°; radar return conflicts with the star map.` : undefined,
              externalThreat: kindForPhase(m, phaseAt(m, m.endedAt ?? now)) === "communications-failure" && !m.commsOnline ? `Solar activity on the ${m.secrets.sectors[0]} side · severity ${m.variant.severity[1]}.` : undefined,
              commsOnline: m.commsOnline,
            ...(m.variant.intelRole === "Pilot" ? { brokenSymbol: m.secrets.symbols[m.secrets.broken] } : {}),
            }
          : {
              emergencyKind: kindForPhase(m, phaseAt(m, m.endedAt ?? now)) ?? undefined,
              power: m.power,
              heat: m.heat,
              isolated: m.isolated,
              vented: m.vented,
              symbols: m.secrets.symbols,
              reactorReading: kindForPhase(m, phaseAt(m, m.endedAt ?? now)) === "reactor-overheat" ? m.heat : undefined,
              sensorDiagnostic: kindForPhase(m, phaseAt(m, m.endedAt ?? now)) === "sensor-disagreement" ? `Diagnostic noise follows sensor ${m.secrets.answers[2]}.` : undefined,
              commsOnline: m.commsOnline,
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
