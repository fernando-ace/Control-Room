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
} from "lucide-react";
import { browserClient, ensureAnonymousSession } from "@/lib/browser";
import { Action, Role, Snapshot } from "@/lib/types";
const briefings: Record<Role, string> = {
  Commander:
    "You are the crew’s eyes. Read each safe heading, shield side, damaged circuit, and escape code aloud as it becomes relevant. Set shields and authorize departure.",
  Pilot:
    "You are the crew’s course and launch control. Ask Commander for each heading and the final code. Set the heading, then enter the code and initiate escape when the crew is ready.",
  Engineer:
    "You keep the ship powered and cool. Route power to shields during storms, then engines for escape. When coolant fails, ask Commander for the symbol; isolate, vent, and reset in that order.",
};
const jobs: Record<Role, string> = {
  Commander: "Call out the safe heading and shield side. Set the shield; authorize escape at the end.",
  Pilot: "Set the heading Commander calls. At the escape window, enter the code and initiate escape.",
  Engineer: "Power shields for storm holds. Repair the called circuit; switch to engines for escape.",
};
const phases = [
  "Approach",
  "First storm wave",
  "Coolant failure",
  "Second storm wave",
  "Escape window",
];
const phaseHints = [
  "Confirm your stations. The first storm arrives in 12 seconds.",
  "Coordinate the shield sector, shield power, and heading. Hold together for five seconds.",
  "Ask Commander for the damaged circuit symbol. Isolate, vent, then reset.",
  "A new storm direction. Coordinate shielding and heading for an eight-second hold.",
  "Complete both storm holds and coolant repair. Set engines, align, enter code, authorize, then escape.",
];
export default function ControlRoom() {
  const [room, setRoom] = useState<Snapshot | null>(null),
    [name, setName] = useState(""),
    [code, setCode] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
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
  const accept = useCallback((s: Snapshot) => {
    if (
      roomRef.current &&
      roomRef.current.id === s.id &&
      (roomRef.current.revision > s.revision ||
        (roomRef.current.revision === s.revision &&
          roomRef.current.serverNow > s.serverNow))
    )
      return;
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
    ) => {
      const db = browserClient();
      const { data } = await db.auth.getSession();
      if (!data.session) throw new Error("No session. Refresh to reconnect.");
      const response = await fetch("/api/room", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${data.session.access_token}`,
        },
        body: JSON.stringify({
          op,
          code: roomCode,
          name: playerName,
          action,
          actionId: crypto.randomUUID(),
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Connection failed");
      accept(result as Snapshot);
      return result as Snapshot;
    },
    [accept],
  );
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const db = browserClient();
        await ensureAnonymousSession(db);
        if (!alive) return;
        setIdentity(true);
        const saved = localStorage.getItem("cr-room");
        if (saved) {
          try {
            await call("action", saved, { type: "sync" });
          } catch {
            localStorage.removeItem("cr-room");
          }
        }
      } catch (e) {
        if (alive)
          setError(e instanceof Error ? e.message : "Could not connect");
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
    const sync = async (write: boolean) => {
      try {
        await call("action", roomRef.current!.code, {
          type: "sync",
          value: write,
        });
        if (alive) setNetwork("Connected");
      } catch (e) {
        if (alive) {
          setNetwork("Reconnecting");
          setError(e instanceof Error ? e.message : "Connection lost");
        }
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
      if (beforeHull !== undefined && updated.mission && updated.mission.hull < beforeHull) {
        setActionFeedback(`Hull −${Math.round(beforeHull - updated.mission.hull)}% · the team took damage. Recheck the called heading, shield, and power.`);
      } else {
        const feedback: Record<string, string> = {
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
        setActionFeedback(feedback[action.type] ?? "Action received.");
      }
      window.setTimeout(() => setActionFeedback(""), 5000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  };
  const enter = async (op: string) => {
    setBusy(true);
    setError("");
    try {
      await call(op, code.toUpperCase(), undefined, name);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Connection failed");
    } finally {
      setBusy(false);
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
  return (
    <main className="shell">
      <header>
        <Link className="brand" href="/">
          CONTROL ROOM
        </Link>
        <span className="subtitle">COOPERATIVE SPACECRAFT STATION</span>
        <div className="header-right">
          <span className="storm">
            <AlertTriangle size={16} /> SOLAR STORM
          </span>
          {room && (
            <span className="room-code">
              ROOM <b>{room.code}</b>
              <button
                className="icon-button"
                aria-label="Copy room code"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(room.code)
                    .catch(() => setError("Copy the room code shown above."))
                }
              >
                <Copy size={15} />
              </button>
            </span>
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
              A solar storm is closing in. Each of you has a different piece of
              the answer. Talk, coordinate, and bring your spacecraft home.
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
            <h2>Assemble your crew</h2>
            <p>Play together in person or on a voice call.</p>
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
              Create room <Rocket size={18} />
            </button>
            <div className="divider">OR JOIN YOUR CREW</div>
            <label htmlFor="code">ROOM CODE</label>
            <input
              id="code"
              maxLength={6}
              placeholder="Q7KM2A"
              className="code-input"
              value={code}
              onChange={(e) =>
                setCode(e.target.value.toUpperCase().replace(/[^A-Z2-9]/g, ""))
              }
            />
            <button
              type="submit"
              disabled={!identity || busy || !name.trim() || code.length !== 6}
            >
              Join room
            </button>
            <small>
              {identity
                ? "No signup. Just your name and a room code."
                : "Connecting to mission control…"}
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
                  <span>{room.code}</span>
                </div>
                <p>
                  Share the room code. All three stations must be ready before
                  launch.
                </p>
                <div className="lobby-players">
                  {(["Commander", "Pilot", "Engineer"] as Role[]).map((r) => {
                    const p = room.players.find((p) => p.role === r);
                    return (
                      <div
                        className={"seat " + (p?.id === room.me ? "mine" : "")}
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
                          <label>{r}</label>
                          <h3>{p?.name ?? "Waiting for crew…"}</h3>
                          <span className="seat-status">
                            {p
                              ? clock - p.seenAt >= 15000
                                ? "Reconnecting"
                                : p.ready
                                  ? "Ready"
                                  : "Reviewing briefing"
                              : "Open station"}
                          </span>
                        </div>
                        {p?.ready && <Check className="online" />}
                        {host && p && p.id !== room.me && (
                          <button
                            className="small"
                            disabled={busy}
                            onClick={() =>
                              void run({ type: "swap", value: p.id })
                            }
                          >
                            Swap with me
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
                >
                  {me?.ready ? "Ready · Click to unready" : "Station ready"}
                </button>
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
                    Launch Solar Storm
                  </button>
                ) : (
                  <p className="waiting">
                    The host will launch when all stations are ready.
                  </p>
                )}
              </div>
              <div className="panel briefing">
                <label>YOUR STATION</label>
                <h1>{role}</h1>
                <p className="universal-brief">Everyone has different information and controls. Talk constantly: call out what you see, what you are doing, and when you are ready.</p>
                <h2>Your Job</h2>
                <p>{role && jobs[role]}</p>
                <p>{role && briefings[role]}</p>
                <h2>Mission briefing</h2>
                <ol>
                  <li>Shield the first storm wave.</li>
                  <li>Identify and repair the coolant circuit.</li>
                  <li>Survive the second wave.</li>
                  <li>Coordinate departure before time runs out.</li>
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
                  ? "You brought them home."
                  : "The storm won this time."}
              </h1>
              <p>{m.reason}</p>
              <div className="result-metrics">
                <span>
                  <b>{Math.round(m.hull)}%</b>Hull remaining
                </span>
                <span>
                  <b>{m.completedAt.filter(Boolean).length}/2</b>Storm holds
                  completed
                </span>
                <span>
                  <b>{m.repairedAt ? "Restored" : "Unresolved"}</b>Coolant
                  system
                </span>
              </div>
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
            <section className="mission-brief panel" aria-live="polite">
              <div className="mission-brief-main">
                <label>YOUR JOB · {role}</label>
                <h1>{m.phase === 4 ? "Prepare to escape" : phases[m.phase]}</h1>
                <p>{role === "Commander" ? (m.phase === 4 ? "Read the escape heading and code to Pilot, then authorize departure." : `Call out ${st.headings?.[m.phase >= 2 ? 1 : 0]}° and ${st.sectors?.[m.phase >= 2 ? 1 : 0]} shield. Set the shield sector.`) : role === "Pilot" ? (m.phase === 4 ? "Ask Commander for the escape heading and code. Align, enter the code, and initiate escape when ready." : "Ask Commander for the safe heading, set it, and tell the crew when aligned.") : (m.phase === 4 ? "Switch power to Engines. Tell Pilot when engine power is ready." : m.phase >= 2 && !m.repairedAt && (m.phase > 2 || clock >= m.startAt + 80000) ? `Repair coolant: isolate the circuit Commander calls (${st.brokenSymbol}), vent, then reset.` : m.phase === 2 ? "Keep power Balanced. Coolant failure begins at 1:20—ask Commander for the damaged circuit symbol." : "Route power to Shield. Keep the crew informed when power is set.")}</p>
                {m.hull <= 40 && <p className="hull-warning">WARNING · Hull at {Math.round(m.hull)}%. Correct the active storm setup now.</p>}
                {actionFeedback && <p className="action-feedback" role="status">{actionFeedback}</p>}
              </div>
              <div className="objective-list" aria-label="Mission objectives">
                {[
                  { text: "First storm hold", done: Boolean(m.completedAt[0]), active: m.phase <= 1 },
                  { text: "Coolant restored", done: Boolean(m.repairedAt), active: m.phase >= 2 && !m.repairedAt && (m.phase > 2 || clock >= m.startAt + 80000) },
                  { text: "Second storm hold", done: Boolean(m.completedAt[1]), active: m.phase === 3 },
                  { text: "Escape", done: false, active: m.phase === 4 },
                ].map((o) => <span key={o.text} className={o.done ? "objective-done" : o.active ? "objective-active" : "objective-waiting"}><b>{o.done ? "✓" : o.active ? "●" : "○"}</b>{o.text}<small>{o.done ? "COMPLETED" : o.active ? "ACTIVE" : "WAITING"}</small></span>)}
              </div>
              <div className="dependencies">
                <b>NEEDS CREW</b>
                {(m.phase < 2 || m.phase === 3) && <span><i className={role === "Engineer" && st.power === "Shield" ? "dep-ready" : ""} /> {role === "Engineer" ? `You · Shield power ${st.power === "Shield" ? "ready" : "needed"}` : "Engineer · route Shield power"}</span>}
                {(m.phase < 2 || m.phase === 3) && <span><i /> {role === "Pilot" ? `You · compare current heading ${Math.round(st.heading ?? 0)}° with Commander’s call` : `Pilot · align to ${role === "Commander" ? "the safe heading above" : "the heading Commander calls"}`}</span>}
                {m.phase === 2 && !m.repairedAt && clock >= m.startAt + 80000 && <span><i /> Engineer · isolate, vent, and reset the called circuit</span>}
                {m.phase === 4 && <><span><i className={role === "Engineer" && st.power === "Engines" ? "dep-ready" : ""} /> {role === "Engineer" ? `You · engine power ${st.power === "Engines" ? "ready" : "needed"}` : "Engineer · switch power to Engines"}</span><span><i className={role === "Pilot" && st.authorized ? "dep-ready" : ""} /> {role === "Commander" ? "You · authorize departure" : "Commander · authorize departure"}</span><span><i /> {role === "Pilot" ? `You · compare current heading ${Math.round(st.heading ?? 0)}° with Commander’s escape call` : `Pilot · align to ${role === "Commander" ? "the escape heading above" : "the heading Commander calls"}`}</span></>}
              </div>
              <details className="how-to">
                <summary>How to Play</summary>
                <p><b>Shield sectors:</b> Commander selects Port or Starboard to match the storm. Engineer must route Shield power; Pilot aligns to the safe heading.</p>
                <p><b>Power:</b> Engineer routes power to Shield during storms and Engines to escape.</p>
                <p><b>Coolant:</b> Engineer selects the symbol Commander calls, then vents and resets in order.</p>
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
                        <h2>Command intelligence</h2>
                        <Radio size={20} />
                      </div>
                      <p>
                        Read this to your crew. They cannot see these
                        instructions.
                      </p>
                      <div className="intel">
                        <label>
                          {m.phase === 4 ? "ESCAPE HEADING" : "SAFE HEADING"}
                        </label>
                        <strong>
                          {
                            st.headings?.[
                              m.phase === 4 ? 2 : m.phase >= 2 ? 1 : 0
                            ]
                          }
                          °
                        </strong>
                        <span>
                          {m.phase >= 2 && m.phase < 4 ? "Second wave" : "First wave"}
                          {m.phase !== 4 &&
                            ` · ${st.sectors?.[m.phase >= 2 ? 1 : 0]} shield`}
                        </span>
                      </div>
                      {m.phase >= 2 && (
                        <div className="repair-intel">
                          <label>DAMAGED CIRCUIT SYMBOL</label>
                          <strong>{st.brokenSymbol}</strong>
                          <p>
                            Tell Engineer: isolate this symbol, vent coolant,
                            then reset.
                          </p>
                        </div>
                      )}
                      {m.phase === 4 && (
                        <div className="intel">
                          <label>ESCAPE AUTHORIZATION CODE</label>
                          <strong>{st.code}</strong>
                          <p>Read the code to Pilot.</p>
                        </div>
                      )}
                    </section>
                    <section className={"panel " + (m.phase <= 3 ? "attention" : "")}>
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
                    </section>
                  </>
                )}
                {role === "Pilot" && (
                  <>
                    <section className={"panel " + (m.phase === 0 || m.phase === 1 || m.phase === 3 || m.phase === 4 ? "attention" : "")}>
                      <div className="panel-heading">
                        <h2>Navigation</h2>
                        <Compass size={22} />
                      </div>
                      <p>
                        Ask Commander for the safe heading. Report when aligned.
                      </p>
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
                        disabled={busy || m.phase !== 4}
                        onClick={() => void run({ type: "escape" })}
                      >
                        Initiate escape <Rocket size={18} />
                      </button>
                    </section>
                  </>
                )}
                {role === "Engineer" && (
                  <>
                    <section className={"panel power " + (m.phase === 0 || m.phase === 1 || m.phase === 3 || m.phase === 4 ? "attention" : "")}>
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
                        value={
                          st.power === "Shield"
                            ? 80
                            : st.power === "Balanced"
                              ? 25
                              : 10
                        }
                      />
                      <Meter
                        label="LIFE SUPPORT"
                        value={st.power === "Balanced" ? 30 : 10}
                      />
                      <Meter
                        label="ENGINES"
                        value={
                          st.power === "Engines"
                            ? 80
                            : st.power === "Balanced"
                              ? 25
                              : 10
                        }
                      />
                      <Meter
                        label="SYSTEMS"
                        value={st.power === "Balanced" ? 20 : 0}
                      />
                    </section>
                    <section className={"panel cooling " + (m.phase >= 2 && !m.repairedAt && (m.phase > 2 || clock >= m.startAt + 80000) ? "attention" : "")}>
                      <h2>Cooling system</h2>
                      <Meter
                        label="STATION HEAT"
                        value={st.heat ?? 20}
                        tone="amber"
                      />
                      <div className="choices">
                        <button
                          disabled={
                            busy ||
                            m.phase < 2 ||
                            !st.isolated ||
                            Boolean(m.repairedAt)
                          }
                          onClick={() => void run({ type: "vent" })}
                        >
                          Vent coolant
                        </button>
                        <button
                          disabled={busy || !st.vented || Boolean(m.repairedAt)}
                          onClick={() => void run({ type: "reset" })}
                        >
                          Reset circuit
                        </button>
                      </div>
                      <label>COOLANT CIRCUITS · SELECT TO ISOLATE</label>
                      <div className="choices circuits">
                        {Object.entries(st.symbols ?? {}).map(([c, s]) => (
                          <button
                            key={c}
                            disabled={
                              busy || m.phase < 2 || Boolean(m.repairedAt)
                            }
                            className={st.isolated === c ? "selected" : ""}
                            onClick={() =>
                              void run({ type: "isolate", value: c })
                            }
                          >
                            <b>{c}</b>
                            <strong>{s}</strong>
                          </button>
                        ))}
                      </div>
                      <small>
                        {m.repairedAt
                          ? "Coolant restored"
                          : st.vented
                            ? "Vented · Ready to reset"
                            : st.isolated
                              ? `Circuit ${st.isolated} isolated · Vent next`
                              : "Ask Commander for the damaged symbol."}
                      </small>
                    </section>
                  </>
                )}
              </div>
              <aside>
                <section className="mission-alert">
                  <div>
                    <AlertTriangle size={38} />
                    <label>MISSION ALERT</label>
                  </div>
                  <h1>{phases[m.phase]}</h1>
                  <p>{phaseHints[m.phase]}</p>
                  <div className="objectives">
                    <span className={m.completedAt[0] ? "done" : ""}>
                      <Check size={15} /> First storm hold
                    </span>
                    <span className={m.repairedAt ? "done" : ""}>
                      <Check size={15} /> Coolant restored
                    </span>
                    <span className={m.completedAt[1] ? "done" : ""}>
                      <Check size={15} /> Second storm hold
                    </span>
                  </div>
                </section>
                <section className="panel vessel">
                  <h2>Ship systems overview</h2>
                  <Ship alert={m.phase === 2 && !m.repairedAt} />
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
              </div>
            ))}
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
