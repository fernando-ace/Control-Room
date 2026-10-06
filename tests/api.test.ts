import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Room, Snapshot } from "../lib/types";
const store = vi.hoisted(() => ({
  rooms: new Map<string, Room>(),
  conflicts: 0,
}));
vi.mock("../lib/server", () => ({
  admin: () => ({
    auth: {
      getUser: async (token: string) => ({
        data: {
          user: ["c", "p", "e", "x"].includes(token) ? { id: token } : null,
        },
        error: null,
      }),
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === "cr_create") {
        const r = args.p_room as Room;
        store.rooms.set(r.code, structuredClone(r));
        return { data: null, error: null };
      }
      if (name === "cr_read") {
        const r = store.rooms.get(args.p_code as string);
        return {
          data: r ? { room: structuredClone(r), now: Date.now() } : null,
          error: null,
        };
      }
      if (name === "cr_commit") {
        const r = args.p_room as Room;
        const old = store.rooms.get(r.code)!;
        if (old.revision !== args.p_expected) {
          store.conflicts++;
          return { data: false, error: null };
        }
        store.rooms.set(r.code, structuredClone(r));
        return { data: true, error: null };
      }
      throw new Error("Unknown RPC");
    },
  }),
}));
import { POST } from "../app/api/room/route";
let seq = 0;
async function request(uid: string, body: Record<string, unknown>) {
  const response = await POST(
    new NextRequest("http://localhost/api/room", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${uid}`,
      },
      body: JSON.stringify({ actionId: `test-id-${++seq}`, ...body }),
    }),
  );
  return { status: response.status, data: await response.json() };
}
async function create() {
  return (await request("c", { op: "create", name: "Commander" }))
    .data as Snapshot;
}
beforeEach(() => {
  store.rooms.clear();
  store.conflicts = 0;
});
describe("authenticated room API and commit races", () => {
  it("rejects invalid identities", async () => {
    expect(
      (await request("invalid", { op: "create", name: "Fake" })).status,
    ).toBe(401);
  });
  it("create, simultaneous joins, capacity, and membership", async () => {
    const r = await create();
    const joined = await Promise.all([
      request("p", { op: "join", code: r.code, name: "Pilot" }),
      request("e", { op: "join", code: r.code, name: "Engineer" }),
    ]);
    expect(joined.every((x) => x.status === 200)).toBe(true);
    expect(store.rooms.get(r.code)!.players).toHaveLength(3);
    expect(store.conflicts).toBeGreaterThan(0);
    expect(
      (await request("x", { op: "join", code: r.code, name: "Fourth" })).status,
    ).toBe(400);
    expect(
      (
        await request("x", {
          op: "action",
          code: r.code,
          action: { type: "sync" },
        })
      ).status,
    ).toBe(410);
  });
  it("preserves simultaneous ready and flight actions", async () => {
    const r = await create();
    await request("p", { op: "join", code: r.code, name: "Pilot" });
    await request("e", { op: "join", code: r.code, name: "Engineer" });
    await Promise.all(
      ["c", "p", "e"].map((uid) =>
        request(uid, {
          op: "action",
          code: r.code,
          action: { type: "ready", value: true },
        }),
      ),
    );
    expect(store.rooms.get(r.code)!.players.every((p) => p.ready)).toBe(true);
    expect(
      (
        await request("c", {
          op: "action",
          code: r.code,
          action: { type: "start" },
        })
      ).status,
    ).toBe(200);
    const actions = await Promise.all([
      request("p", {
        op: "action",
        code: r.code,
        action: { type: "heading", value: 240 },
      }),
      request("e", {
        op: "action",
        code: r.code,
        action: { type: "power", value: "Shield" },
      }),
      request("c", {
        op: "action",
        code: r.code,
        action: { type: "shield", value: "Port" },
      }),
    ]);
    expect(actions.every((x) => x.status === 200)).toBe(true);
    const m = store.rooms.get(r.code)!.mission!;
    expect(m.seed).toMatch(/^[a-f\d]{32}$/i);
    const reconnect = (await request("p", { op: "action", code: r.code, action: { type: "sync", value: false } })).data as Snapshot;
    expect(reconnect.mission?.variant).toEqual(m.variant);
    expect(JSON.stringify(reconnect)).not.toContain(m.seed);
    expect(m.target).toBe(240);
    expect(m.power).toBe("Shield");
    expect(m.shield).toBe("Port");
  });
  it("read-only synchronization cannot cause a realtime feedback loop", async () => {
    const r = await create();
    const revision = store.rooms.get(r.code)!.revision;
    await request("c", {
      op: "action",
      code: r.code,
      action: { type: "sync", value: false },
    });
    expect(store.rooms.get(r.code)!.revision).toBe(revision);
  });
  it("returns only the requesting role information", async () => {
    const r = await create();
    await request("p", { op: "join", code: r.code, name: "Pilot" });
    await request("e", { op: "join", code: r.code, name: "Engineer" });
    for (const uid of ["c", "p", "e"])
      await request(uid, {
        op: "action",
        code: r.code,
        action: { type: "ready", value: true },
      });
    await request("c", {
      op: "action",
      code: r.code,
      action: { type: "start" },
    });
    const pilot = (
      await request("p", {
        op: "action",
        code: r.code,
        action: { type: "sync" },
      })
    ).data as Snapshot;
    expect(pilot.station.headings).toBeUndefined();
    expect(pilot.station.code).toBeUndefined();
    expect(pilot.station.symbols).toBeUndefined();
    expect(JSON.stringify(pilot)).not.toContain("secrets");
  });
});
