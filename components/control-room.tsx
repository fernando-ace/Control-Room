"use client";
import Link from "next/link";
import { Meter, Ship } from "./instruments";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Compass,
  Copy,
  Radio,
  Rocket,
  Shield,
  Users,
  Volume2,
  VolumeX,
  Wrench,
  UserMinus,
} from "lucide-react";
import { browserClient, ensureAnonymousSession } from "@/lib/browser";
import { parseRoomInviteUrl } from "@/lib/invites";
import { Action, EmergencyKind, Role, Snapshot } from "@/lib/types";
import InviteActions from "./invite-actions";
const briefings: Record<Role, string> = {
  Commander:
    "Read threat and route intelligence aloud. Make the crew’s priority calls and authorize the final escape.",
  Pilot:
    "Read the outside threat, steer the ship, and stabilize it when another station is repairing a critical system. Align and launch at the end.",
  Engineer:
    "Watch reactor and subsystem health. Trade shield, cooling, and propulsion power to keep the ship operating.",
};
const jobs: Record<Role, string> = {
  Commander: "Share threat intelligence, choose priorities, and authorize the finale.",
  Pilot: "Navigate hazards and stabilize the ship when systems are under stress.",
  Engineer: "Route power, manage heat, restore subsystems, and protect the hull.",
};
const emergencyTitles: Record<EmergencyKind, string> = {
  "solar-flare": "Solar flare impact",
  "reactor-overheat": "Reactor overheat",
  "communications-failure": "Communications failure",
  "debris-field": "Debris field",
  "sensor-disagreement": "Sensor disagreement",
};
function friendlyError(message: string) {
  const lower = message.toLowerCase();
  if (lower === "you left the room.") return message;
  if (lower.includes("room not found"))
    return "We couldn’t find that room. Check the code with your host and try again.";
  if (lower.includes("room is full") || lower.includes("room full"))
    return "That room already has three players.";
  if (
    lower.includes("removed you") ||
    lower.includes("no longer have access") ||
    lower.includes("no longer a member")
  )
    return "You were removed from this room and can’t rejoin it.";
  if (lower.includes("enter your name")) return "Enter your name to continue.";
  if (lower.includes("six-character") || lower.includes("six character"))
    return "Enter the full six-character room code.";
  if (lower.includes("session expired") || lower.includes("no session"))
    return "Your connection expired. Refresh the page to reconnect.";
  if (lower.includes("only the host"))
    return "Only the host can make that change.";
  if (lower.includes("three connected, ready players"))
    return "All three players must be connected and ready before launch.";
  if (lower.includes("network") || lower.includes("fetch") || lower.includes("connection"))
    return "We couldn’t reach the room. Check your internet and try again.";
  if (lower.includes("server configuration") || lower.includes("supabase"))
    return "Mission control is temporarily unavailable. Please try again shortly.";
  return "That didn’t work. Please try again.";
}
export default function ControlRoom() {
  const [room, setRoom] = useState<Snapshot | null>(null),
    [name, setName] = useState(""),
    [code, setCode] = useState(""),
    [invitePrefilled, setInvitePrefilled] = useState(false),
    [error, setError] = useState(""),
    [roomCodeCopied, setRoomCodeCopied] = useState(false),
    [busy, setBusy] = useState(false),
    [pendingOperation, setPendingOperation] = useState<"create" | "join" | null>(null),
    [identity, setIdentity] = useState(false),
    [network, setNetwork] = useState("Connecting"),
    [muted, setMuted] = useState(true),
    [clock, setClock] = useState(0),
    [heading, setHeading] = useState("180"),
    [escapeCode, setEscapeCode] = useState(""),
    [actionFeedback, setActionFeedback] = useState("");
  const roomRef = useRef<Snapshot | null>(null),
    offset = useRef(0),
    audio = useRef<AudioContext | null>(null),
    phaseRef = useRef(-1);
  const clearMembership = useCallback((message: string) => {
    roomRef.current = null;
    setRoom(null);
    localStorage.removeItem("cr-room");
    setNetwork("Connected");
    setError(friendlyError(message));
  }, []);
  const accept = useCallback((s: Snapshot) => {
    if (
      roomRef.current &&
      roomRef.current.id === s.id &&
      (roomRef.current.revision > s.revision ||
        (roomRef.current.revision === s.revision &&
          roomRef.current.serverNow > s.serverNow))
    )
      return;
    if (s.mission?.startAt && roomRef.current?.mission?.startAt !== s.mission.startAt) {
      setHeading("180");
      setEscapeCode("");
    }
    roomRef.current = s;
    offset.current = s.serverNow - Date.now();
    setRoom(s);
    localStorage.setItem("cr-room", s.code);
  }, []);
  const call = useCallback(
    async (
      op: string,
      roomCode?: string,
      action?: Action,
      playerName?: string,
      targetId?: string,
    ) => {
      const db = browserClient();
      const { data } = await db.auth.getSession();
      if (!data.session) throw new Error("No session. Refresh to reconnect.");
      const actionId = crypto.randomUUID();
      let response: Response;
      for (let attempt = 0; ; attempt++) {
        response = await fetch("/api/room", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${data.session.access_token}`,
          },
          body: JSON.stringify({ op, code: roomCode, name: playerName, action, targetId, actionId }),
        });
        if (response.status !== 409 || attempt >= 4) break;
        await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
      }
      const result = await response.json();
      if (response.status === 410) {
        clearMembership(result.error ?? "You no longer have access to this room.");
        throw new Error(result.error ?? "You no longer have access to this room.");
      }
      if (!response.ok) throw new Error(result.error ?? "Connection failed");
      if (result.left) {
        clearMembership("You left the room.");
        return null;
      }
      accept(result as Snapshot);
      return result as Snapshot;
    },
    [accept, clearMembership],
  );
  useEffect(() => {
    let alive = true;
    const invite = parseRoomInviteUrl(window.location.href);
    window.setTimeout(() => {
      if (!alive) return;
      if (invite.status === "valid") {
        setCode(invite.code);
        setInvitePrefilled(true);
      } else if (invite.status === "invalid") {
        setError(
          "This invite link is invalid. Ask your host for a fresh link or enter the six-character room code.",
        );
      }
    }, 0);
    (async () => {
      try {
        const db = browserClient();
        await ensureAnonymousSession(db);
        if (!alive) return;
        setIdentity(true);
        const saved = localStorage.getItem("cr-room");
        const shouldResumeSavedRoom =
          invite.status === "none" ||
          (invite.status === "valid" && saved === invite.code);
        if (saved && shouldResumeSavedRoom) {
          try {
            await call("action", saved, { type: "sync" });
          } catch {
            localStorage.removeItem("cr-room");
          }
        }
      } catch (e) {
        if (alive && invite.status !== "invalid")
          setError(
            e instanceof Error
              ? friendlyError(e.message)
              : "We couldn’t connect. Check your internet and try again.",
          );
      }
    })();
    return () => {
      alive = false;
    };
  }, [call]);
  useEffect(() => {
    const t = setInterval(() => setClock(Date.now() + offset.current), 200);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!room?.id) return;
    const db = browserClient();
    let alive = true;
    let syncInFlight = false;
    const sync = async (write: boolean) => {
      if (syncInFlight) return;
      syncInFlight = true;
      try {
        await call("action", roomRef.current!.code, {
          type: "sync",
          value: write,
        });
        if (alive) setNetwork("Connected");
      } catch (e) {
        if (alive && roomRef.current?.id === room.id) {
          setNetwork("Reconnecting");
          setError(
            e instanceof Error
              ? friendlyError(e.message)
              : "Connection interrupted. Reconnecting to your crew…",
          );
        }
      } finally {
        syncInFlight = false;
      }
    };
    const channel = db
      .channel(`room-${room.id}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "cr_rooms",
          filter: `id=eq.${room.id}`,
        },
        () => {
          void sync(false);
        },
      )
      .subscribe((status) => {
        if (alive)
          setNetwork(status === "SUBSCRIBED" ? "Connected" : "Reconnecting");
      });
    const interval = setInterval(() => void sync(true), 3000);
    const visibility = () => {
      if (document.visibilityState === "visible") void sync(true);
    };
    window.addEventListener("online", visibility);
    document.addEventListener("visibilitychange", visibility);
    void sync(false);
    return () => {
      alive = false;
      clearInterval(interval);
      void db.removeChannel(channel);
      window.removeEventListener("online", visibility);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [room?.id, call]);
  const m = room?.mission,
    me = room?.players.find((p) => p.id === room.me),
    role = me?.role,
    host = room?.hostId === room?.me;
  useEffect(() => {
    const p = m?.phase ?? -1;
    if (p === phaseRef.current) return;
    phaseRef.current = p;
    if (muted || !audio.current || p < 1) return;
    const ctx = audio.current;
    const osc = ctx.createOscillator(),
      gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = m?.result === "victory" ? 660 : 330;
    gain.gain.setValueAtTime(0.06, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    osc.start();
    osc.stop(ctx.currentTime + 0.3);
  }, [m?.phase, m?.result, muted]);
  const run = async (action: Action) => {
    if (!room) return;
    setBusy(true);
    setError("");
    try {
      const beforeHull = room.mission?.hull;
      const updated = await call("action", room.code, action);
      if (!updated) throw new Error("Room ended while sending the action.");
      if (action.type === "retry") {
        setHeading("180");
        setEscapeCode("");
      }
      if (beforeHull !== undefined && updated.mission && updated.mission.hull < beforeHull) {
        setActionFeedback(`Hull −${Math.round(beforeHull - updated.mission.hull)}% · the team took damage. Recheck the called heading, shield, and power.`);
      } else {
        const feedback: Record<string, string> = {
          ready: action.value ? "Station ready · waiting for the crew." : "Station unready · review your briefing before launch.",
          start: "Mission launched · first storm in 12 seconds. Check your objective and call out what you need.",
          retry: "Back in the lobby · confirm your station before the next launch.",
          swap: "Station assignment updated · review your role briefing.",
          shield: "Shield sector set · Engineer, route power to shields. Pilot, align to the called heading.",
          power: action.value === "Engines" ? "Engine power routed · Pilot, the engines are ready for departure." : "Power routed · crew, confirm your station is aligned for the current task.",
          heading: "Heading command set · alignment takes time. Tell the crew when you are aligned.",
          isolate: "Circuit isolated · vent coolant next.",
          vent: "Coolant vented · reset the circuit to finish the repair.",
          reset: "Circuit reset · coolant repair complete.",
          authorize: "Departure authorized · Pilot, enter the code and initiate escape.",
          code: "Code submitted · Pilot, initiate escape when all prerequisites are ready.",
          escape: "Escape initiated · bring the crew home!",
        };
        setActionFeedback(feedback[action.type] ?? "Action sent to mission control.");
      }
      window.setTimeout(() => setActionFeedback(""), 5000);
    } catch (e) {
      setError(e instanceof Error ? friendlyError(e.message) : "That didn’t work. Please try again.");
    } finally {
      setBusy(false);
    }
  };
  const leaveRoom = async () => {
    if (!room || busy) return;
    setBusy(true);
    setError("");
    try {
      await call("leave", room.code);
    } catch (e) {
      setError(e instanceof Error ? friendlyError(e.message) : "We couldn’t leave the room. Please try again.");
    } finally {
      setBusy(false);
    }
  };
  const kickPlayer = async (playerId: string, playerName: string) => {
    if (!room || busy || !host) return;
    if (!window.confirm(`Remove ${playerName} from this room?`)) return;
    setBusy(true);
    setError("");
    try {
      await call("kick", room.code, undefined, undefined, playerId);
    } catch (e) {
      setError(e instanceof Error ? friendlyError(e.message) : "We couldn’t remove that player. Please try again.");
    } finally {
      setBusy(false);
    }
  };
  const enter = async (op: string) => {
    setBusy(true);
    setPendingOperation(op === "create" || op === "join" ? op : null);
    setError("");
    try {
      await call(op, code.toUpperCase(), undefined, name);
    } catch (e) {
      setError(
        e instanceof Error
          ? friendlyError(e.message)
          : "We couldn’t connect. Check your internet and try again.",
      );
    } finally {
      setBusy(false);
      setPendingOperation(null);
    }
  };
  const toggleSound = () => {
    if (muted) {
      audio.current ??= new AudioContext();
      void audio.current.resume();
    }
    setMuted(!muted);
  };
  const seconds = m
    ? Math.max(0, Math.ceil((m.startAt + 150000 - (m.endedAt ?? clock)) / 1000))
    : 150;
  const time = `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
  const connected =
    room?.players.filter((p) => clock - p.seenAt < 15000).length ?? 0;
  const st = room?.station ?? {};
  const activeEvent = m && m.phase >= 1 && m.phase <= 3 ? m.variant.order[m.phase - 1] : null;
  const activeKind = m && m.phase >= 1 && m.phase <= 3 ? m.variant.emergencyKinds[m.phase - 1] : null;
  const activeWave = activeEvent === "storm-1" ? 0 : activeEvent === "storm-2" ? 1 : -1;
  const orderedStorms = m ? m.variant.order.filter((event) => event !== "coolant") as ("storm-1" | "storm-2")[] : [];
  const waveIndex = (event: "storm-1" | "storm-2") => event === "storm-1" ? 0 : 1;
  const stormOrdinal = (event: "storm-1" | "storm-2") => orderedStorms.indexOf(event) + 1;
  const nextStormEvent = m?.variant.order.find((event, index) => index + 1 >= (m?.phase ?? 4) && event.startsWith("storm")) as "storm-1" | "storm-2" | undefined;
  const guidanceWave = activeWave >= 0 ? activeWave : nextStormEvent ? waveIndex(nextStormEvent) : 2;
  const escapePrep = Boolean(m && (m.phase === 4 || (activeEvent === "coolant" && !nextStormEvent)));
  const missionObjectives = m ? m.variant.emergencyKinds.map((kind, index) => ({
    text: emergencyTitles[kind],
    done: m.emergencyResults[index] === "recovered",
    failed: m.emergencyResults[index] === "failed",
    warning: m.emergencyResults[index] === "degraded",
    active: m.phase === index + 1,
  })).concat([{
    text: "Storm finale",
    done: m.result === "victory",
    failed: m.result === "defeat",
    warning: false,
    active: m.phase === 4 && !m.result,
  }]) : [];
  const escapeBlockers = m?.phase === 4
      ? [...missionObjectives.filter((objective) => !objective.done && !objective.warning && objective.text !== "Storm finale").map((objective) => objective.text.toLowerCase()), ...(m.hull < 15 + m.emergencyResults.filter((result) => result === "degraded").length * 4 ? ["hull reserve"] : []), ...(m.propulsion < 12 + m.emergencyResults.filter((result) => result === "degraded").length * 3 ? ["propulsion reserve"] : []), ...(m.heat >= 95 && !m.coolingApplied ? ["reactor temperature"] : [])]
    : [];
  const missionTitle = m?.phase === 4 ? "Catastrophic storm finale" : activeKind ? emergencyTitles[activeKind] : "Approach";
  const missionPrompt = !role ? "" : m?.phase === 4
    ? role === "Commander" ? "Review the damage, share the escape heading and code, then authorize. The crew’s earlier decisions set the ship’s survival margin." : role === "Pilot" ? "Ask Commander for the escape heading and code. Align, enter the code, and initiate escape." : "Route power to Engines. If the reactor is critical, cool it before the final maneuver."
    : activeKind === "solar-flare"
      ? role === "Commander" ? `Impact from ${st.impactDirection ?? "unknown"} · severity ${st.threatSeverity ?? "?"}. Call the safe heading and sector, then set the shield.` : role === "Pilot" ? "Ask Commander for the impact heading. Turn the ship into the safe orientation and report when steady." : "Route power to Shield. This protects the hull but slows your steering response."
      : activeKind === "reactor-overheat"
        ? role === "Commander" ? `Procedure priority: ${st.procedure ?? "compare cooling, shields, and life support"}. Choose a priority and tell Engineer.` : role === "Pilot" ? "Hold a steady vector while Engineer protects the called subsystem." : `Reactor at ${Math.round(st.reactorReading ?? st.heat ?? 0)}%. Follow Command’s priority and route its matching power.`
        : activeKind === "communications-failure"
          ? role === "Commander" ? "Comms are down and your navigation feed is limited. Decide whether to restore comms or preserve shield reserve; ask Pilot for outside threat reports." : role === "Pilot" ? "You have the clearest outside view. Call out the threat and stabilize the relay antenna." : "Restore communications with Balanced power. This diverts reserve from shields."
          : activeKind === "debris-field"
            ? role === "Commander" ? `${st.routeIntel ?? "Route intelligence is loading."} Choose the safe or fast corridor and brief Pilot.` : role === "Pilot" ? `${st.navigationTrace ?? "Read the return and ask Commander for route guidance."} Align to the called corridor.` : "Route Engines for a fast crossing; shields are weaker until you restore defensive power."
            : activeKind === "sensor-disagreement"
              ? role === "Commander" ? "Your forecast conflicts with the navigation and engineering readings. Compare reports, choose which signal to trust, and call it out." : role === "Pilot" ? `${st.navigationTrace ?? "Compare the nav echo with Command’s forecast."} Stabilize the ship while the crew compares readings.` : `${st.sensorDiagnostic ?? "Compare the diagnostic with Command’s forecast."} Call out your evidence and isolate the unreliable signal.`
              : "Check the mission objective and coordinate with the crew.";
  const decisionOptions: { value: string; label: string }[] = activeKind === "reactor-overheat"
    ? ["Cooling", "Shields", "Life support"].map((value) => ({ value, label: value }))
    : activeKind === "communications-failure"
      ? [{ value: "restore-comms", label: "Restore communications" }, { value: "protect-shields", label: "Protect shield reserve" }]
      : activeKind === "debris-field"
        ? [{ value: "safe", label: "Safe route" }, { value: "fast", label: "Fast route" }]
        : activeKind === "sensor-disagreement"
          ? ["A", "B", "C"].map((value) => ({ value, label: `Trust signal ${value}` }))
          : [];
  return (
    <main className="shell">
      <header>
        <Link className="brand" href="/">
          CONTROL ROOM
        </Link>
        <span className="subtitle">COOPERATIVE SPACECRAFT STATION</span>
        <div className="header-right">
          <span className={`storm ${m?.result === "victory" ? "storm-cleared" : m?.result === "defeat" ? "storm-lost" : ""}`}>
            {m?.result === "victory" ? <Check size={16} /> : <AlertTriangle size={16} />} {m?.result === "victory" ? "STORM CLEARED" : m?.result === "defeat" ? "SIGNAL LOST" : "SOLAR STORM"}
          </span>
          {room && (
            <div className="room-code">
              ROOM <b>{room.code}</b>
              <button
                className="icon-button"
                aria-label={roomCodeCopied ? "Room code copied" : "Copy room code"}
                title={roomCodeCopied ? "Room code copied" : "Copy room code"}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(room.code);
                    setRoomCodeCopied(true);
                    window.setTimeout(() => setRoomCodeCopied(false), 1800);
                  } catch {
                    setError("Copy the room code shown above.");
                  }
                }}
              >
                {roomCodeCopied ? <Check size={15} /> : <Copy size={15} />}
              </button>
              {roomCodeCopied && <span className="copy-feedback" role="status">Copied!</span>}
            </div>
          )}
          <button
            className="icon-button sound"
            aria-label={muted ? "Enable sound" : "Mute sound"}
            onClick={toggleSound}
          >
            {muted ? <VolumeX size={20} /> : <Volume2 size={20} />}
          </button>
        </div>
      </header>
      {error && (
        <div className="error" role="alert">
          {error}
          <button aria-label="Dismiss error" onClick={() => setError("")}>
            ×
          </button>
        </div>
      )}
      {!room ? (
        <section className="entry">
          <div className="entry-story">
            <div className="orbit">
              <Ship />
            </div>
            <h1>
              Three stations.
              <br />
              <span>One chance to survive.</span>
            </h1>
            <p>
              Three players take the Commander, Pilot, and Engineer stations.
              Share what you know, coordinate every move, and bring your ship
              home.
            </p>
            <div className="entry-facts">
              <span>
                <Users size={18} /> Exactly 3 players
              </span>
              <span>
                <Radio size={18} /> Speak to your crew
              </span>
              <span>02:30 mission</span>
            </div>
          </div>
          <form
            className="panel entry-form"
            onSubmit={(e) => {
              e.preventDefault();
              void enter("join");
            }}
          >
            <h2>Start your crew</h2>
            <p>Create a room, then invite two players with your room code.</p>
            <label htmlFor="name">YOUR NAME</label>
            <input
              id="name"
              maxLength={24}
              placeholder="Enter your name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="nickname"
            />
            <button
              type="button"
              className="primary"
              disabled={!identity || busy || !name.trim()}
              onClick={() => void enter("create")}
            >
              {pendingOperation === "create" ? "Creating room…" : "Create room"}
              {pendingOperation === "create" ? null : <Rocket size={18} />}
            </button>
            <div className="divider">OR JOIN YOUR CREW</div>
            <label htmlFor="code">ROOM CODE</label>
            <input
              id="code"
              maxLength={6}
              placeholder="Q7KM2A"
              className="code-input"
              aria-describedby="room-code-help"
              autoCapitalize="characters"
              autoComplete="off"
              value={code}
              onChange={(e) =>
                setCode(e.target.value.toUpperCase().replace(/[^A-Z2-9]/g, ""))
              }
            />
            {invitePrefilled && (
              <small className="invite-prefill" role="status">
                Invite link ready. Enter your name, then choose Join room.
              </small>
            )}
            <button
              type="submit"
              disabled={!identity || busy || !name.trim() || code.length !== 6}
            >
              {pendingOperation === "join" ? "Joining room…" : "Join room"}
            </button>
            <small id="room-code-help" aria-live="polite">
              {identity
                ? "No account needed. Your name and a six-character code are all you need."
                : "Connecting… Your crew controls will be ready in a moment."}
            </small>
          </form>
        </section>
      ) : (
        <>
          <div className="telemetry">
            <div>
              <span>MISSION COUNTDOWN</span>
              <strong className="timer">{m ? time : "02:30"}</strong>
            </div>
            <div className="hull">
              <Meter label="HULL INTEGRITY" value={m?.hull ?? 100} />
            </div>
            <div>
              <span>CREW CONNECTED</span>
              <strong>
                <Users size={23} /> {connected} / 3
              </strong>
              <small className={network === "Connected" ? "online" : "amber"}>
                {network}
              </small>
            </div>
          </div>
          {!m ? (
            <section className="lobby">
              <div className="panel">
                <div className="panel-heading">
                  <h2>Flight crew</h2>
                  <span className="lobby-code">ROOM CODE · {room.code}</span>
                </div>
                <p>
                  Invite two players to join. All three stations must be ready
                  before launch.
                </p>
                <InviteActions code={room.code} />
                <div className="lobby-players">
                  {(["Commander", "Pilot", "Engineer"] as Role[]).map((r) => {
                    const p = room.players.find((p) => p.role === r);
                    return (
                      <div
                        className={
                          "seat role-" + r.toLowerCase() +
                          (p?.id === room.me ? " mine" : "")
                        }
                        data-role={r.toLowerCase()}
                        key={r}
                      >
                        <span className="station-icon">
                          {r === "Commander" ? (
                            <Shield />
                          ) : r === "Pilot" ? (
                            <Compass />
                          ) : (
                            <Wrench />
                          )}
                        </span>
                        <div>
                          <label>
                            {r}
                            {p?.id === room.hostId && (
                              <span className="host-badge">HOST</span>
                            )}
                            {p?.id === room.me && (
                              <span className="you-badge">YOU</span>
                            )}
                          </label>
                          <h3>{p?.name ?? "Waiting for crew…"}</h3>
                          <span className="seat-status">
                            {p
                              ? clock - p.seenAt >= 15000
                                ? "Reconnecting"
                                : p.ready
                                  ? "Ready for launch"
                                  : "Not ready"
                              : "Open station"}
                          </span>
                        </div>
                        {p?.ready && <Check className="online" />}
                        {host && p && p.id !== room.me && (
                          <button
                            className="small"
                            disabled={busy}
                            aria-label={`Swap role with ${p.name}, the ${r}`}
                            onClick={() =>
                              void run({ type: "swap", value: p.id })
                            }
                          >
                            Swap role
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
                <button
                  className={me?.ready ? "selected" : "primary"}
                  disabled={busy}
                  onClick={() => void run({ type: "ready", value: !me?.ready })}
                  aria-pressed={Boolean(me?.ready)}
                >
                  {busy
                    ? "Updating station…"
                    : me?.ready
                      ? "Ready · Click to unready"
                      : "Mark station ready"}
                </button>
                <p className="lobby-waiting" aria-live="polite">
                  {room.players.length < 3
                    ? `Invite ${3 - room.players.length} more ${3 - room.players.length === 1 ? "player" : "players"} to fill the crew.`
                    : room.players.some((p) => !p.ready)
                      ? `Waiting for ${room.players
                          .filter((p) => !p.ready)
                          .map((p) => (p.id === room.me ? "you" : p.name))
                          .join(", ")} to get ready.`
                      : connected < 3
                        ? "All stations are ready. Waiting for the full crew to reconnect."
                        : "All three stations are ready. The host can launch when the crew is set."}
                </p>
                {host ? (
                  <button
                    disabled={
                      busy ||
                      room.players.length !== 3 ||
                      room.players.some((p) => !p.ready) ||
                      connected !== 3
                    }
                    onClick={() => void run({ type: "start" })}
                  >
                    {busy ? "Preparing launch…" : "Launch Solar Storm"}
                  </button>
                ) : (
                  <p className="waiting">
                    The host will launch when all three stations are ready and connected.
                  </p>
                )}
              </div>
              <div className={`panel briefing role-${role?.toLowerCase() ?? ""}`}>
                <label>YOUR STATION</label>
                <h1>{role}</h1>
                <p className="universal-brief">Everyone has different information and controls. Talk constantly: call out what you see, what you are doing, and when you are ready.</p>
                <h2>Your Job</h2>
                <p>{role && jobs[role]}</p>
                <p>{role && briefings[role]}</p>
                <h2>Mission briefing</h2>
                <ol>
                  <li>Share the information unique to your station.</li>
                  <li>Coordinate three emergencies; recover degraded systems when you can.</li>
                  <li>Trade power between shields, cooling, and propulsion.</li>
                  <li>Work together through the final storm window.</li>
                </ol>
                <p className="hint">
                  Your screen cannot tell you everything. Ask your crew.
                </p>
              </div>
            </section>
          ) : m.result ? (
            <section className={"result panel " + m.result}>
              <div className="result-icon">
                {m.result === "victory" ? (
                  <Rocket size={48} />
                ) : (
                  <AlertTriangle size={48} />
                )}
              </div>
              <label>
                MISSION {m.result === "victory" ? "COMPLETE" : "FAILED"}
              </label>
              <h1>
                {m.result === "victory"
                  ? "You brought them home together."
                  : "The ship was lost to the storm."}
              </h1>
              <p>{m.reason}</p>
              <p className="mission-grade"><b>MISSION GRADE · {m.emergencyResults.filter((result) => result === "recovered").length === 3 && m.hull >= 80 ? "A" : m.emergencyResults.filter((result) => result === "recovered").length >= 2 && m.hull >= 55 ? "B" : m.hull >= 30 ? "C" : "D"}</b> · {m.result === "victory" ? "The alarms fall quiet as ship systems stabilize." : "Final failure: " + (m.reason ?? "unknown cause")}</p>
              <div className="result-metrics">
                <span>
                  <b>{Math.round(m.hull)}%</b>Hull remaining
                </span>
                <span>
                  <b>{m.emergencyResults.filter((result) => result === "recovered").length}/3</b>Emergencies recovered
                </span>
                <span>
                  <b>{Math.round(m.shieldIntegrity)}%</b>Shield integrity
                </span>
                <span>
                  <b>{m.emergencyResults.filter((result) => result === "degraded").length}</b>Systems left degraded
                </span>
              </div>
              <div className="crew-report"><h2>Flight recorder</h2><p>Commander {m.roleContributions.Commander} · Pilot {m.roleContributions.Pilot} · Engineer {m.roleContributions.Engineer} actions logged</p><ol>{m.log.slice(-6).map((entry, index) => <li key={`${entry.at}-${index}`}><b>+{Math.max(0, Math.round((entry.at - m.startAt) / 1000))}s · {entry.role}</b> · {entry.text}</li>)}</ol></div>
              {host ? (
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => void run({ type: "retry" })}
                >
                  Return to lobby · Try again
                </button>
              ) : (
                <p>Waiting for the host to return the crew to the lobby.</p>
              )}
            </section>
          ) : (
            <>
            <section className={`mission-brief panel ${!m.commsOnline ? "comms-degraded" : !m.sensorsReliable ? "sensor-degraded" : ""}`} aria-live="polite">
              <div className="mission-brief-main">
                <label>YOUR JOB · {role} <small>MISSION {m.variant.name.toUpperCase()}</small></label>
                <h1>{missionTitle}</h1>
                <p>{missionPrompt}</p>
                {m.hull <= 40 && <p className="hull-warning">WARNING · Hull at {Math.round(m.hull)}%. Correct the active storm setup now.</p>}
                {actionFeedback && <p className="action-feedback" role="status">{actionFeedback}</p>}
              </div>
              <div className="objective-list" aria-label="Mission objectives">
                {missionObjectives.map((o) => <span key={o.text} className={o.done ? "objective-done" : o.failed ? "objective-failed" : o.warning ? "objective-warning" : o.active ? "objective-active" : "objective-waiting"}><b>{o.done ? "✓" : o.failed ? "×" : o.warning ? "!" : o.active ? "●" : "○"}</b>{o.text}<small>{o.done ? "COMPLETED" : o.failed ? "FAILED" : o.warning ? "WARNING" : o.active ? "ACTIVE" : "WAITING"}</small></span>)}
              </div>
              <div className="dependencies">
                <b>{m.phase === 4 ? "CREW FINALE" : activeKind ? emergencyTitles[activeKind].toUpperCase() : "NEXT EMERGENCY"}</b>
                {m.phase === 4 ? <><span><i className={role === "Engineer" && st.power === "Engines" ? "dep-ready" : ""} /> Engineer · route escape propulsion</span><span><i className={role === "Commander" && st.authorized ? "dep-ready" : ""} /> Commander · share course and authorize</span><span><i className={role === "Pilot" && st.codeEntered ? "dep-ready" : ""} /> Pilot · align, enter code, and launch</span></> : activeKind === "solar-flare" ? <><span><i /> Commander · call impact direction and shield sector</span><span><i className={role === "Pilot" && Math.abs((st.heading ?? 0) - (st.target ?? 0)) <= 5 ? "dep-ready" : ""} /> Pilot · orient the ship</span><span><i className={role === "Engineer" && st.power === "Shield" ? "dep-ready" : ""} /> Engineer · divert power to shields</span></> : activeKind === "reactor-overheat" ? <><span><i /> Commander · set the reactor priority</span><span><i className={role === "Pilot" && m.eventStabilized ? "dep-ready" : ""} /> Pilot · stabilize the ship</span><span><i className={role === "Engineer" && m.heat < 70 ? "dep-ready" : ""} /> Engineer · balance power and cool</span></> : activeKind === "communications-failure" ? <><span><i /> Commander · choose the comms tradeoff</span><span><i className={role === "Pilot" && m.eventStabilized ? "dep-ready" : ""} /> Pilot · relay outside threats and steady antenna</span><span><i className={role === "Engineer" && Boolean(m.commsOnline) ? "dep-ready" : ""} /> Engineer · restore comms with balanced power</span></> : activeKind === "debris-field" ? <><span><i /> Commander · choose and call the route</span><span><i className={role === "Pilot" && Math.abs((st.heading ?? 0) - (st.target ?? 0)) <= 5 ? "dep-ready" : ""} /> Pilot · navigate the corridor</span><span><i className={role === "Engineer" && st.power === "Engines" ? "dep-ready" : ""} /> Engineer · supply propulsion</span></> : <><span><i /> Commander · compare reports and choose a signal</span><span><i className={role === "Pilot" && m.eventStabilized ? "dep-ready" : ""} /> Pilot · report the echo and stabilize</span><span><i className={role === "Engineer" && st.sensorDiagnostic ? "dep-ready" : ""} /> Engineer · call diagnostic evidence</span></>}
              </div>
              <details className="how-to">
                <summary>How to Play</summary>
                <p><b>Shield sectors:</b> Commander selects Port or Starboard to match the storm. Engineer must route Shield power; Pilot aligns to the safe heading.</p>
                <p><b>Power:</b> Engineer routes power to Shield during storms and Engines to escape.</p>
                <p><b>Coolant:</b> The station holding the circuit clue calls it out. Engineer isolates it, vents, and resets in order.</p>
                <p><b>Headings:</b> Pilot sets the number Commander reads aloud. Alignment takes time.</p>
                <p><b>Escape:</b> Commander reads the code and authorizes. Pilot enters it and initiates escape after engine power and alignment are ready.</p>
              </details>
            </section>
            <section className="station-layout">
              <div className="controls">
                {role === "Commander" && (
                  <>
                    <section className={"panel " + (m.phase <= 1 || m.phase === 2 || m.phase === 3 ? "attention" : "")}>
                      <div className="panel-heading">
                        <h2>{activeKind === "communications-failure" && !m.commsOnline ? "Command uplink · degraded" : "Command intelligence"}</h2>
                        <Radio size={20} />
                      </div>
                      <p>{activeKind === "communications-failure" && !m.commsOnline ? "Navigation feed lost. Ask Pilot for external threat reports." : "Share your unique mission intelligence with the crew."}</p>
                      {activeKind === "solar-flare" && <div className="intel"><label>IMPACT VECTOR · SEVERITY {st.threatSeverity}</label><strong>{st.impactDirection}</strong><span>Safe heading {st.headings?.[0]}° · match this side with shields</span></div>}
                      {activeKind === "reactor-overheat" && <div className="repair-intel"><label>PROCEDURE PRIORITY</label><strong>{st.procedure}</strong><p>Prioritize the system before heat peaks.</p></div>}
                      {activeKind === "debris-field" && <div className="repair-intel"><label>ROUTE INTELLIGENCE</label><strong>{st.routeIntel}</strong></div>}
                      {activeKind === "sensor-disagreement" && <div className="repair-intel"><label>LONG-RANGE FORECAST</label><strong>{st.sensorForecast}</strong></div>}
                      {decisionOptions.length > 0 && <div className="decision-control"><label>COMMAND DECISION</label><div className="choices">{decisionOptions.map((option) => <button key={option.value} className={m.eventDecision === option.value ? "selected" : ""} disabled={busy} onClick={() => void run({ type: "decision", value: option.value })}>{option.label}</button>)}</div></div>}
                      {(activeKind === "solar-flare" || m.phase === 4) && <div className="intel">
                        <label>
                          {escapePrep ? "ESCAPE HEADING" : "SAFE HEADING"}
                        </label>
                        <strong>
                          {st.headings?.[m.phase === 4 ? 2 : guidanceWave]}
                          °
                        </strong>
                        <span>
                          {escapePrep ? "Escape course" : `${stormOrdinal(activeWave >= 0 ? (activeEvent as "storm-1" | "storm-2") : nextStormEvent ?? "storm-1")} storm wave`}
                          {!escapePrep &&
                            ` · ${st.sectors?.[guidanceWave]} shield`}
                        </span>
                      </div>}
                      {activeKind === "solar-flare" && (
                        <div className="repair-intel">
                          <label>CONTAINMENT WINDOW</label>
                          <strong>{Math.max(0, Math.ceil((m.startAt + m.variant.stageStarts[m.phase] * 1000 - clock) / 1000))}s</strong>
                          <p>Tell Pilot the heading and Engineer the shield side.</p>
                        </div>
                      )}
                      {escapePrep && (
                        <div className="intel">
                          <label>ESCAPE AUTHORIZATION CODE</label>
                          <strong>{st.code}</strong>
                          <p>{m.phase === 4 ? "Read the code to Pilot." : "Read this to Pilot while Engineer completes the final repair."}</p>
                        </div>
                      )}
                    </section>
                    {(activeKind === "solar-flare" || m.phase === 4) && <section className={"panel " + (m.phase <= 3 ? "attention" : "")}>
                      <h2>Shield sector</h2>
                      <div className="choices">
                        {["Off", "Port", "Starboard"].map((s) => (
                          <button
                            key={s}
                            className={st.shield === s ? "selected" : ""}
                            disabled={busy}
                            onClick={() =>
                              void run({ type: "shield", value: s })
                            }
                          >
                            {s}
                          </button>
                        ))}
                      </div>
                      <p>
                        Engineer must supply shield power. Pilot must align.
                      </p>
                      <button
                        className="primary"
                        disabled={busy || m.phase !== 4}
                        onClick={() => void run({ type: "authorize" })}
                      >
                        Authorize departure
                      </button>
                    </section>}
                  </>
                )}
                {role === "Pilot" && (
                  <>
                    <section className={"panel " + (m.phase <= 4 ? "attention" : "")}>
                      <div className="panel-heading">
                        <h2>Navigation</h2>
                        <Compass size={22} />
                      </div>
                      <p>{activeKind === "communications-failure" ? "Comms are down. You are the crew’s outside threat feed; call out what you see." : activeKind === "sensor-disagreement" ? "Call out the navigation echo so Command and Engineering can compare evidence." : "Ask Commander for the route heading. Report when aligned."}</p>
                      {st.navigationTrace && <div className="repair-intel"><label>NAVIGATION RETURN</label><strong>{st.navigationTrace}</strong></div>}
                      {st.externalThreat && <div className="repair-intel"><label>OUTSIDE THREAT FEED · SHARE WITH COMMAND</label><strong>{st.externalThreat}</strong></div>}
                      <div className="compass">
                        <span>N</span>
                        <div className="compass-ring">
                          <div
                            className="needle"
                            style={{
                              transform: `rotate(${st.heading ?? 0}deg)`,
                            }}
                          />
                          <b>{Math.round(st.heading ?? 0)}°</b>
                        </div>
                        <small>COMMAND {st.target}° · 60° / SECOND</small>
                      </div>
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          void run({ type: "heading", value: Number(heading) });
                        }}
                      >
                        <label htmlFor="heading">TARGET HEADING</label>
                        <div className="inline-input">
                          <input
                            id="heading"
                            type="number"
                            min="0"
                            max="359"
                            step="1"
                            value={heading}
                            onChange={(e) => setHeading(e.target.value)}
                          />
                          <button disabled={busy || heading === ""}>
                            Set heading
                          </button>
                        </div>
                      </form>
                    </section>
                    {["reactor-overheat", "communications-failure", "sensor-disagreement"].includes(String(activeKind)) && <button className={m.eventStabilized ? "selected" : "primary"} disabled={busy || m.eventStabilized} onClick={() => void run({ type: "stabilize", value: true })}>{m.eventStabilized ? "Ship stabilized" : activeKind === "communications-failure" ? "Steady relay antenna" : "Stabilize ship"}</button>}
                    <section className={"panel " + (m.phase === 4 ? "attention" : "")}>
                      <h2>Escape control</h2>
                      <p>
                        {st.engineReady
                          ? "Engine power available."
                          : "Ask Engineer to supply engine power."}{" "}
                        {st.authorized
                          ? "Commander authorized departure."
                          : "Awaiting Commander authorization."}
                      </p>
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          void run({ type: "code", value: escapeCode });
                        }}
                      >
                        <label htmlFor="escape-code">CODE FROM COMMANDER</label>
                        <div className="inline-input">
                          <input
                            id="escape-code"
                            inputMode="numeric"
                            maxLength={4}
                            placeholder="0000"
                            value={escapeCode}
                            onChange={(e) =>
                              setEscapeCode(e.target.value.replace(/\D/g, ""))
                            }
                          />
                          <button
                            disabled={
                              busy || m.phase !== 4 || escapeCode.length !== 4
                            }
                          >
                            Enter code
                          </button>
                        </div>
                      </form>
                      <button
                        className="primary"
                        disabled={busy || m.phase !== 4 || escapeBlockers.length > 0}
                        onClick={() => void run({ type: "escape" })}
                      >
                        Initiate escape <Rocket size={18} />
                      </button>
                    </section>
                  </>
                )}
                {role === "Engineer" && (
                  <>
                    <section className={"panel power " + (m.phase <= 4 ? "attention" : "")}>
                      <div className="panel-heading">
                        <h2>Power distribution</h2>
                        <span>ROUTE POWER TO CRITICAL SYSTEMS</span>
                      </div>
                      <div className="choices power-choices">
                        {(["Shield", "Balanced", "Engines"] as const).map(
                          (p, i) => (
                            <button
                              key={p}
                              className={st.power === p ? "selected" : ""}
                              disabled={busy}
                              onClick={() =>
                                void run({ type: "power", value: p })
                              }
                            >
                              {i === 0 ? (
                                <Shield size={26} />
                              ) : i === 1 ? (
                                <Wrench size={26} />
                              ) : (
                                <Rocket size={26} />
                              )}
                              <span>
                                <b>{p}</b>
                                <small>
                                  {
                                    [
                                      "Defensive systems",
                                      "Even distribution",
                                      "Escape propulsion",
                                    ][i]
                                  }
                                </small>
                              </span>
                            </button>
                          ),
                        )}
                      </div>
                      <Meter
                        label="SHIELDS"
                        value={Math.round(m.shieldIntegrity * (st.power === "Shield" ? 1 : st.power === "Balanced" ? 0.45 : 0.2))}
                      />
                      <Meter
                        label="LIFE SUPPORT"
                        value={st.power === "Balanced" ? 30 : 10}
                      />
                      <Meter
                        label="ENGINES"
                        value={Math.round(m.propulsion * (st.power === "Engines" ? 1 : st.power === "Balanced" ? 0.45 : 0.2))}
                      />
                      <Meter
                        label="SYSTEMS"
                        value={st.power === "Balanced" ? 20 : 0}
                      />
                    </section>
                    {activeKind === "reactor-overheat" && <section className="panel cooling attention">
                      <h2>Reactor cooling</h2>
                      <Meter
                        label="REACTOR TEMPERATURE"
                        value={st.heat ?? 20}
                        tone="amber"
                      />
                      <Meter label="LIFE SUPPORT" value={m.lifeSupport} />
                      <p>Follow Command’s priority call. Pilot must hold the ship steady.</p>
                      <div className="choices">{["Cooling", "Shields", "Life support"].map((priority) => <button key={priority} className={m.systemPriorityApplied === priority ? "selected" : ""} disabled={busy || m.eventDecision !== priority || (priority === "Shields" ? st.power !== "Shield" : st.power !== "Balanced")} onClick={() => void run({ type: "systems", value: priority })}>{m.systemPriorityApplied === priority ? `${priority} protected` : priority === "Shields" ? "Reinforce shields" : priority === "Life support" ? "Protect life support" : "Engage reactor cooling"}</button>)}</div>
                      <small>{m.eventDecision ? `Command priority: ${m.eventDecision}. Route the matching power before acting.` : "Wait for Commander to set a priority."}</small>
                    </section>}
                    {activeKind === "communications-failure" && <section className="panel cooling attention"><h2>Communications relay</h2><p>{m.commsOnline ? "Relay restored. Shield reserve was diverted to bring the link back." : "Commander’s navigation feed is offline."}</p><button disabled={busy || st.power !== "Balanced" || Boolean(m.commsOnline)} onClick={() => void run({ type: "systems", value: "restore-comms" })}>{m.commsOnline ? "Relay online" : st.power === "Balanced" ? "Restore communications" : "Route Balanced power first"}</button></section>}
                    {activeKind === "sensor-disagreement" && <section className="panel cooling attention"><h2>Sensor diagnostics</h2><p>{st.sensorDiagnostic}</p><label>ISOLATE THE UNRELIABLE SIGNAL</label><div className="choices">{["A", "B", "C"].map((signal) => <button key={signal} className={m.unreliableChosen === signal ? "selected" : ""} disabled={busy} onClick={() => void run({ type: "systems", value: signal })}>Signal {signal}</button>)}</div></section>}
                    {m.phase === 4 && (m.repairKits > 0 && (!m.commsOnline || !m.sensorsReliable || m.propulsion < 70 || m.shieldIntegrity < 70)) && <section className="panel cooling attention"><h2>Emergency repair kits · {m.repairKits}</h2><p>Balanced power is required. Choose the system the crew needs most.</p><div className="choices">{!m.commsOnline && <button disabled={busy || st.power !== "Balanced"} onClick={() => void run({ type: "systems", value: "repair-comms" })}>Repair communications</button>}{!m.sensorsReliable && <button disabled={busy || st.power !== "Balanced"} onClick={() => void run({ type: "systems", value: "repair-sensors" })}>Recalibrate sensors</button>}{m.propulsion < 70 && <button disabled={busy || st.power !== "Balanced"} onClick={() => void run({ type: "systems", value: "repair-propulsion" })}>Restore propulsion</button>}{m.shieldIntegrity < 70 && <button disabled={busy || st.power !== "Balanced"} onClick={() => void run({ type: "systems", value: "repair-shields" })}>Restore shields</button>}</div></section>}
                    {m.phase === 4 && m.heat >= 75 && <section className="panel cooling attention"><h2>Finale reactor reserve</h2><Meter label="REACTOR TEMPERATURE" value={st.heat ?? m.heat} tone="amber"/><button disabled={busy || m.coolingApplied} onClick={() => void run({ type: "systems", value: "final-cool" })}>{m.coolingApplied ? "Heat dumped" : "Dump reactor heat"}</button></section>}
                  </>
                )}
              </div>
              <aside>
                <section className="panel vessel">
                  <h2>Ship systems overview</h2>
                  <Ship alert={!m.commsOnline || !m.sensorsReliable} hull={m.hull} heat={m.heat} shields={m.shieldIntegrity} lifeSupport={m.lifeSupport} comms={m.commsOnline} sensors={m.sensorsReliable} />
                  <p>One shared spacecraft. Every station matters.</p>
                </section>
              </aside>
            </section>
            </>
          )}
          <footer className="crew">
            <label>CREW STATUS</label>
            {room.players.map((p) => (
              <div className={p.id === room.me ? "mine" : ""} key={p.id}>
                <Users size={22} />
                <span>
                  <label>{p.role}</label>
                  <b>{p.name}</b>
                </span>
                <i
                  className={
                    clock - p.seenAt < 15000 ? "online-dot" : "offline-dot"
                  }
                />
                {p.id === room.me && <small>YOUR STATION</small>}
                {host && p.id !== room.me && (
                  <button
                    className="small danger-quiet"
                    disabled={busy}
                    aria-label={`Remove ${p.name} from room`}
                    title={`Remove ${p.name} from room`}
                    onClick={() => void kickPlayer(p.id, p.name)}
                  >
                    <UserMinus size={16} />
                  </button>
                )}
              </div>
            ))}
            <button className="small" disabled={busy} onClick={() => void leaveRoom()}>
              Leave room
            </button>
          </footer>
        </>
      )}
      <div className="page-foot">
        <span>CONTROL ROOM · SOLAR STORM</span>
        <span>COMMUNICATION IS YOUR BEST DEFENSE</span>
      </div>
    </main>
  );
}
