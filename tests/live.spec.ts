import { expect, test, Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext } from "@playwright/test";
import type { Snapshot } from "../lib/types";
if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const authStateDir =
  process.env.LIVE_AUTH_STATE_DIR ?? join(process.cwd(), ".playwright", "live-auth");
const authStatePaths = [0, 1, 2, 3].map((index) =>
  join(
    authStateDir,
    process.env.LIVE_AUTH_STATE_DIR
      ? `state-${index}.json`
      : `session-${index}.json`,
  ),
);
let activeContexts: BrowserContext[] = [];
let qaRoom: { id: string; code: string } | null = null;

test.afterEach(async () => {
  try {
    if (qaRoom) {
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const key = process.env.SUPABASE_SECRET_KEY;
      if (!url || !key) throw new Error("Live test cleanup needs the Supabase server key");
      const db = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data, error } = await db
        .from("cr_rooms")
        .delete()
        .eq("id", qaRoom.id)
        .eq("code", qaRoom.code)
        .select("id");
      if (error) throw new Error(`Could not remove QA room: ${error.message}`);
      if (data.length === 0) {
        const { data: remaining, error: verifyError } = await db
          .from("cr_rooms")
          .select("id")
          .eq("id", qaRoom.id)
          .eq("code", qaRoom.code);
        if (verifyError) throw new Error(`Could not verify QA room cleanup: ${verifyError.message}`);
        if (remaining.length > 0) throw new Error("QA room still exists after cleanup");
      }
      qaRoom = null;
    }
  } finally {
    await Promise.all(activeContexts.map((context) => context.close().catch(() => {})));
    activeContexts = [];
  }
});

type ApiResult = { status: number; body: Record<string, unknown> };
// This suite requires real Supabase credentials and runs at real mission speed.
// It deliberately has no test-clock override or production debug endpoint.
test("three independent sessions survive varied emergencies, recover from defeat, reconnect, and retry", async ({
  browser,
}) => {
  test.setTimeout(660000);
  await mkdir(authStateDir, { recursive: true });
  const contexts = await Promise.all(
    authStatePaths.map((path) =>
      browser.newContext({ storageState: existsSync(path) ? path : undefined }),
    ),
  );
  activeContexts = contexts;
  const pages = await Promise.all(contexts.map((c) => c.newPage()));
  for (const page of pages) page.setDefaultTimeout(15000);
  const [c, p, e] = pages;
  const crewPages = [c, p, e];
  const last = new Map<Page, Snapshot>();
  const startSnapshots = new Map<number, Snapshot>();
  const realtimePages = new Set<Page>();
  const runtimeErrors: string[] = [];
  const apiFailures: string[] = [];
  for (const page of pages) {
    if (page === c) {
      // The host misses Realtime; its periodic reconciliation must recover state.
      await page.routeWebSocket(/realtime\/v1\/websocket/, (route) => {
        route.onMessage(() => {});
      });
    } else {
      page.on("websocket", (socket) => {
        if (!socket.url().includes("realtime/v1/websocket")) return;
        socket.on("framereceived", ({ payload }) => {
          if (String(payload).includes('"postgres_changes"'))
            realtimePages.add(page);
        });
      });
    }
    page.on("response", async (r) => {
      if (r.url().endsWith("/api/room") && !r.ok()) {
        try {
          apiFailures.push(`${r.status()} ${(await r.json()).error ?? "Room request failed"}`);
        } catch {
          apiFailures.push(`${r.status()} Room request failed`);
        }
      }
      if (r.url().endsWith("/api/room") && r.ok()) {
        try {
          const s = (await r.json()) as Snapshot;
          if (s.mission && s.mission.startAt === s.serverNow)
            startSnapshots.set(s.mission.startAt, s);
          last.set(page, s);
        } catch {
          // A response can be detached when Playwright closes a context after an assertion.
          // Keep the original test failure visible; required snapshots are asserted below.
        }
      }
    });
    page.on("pageerror", (error) => runtimeErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") runtimeErrors.push(message.text());
    });
  }
  await Promise.all(pages.map(async (page, index) => {
    await page.goto("/");
    const authState = await page.waitForFunction(
      () => {
        const body = document.body.innerText;
        if (body.includes("No account needed. Your name and a six-character code are all you need.")) return "ready";
        if (body.includes("Request rate limit reached")) return "auth-rate-limited";
        return false;
      },
      undefined,
      { timeout: 30000 },
    ).then((handle) => handle.jsonValue() as Promise<"ready" | "auth-rate-limited">);
    if (authState === "auth-rate-limited")
      throw new Error("Supabase rate-limited anonymous sign-in before the live test started.");
    await page.getByLabel("YOUR NAME").fill(["Commander QA", "Pilot QA", "Engineer QA", "Fourth QA"][index]);
    const createRoom = page.getByRole("button", { name: /Create room/ });
    let authError: string | null = null;
    await expect.poll(async () => {
      const ready = await createRoom.isEnabled();
      authError = (await page.locator(".error").allTextContents())[0] ?? null;
      return ready || Boolean(authError);
    }, { timeout: 300000, intervals: [250] }).toBe(true);
    if (authError) throw new Error(`Supabase anonymous sign-in failed: ${authError}`);
    await expect(
      page.getByText(
        "No account needed. Your name and a six-character code are all you need.",
        { exact: true },
      ),
    ).toBeVisible();
    await contexts[index].storageState({ path: authStatePaths[index] });
  }));
  await c.getByLabel("YOUR NAME").fill("Commander QA");
  await expect(c.getByRole("button", { name: /Create room/ })).toBeEnabled();
  const createdRoomResponse = c.waitForResponse(
    (response) =>
      response.url().endsWith("/api/room") &&
      response.request().method() === "POST" &&
      response.ok(),
  );
  await c.getByRole("button", { name: /Create room/ }).click();
  const createdSnapshot = (await (await createdRoomResponse).json()) as Snapshot;
  last.set(c, createdSnapshot);
  qaRoom = { id: createdSnapshot.id, code: createdSnapshot.code };
  await expect(c.getByRole("heading", { name: "Flight crew" })).toBeVisible({
    timeout: 30000,
  });
  const code = last.get(c)!.code;
  await c.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await c.getByRole("button", { name: "Copy room code" }).click();
  await expect(
    c.getByRole("status").filter({ hasText: "Copied!" }),
  ).toBeVisible();
  for (const [page, name] of [
    [p, "Pilot QA"],
    [e, "Engineer QA"],
  ] as const) {
    await page.getByLabel("YOUR NAME").fill(name);
    await page.getByLabel("ROOM CODE").fill(code);
    await page.getByRole("button", { name: "Join room", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Flight crew" }),
    ).toBeVisible({ timeout: 30000 });
  }
  await expect
    .poll(
      () =>
        new Set(
          crewPages
            .map((page) => last.get(page)?.me)
            .filter((id): id is string => Boolean(id)),
        ).size,
    )
    .toBe(3);
  const pageForRole = (role: string) => crewPages.find((page) => {
    const current = last.get(page);
    return current?.players.find((player) => player.id === current.me)?.role === role;
  })!;
  expect(pageForRole("Commander")).toBe(c);
  expect(pageForRole("Pilot")).toBe(p);
  expect(pageForRole("Engineer")).toBe(e);
  await expect(c.locator(".briefing h1")).toHaveText("Commander");
  await expect(p.locator(".briefing h1")).toHaveText("Pilot");
  await expect(e.locator(".briefing h1")).toHaveText("Engineer");
  for (const page of crewPages) {
    await expect(page.getByText(/Everyone has different information and controls/)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Your Job" })).toBeVisible();
  }
  await expect(c.locator(".briefing")).toContainText("threat intelligence");
  await expect(p.locator(".briefing")).toContainText("outside threat");
  await expect(e.locator(".briefing")).toContainText("subsystem health");
  await pages[3].keyboard.press("Tab");
  await expect(pages[3].getByRole("button", { name: "Create room" })).toBeFocused();
  await pages[3].keyboard.press("Tab");
  await expect(pages[3].getByLabel("ROOM CODE")).toBeFocused();
  await pages[3].keyboard.type(code.toLowerCase());
  await expect(pages[3].getByLabel("ROOM CODE")).toHaveValue(code);
  await pages[3].keyboard.press("Tab");
  await expect(pages[3].getByRole("button", { name: "Join room" })).toBeFocused();
  await pages[3].keyboard.press("Enter");
  await expect(pages[3].locator(".error")).toContainText("That room already has three players.");
  await expect.poll(() => last.get(c)?.players.length, { timeout: 8000, intervals: [250] }).toBe(3);

  const tokenFor = (page: Page) =>
    page.evaluate(() => {
      const key = Object.keys(localStorage).find(
        (candidate) =>
          candidate.startsWith("sb-") && candidate.endsWith("-auth-token"),
      );
      if (!key) throw new Error("Anonymous session storage was not found");
      return JSON.parse(localStorage.getItem(key)!).access_token as string;
    });
  const apiClient = (token: string) =>
    createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
      {
        global: { headers: { Authorization: `Bearer ${token}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      },
    );
  const member = apiClient(await tokenFor(c));
  const outsider = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const roomId = last.get(c)!.id;
  const memberRoom = await member
    .from("cr_rooms")
    .select("id,code,revision")
    .eq("id", roomId);
  expect(memberRoom.error).toBeNull();
  expect(memberRoom.data).toHaveLength(1);
  const ownMembership = await member
    .from("cr_members")
    .select("room_id,user_id")
    .eq("room_id", roomId);
  expect(ownMembership.error).toBeNull();
  expect(ownMembership.data).toHaveLength(1);
  const outsiderRoom = await outsider
    .from("cr_rooms")
    .select("id")
    .eq("id", roomId);
  const outsiderMembership = await outsider
    .from("cr_members")
    .select("room_id,user_id")
    .eq("room_id", roomId);
  expect(outsiderRoom.error?.code).toBe("42501");
  expect(outsiderMembership.error?.code).toBe("42501");
  const privateRows = await outsider
    .schema("cr_private")
    .from("states")
    .select("*");
  expect(privateRows.error).not.toBeNull();
  const directRpc = await outsider.rpc("cr_read", { p_code: code });
  expect(directRpc.error).not.toBeNull();
  const directInsert = await outsider
    .from("cr_rooms")
    .insert({ id: crypto.randomUUID(), code: "ZZZZZZ" });
  expect(directInsert.error).not.toBeNull();
  const directUpdate = await member
    .from("cr_rooms")
    .update({ revision: 999999 })
    .eq("id", roomId)
    .select("revision");
  expect(directUpdate.error || directUpdate.data?.length === 0).toBeTruthy();
  const directDelete = await member
    .from("cr_rooms")
    .delete()
    .eq("id", roomId)
    .select("id");
  expect(directDelete.error || directDelete.data?.length === 0).toBeTruthy();
  const privateMutation = await member
    .schema("cr_private")
    .from("states")
    .update({ data: { forged: true } })
    .eq("room_id", roomId);
  expect(privateMutation.error).not.toBeNull();

  const postAction = (
    page: Page,
    actionId: string,
    action: { type: string; value?: string | number | boolean },
    extras: Record<string, unknown> = {},
  ): Promise<ApiResult> =>
    page.evaluate(async ({ actionId, action, extras }) => {
      const key = Object.keys(localStorage).find(
        (candidate) =>
          candidate.startsWith("sb-") && candidate.endsWith("-auth-token"),
      );
      if (!key) throw new Error("Anonymous session storage was not found");
      const accessToken = JSON.parse(localStorage.getItem(key)!).access_token;
      const response = await fetch("/api/room", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          ...extras,
          op: "action",
          code: localStorage.getItem("cr-room"),
          actionId,
          action,
        }),
      });
      return { status: response.status, body: await response.json() };
    }, { actionId, action, extras });
  // Exercise host swapping, then restore the original stations.
  await c.locator(".seat").filter({ hasText: "Pilot QA" }).getByRole("button", { name: "Swap role" }).click();
  await expect(p.locator(".briefing h1")).toHaveText("Commander");
  await c.locator(".seat").filter({ hasText: "Pilot QA" }).getByRole("button", { name: "Swap role" }).click();
  await expect(p.locator(".briefing h1")).toHaveText("Pilot");
  const ready = async () => {
    await Promise.all(
      crewPages.map((page) =>
        page
          .getByRole("button", { name: "Mark station ready", exact: true })
          .click(),
      ),
    );
    await Promise.all(
      crewPages.map((page) =>
        expect(
          page.getByRole("button", { name: "Ready · Click to unready" }),
        ).toBeVisible(),
      ),
    );
    await expect(
      c.getByRole("button", { name: "Launch Solar Storm" }),
    ).toBeEnabled();
    await c.getByRole("button", { name: "Launch Solar Storm" }).click();
    await expect(
      pageForRole("Pilot").getByRole("heading", { name: "Navigation", exact: true }),
    ).toBeVisible();
    for (const page of crewPages) {
      await expect(page.locator(".mission-brief")).toBeVisible();
      await expect(page.locator(".mission-brief")).toContainText("YOUR JOB");
      await expect(page.locator(".objective-list")).toContainText("WAITING");
      await expect(page.locator(".dependencies")).toBeVisible();
      await page.locator(".how-to summary").click();
      await expect(page.locator(".how-to")).toContainText("Shield sectors");
      await page.locator(".how-to summary").click();
    }
  };
  await ready();
  for (const page of crewPages) {
    const width = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    }));
    expect(width.content).toBeLessThanOrEqual(width.viewport);
  }
  await Promise.all(crewPages.map((page, index) =>
    page.screenshot({
      path: `test-results/onboarding-${["commander", "pilot", "engineer"][index]}.png`,
      fullPage: true,
    }),
  ));
  await pageForRole("Engineer").setViewportSize({ width: 390, height: 844 });
  const mobileWidth = await pageForRole("Engineer").evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(mobileWidth.content).toBeLessThanOrEqual(mobileWidth.viewport);
  await pageForRole("Engineer").screenshot({ path: "test-results/onboarding-engineer-mobile.png", fullPage: true });
  await pageForRole("Engineer").setViewportSize({ width: 1280, height: 800 });
  const start = last.get(c)!.mission!.startAt;
  await expect.poll(() => startSnapshots.has(start)).toBe(true);
  expect(startSnapshots.get(start)!.mission!.serverNow).toBe(start);
  expect(last.get(c)!.station.code).toBeDefined();
  expect(last.get(c)!.station.headings).toBeDefined();
  expect(last.get(c)!.station.symbols).toBeUndefined();
  expect(last.get(c)!.station.target).toBeUndefined();
  expect(last.get(pageForRole("Pilot"))!.station.code).toBeUndefined();
  expect(last.get(pageForRole("Pilot"))!.station.headings).toBeUndefined();
  expect(last.get(pageForRole("Pilot"))!.station.symbols).toBeUndefined();
  expect(last.get(pageForRole("Pilot"))!.station.heading).toBeDefined();
  expect(last.get(pageForRole("Engineer"))!.station.code).toBeUndefined();
  expect(last.get(pageForRole("Engineer"))!.station.headings).toBeUndefined();
  expect(last.get(pageForRole("Engineer"))!.station.heading).toBeUndefined();
  expect(last.get(pageForRole("Pilot"))!.station.symbols).toBeUndefined();
  expect(last.get(pageForRole("Engineer"))!.station.headings).toBeUndefined();
  await pageForRole("Pilot").reload();
  await expect(
    pageForRole("Pilot").getByRole("heading", { name: "Navigation", exact: true }),
  ).toBeVisible();
  expect(last.get(pageForRole("Pilot"))!.players.find((x) => x.id === last.get(pageForRole("Pilot"))!.me)!.role).toBe(
    "Pilot",
  );
  expect(last.get(pageForRole("Pilot"))!.mission?.variant).toEqual(last.get(c)!.mission?.variant);
  expect(last.get(pageForRole("Pilot"))!.mission?.startAt).toBe(start);
  const beforeConcurrent = last.get(c)!.revision;
  const [, , forgedAction] = await Promise.all([
    c.getByRole("button", { name: "Port", exact: true }).click(),
    pageForRole("Engineer")
      .getByRole("button", { name: "Shield Defensive systems", exact: true })
      .click(),
    postAction(
      pageForRole("Pilot"),
      "live-forged-state-action",
      { type: "heading", value: 240 },
      {
        canonicalState: { result: "victory", hull: 0 },
        timestamp: 0,
        damage: 999,
        result: "victory",
        identity: last.get(c)!.me,
        stationOwnership: "Commander",
      },
    ),
  ]);
  expect(forgedAction.status).toBe(200);
  expect((forgedAction.body as Snapshot).me).toBe(last.get(pageForRole("Pilot"))!.me);
  expect((forgedAction.body as Snapshot).mission?.result).toBeNull();
  expect((forgedAction.body as Snapshot).mission?.hull).toBeGreaterThan(0);
  expect((forgedAction.body as Snapshot).revision).toBeGreaterThan(
    beforeConcurrent,
  );
  await expect.poll(() => realtimePages.size, { timeout: 12000 }).toBeGreaterThan(0);
  const completeCurrentMission = async () => {
    const initial = last.get(c)!.mission!;
    const variant = initial.variant;
    const runStart = initial.startAt;
    expect(variant.emergencyKinds).toHaveLength(3);
    expect(new Set(variant.emergencyKinds).size).toBe(3);
    expect(variant.emergencyKinds[0]).toBe("solar-flare");
    expect(variant.stageStarts[0]).toBeGreaterThanOrEqual(10);
    expect(variant.stageStarts[0]).toBeLessThanOrEqual(15);
    expect(crewPages.map((page) => last.get(page)!.mission!.variant)).toEqual([
      variant, variant, variant,
    ]);
    expect(initial).not.toHaveProperty("seed");
    const at = async (seconds: number) => {
      await expect.poll(() => last.get(c)?.mission?.serverNow, {
        timeout: 160000, intervals: [500],
      }).toBeGreaterThanOrEqual(runStart + seconds * 1000);
    };
    const pilot = pageForRole("Pilot");
    for (let stage = 0; stage < 3; stage++) {
      const event = variant.emergencyKinds[stage];
      const seconds = variant.stageStarts[stage];
      await at(seconds);
      if (stage === 0) {
        await pilot.reload();
        await expect(pilot.getByRole("heading", { name: "Navigation", exact: true })).toBeVisible();
        await expect.poll(() => last.get(pilot)?.mission?.phase).toBe(1);
      }
      for (const page of crewPages) {
        await expect(page.locator(".mission-brief")).toContainText(
          ({
            "solar-flare": "Solar flare impact",
            "reactor-overheat": "Reactor overheat",
            "communications-failure": "Communications failure",
            "debris-field": "Debris field",
            "sensor-disagreement": "Sensor disagreement",
          } as const)[event],
        );
      }
      const commander = pageForRole("Commander");
      const engineer = pageForRole("Engineer");
      if (event === "solar-flare") {
        const intel = last.get(commander)!.station;
        expect(intel.impactDirection).toMatch(/^(Port|Starboard)$/);
        expect(intel.threatSeverity).toBeGreaterThan(0);
        await commander.getByRole("button", { name: intel.impactDirection!, exact: true }).click();
        await engineer.getByRole("button", { name: "Shield Defensive systems", exact: true }).click();
        await pilot.getByLabel("TARGET HEADING").fill(String(intel.headings![0]));
        await pilot.getByRole("button", { name: "Set heading" }).click();
        await expect.poll(() => last.get(c)?.mission?.completedAt[0], { timeout: 25000 }).toBeTruthy();
      } else if (event === "reactor-overheat") {
        const priority = last.get(commander)!.station.procedure!;
        await commander.getByRole("button", { name: priority, exact: true }).click();
        await pilot.getByRole("button", { name: "Stabilize ship", exact: true }).click();
        await engineer.getByRole("button", { name: priority === "Shields" ? "Shield Defensive systems" : "Balanced Even distribution", exact: true }).click();
        const response = priority === "Shields" ? "Reinforce shields" : priority === "Life support" ? "Protect life support" : "Engage reactor cooling";
        await engineer.getByRole("button", { name: response, exact: true }).click();
        await expect.poll(() => last.get(engineer)?.mission?.systemPriorityApplied).toBe(priority);
      } else if (event === "communications-failure") {
        expect(last.get(commander)!.mission?.commsOnline).toBe(false);
        expect(last.get(commander)!.station.headings).toBeUndefined();
        await expect.poll(() => last.get(pilot)?.station.externalThreat).toBeDefined();
        await commander.getByRole("button", { name: "Restore communications", exact: true }).click();
        await pilot.getByRole("button", { name: "Steady relay antenna", exact: true }).click();
        await engineer.getByRole("button", { name: "Balanced Even distribution", exact: true }).click();
        await engineer.getByRole("button", { name: "Restore communications", exact: true }).click();
        await expect.poll(() => last.get(c)?.mission?.commsOnline).toBe(true);
        expect(last.get(c)!.mission!.shieldIntegrity).toBeLessThan(100);
      } else if (event === "debris-field") {
        const route = last.get(commander)!.station;
        const safeHeading = Number(route.routeIntel!.match(/corridor (\d+)°/)![1]);
        await commander.getByRole("button", { name: "Safe route", exact: true }).click();
        await engineer.getByRole("button", { name: "Engines Escape propulsion", exact: true }).click();
        await pilot.getByLabel("TARGET HEADING").fill(String(safeHeading));
        await pilot.getByRole("button", { name: "Set heading" }).click();
      } else {
        const signal = last.get(engineer)!.station.sensorDiagnostic!.match(/sensor ([ABC])/i)![1].toUpperCase();
        expect(last.get(commander)!.station.sensorForecast).toBeDefined();
        expect(last.get(pilot)!.station.navigationTrace).toBeDefined();
        await commander.getByRole("button", { name: `Trust signal ${signal}`, exact: true }).click();
        await pilot.getByRole("button", { name: "Stabilize ship", exact: true }).click();
        await engineer.getByRole("button", { name: `Signal ${signal}`, exact: true }).click();
      }
      const nextStart = variant.stageStarts[stage + 1];
      await at(nextStart);
      await expect.poll(() => last.get(c)?.mission?.emergencyResults[stage]).toBe("recovered");
    }
    const escapeHeading = last.get(c)!.station.headings![2];
    const engineer = pageForRole("Engineer");
    const enginePower = engineer.getByRole("button", {
      name: "Engines Escape propulsion",
      exact: true,
    });
    if (await enginePower.count() !== 1) {
      throw new Error(
        `Engineer escape control missing (role=${last.get(engineer)?.players.find((player) => player.id === last.get(engineer)?.me)?.role}):\n${await engineer.locator("body").innerText()}`,
      );
    }
    await expect(enginePower).toBeEnabled({ timeout: 10000 });
    await Promise.all([
      enginePower.click({ timeout: 10000 }),
      pageForRole("Pilot").getByLabel("TARGET HEADING").fill(String(escapeHeading)).then(() =>
        pageForRole("Pilot").getByRole("button", { name: "Set heading" }).click(),
      ),
    ]);
    await at(variant.stageStarts[3] + 1);
    await expect(c.getByRole("button", { name: "Authorize departure" })).toBeEnabled();
    await Promise.all([
      c.getByRole("button", { name: "Authorize departure" }).click(),
      (async () => {
        await pageForRole("Pilot").getByLabel("CODE FROM COMMANDER").fill(last.get(c)!.station.code!);
        await pageForRole("Pilot").getByRole("button", { name: "Enter code", exact: true }).click();
      })(),
    ]);
    await expect.poll(() => last.get(pageForRole("Pilot"))?.station.heading).toBeCloseTo(last.get(c)!.station.headings![2], 0);
    await pageForRole("Pilot").getByRole("button", { name: /Initiate escape/ }).click();
    await Promise.all(crewPages.map((page) =>
      expect(page.getByRole("heading", { name: "You brought them home together." })).toBeVisible(),
    ));
    await c.screenshot({ path: `test-results/live-victory-${variant.name.toLowerCase().replaceAll(" ", "-")}.png`, fullPage: true });
    return { variant, startAt: runStart };
  };
  const firstRun = await completeCurrentMission();
  await c.getByRole("button", { name: /Return to lobby/ }).click();
  await Promise.all(crewPages.map((page) =>
    expect(page.getByRole("heading", { name: "Flight crew" })).toBeVisible(),
  ));
  await ready();
  await expect.poll(() => last.get(c)?.mission?.startAt).toBeGreaterThan(firstRun.startAt);
  await expect.poll(() => crewPages.map((page) => last.get(page)?.mission?.startAt)).toEqual([
    last.get(c)!.mission!.startAt, last.get(c)!.mission!.startAt, last.get(c)!.mission!.startAt,
  ]);
  const secondRun = last.get(c)!.mission!;
  expect(secondRun.variant.name).not.toBe(firstRun.variant.name);
  expect(secondRun.variant.emergencyKinds).not.toEqual(firstRun.variant.emergencyKinds);
  expect(secondRun.variant.emergencyKinds.filter((kind) => kind !== "solar-flare" && !firstRun.variant.emergencyKinds.includes(kind))).toHaveLength(2);
  expect(secondRun.startAt).toBeGreaterThan(firstRun.startAt);
  expect(secondRun.phase).toBe(0);
  expect(secondRun.hull).toBe(100);
  expect(secondRun.emergencyResults).toEqual([null, null, null]);
  expect(secondRun.commsOnline).toBe(true);
  expect(secondRun.repairKits).toBe(2);
  expect(last.get(c)!.players.map((player) => player.role)).toEqual([
    "Commander", "Pilot", "Engineer",
  ]);
  expect(last.get(pageForRole("Engineer"))!.station.power).toBe("Balanced");
  expect(last.get(pageForRole("Pilot"))!.station.codeEntered).toBe("");
  await expect(pageForRole("Pilot").getByLabel("CODE FROM COMMANDER")).toHaveValue("");
  await expect(pageForRole("Pilot").getByLabel("TARGET HEADING")).toHaveValue("180");
  await completeCurrentMission();
  await c.getByRole("button", { name: /Return to lobby/ }).click();
  await Promise.all(crewPages.map((page) =>
    expect(page.getByRole("heading", { name: "Flight crew" })).toBeVisible(),
  ));
  await ready();
  await expect.poll(() => last.get(c)?.mission?.result, { timeout: 160000, intervals: [500] }).toBe("defeat");
  await Promise.all(crewPages.map((page) =>
    expect(page.getByRole("heading", { name: "The ship was lost to the storm." })).toBeVisible(),
  ));
  expect(last.get(c)!.mission?.reason).toBeTruthy();
  await c.screenshot({ path: "test-results/live-defeat-crew-report.png", fullPage: true });
  await c.getByRole("button", { name: /Return to lobby/ }).click();
  await Promise.all(crewPages.map((page) =>
    expect(page.getByRole("heading", { name: "Flight crew" })).toBeVisible(),
  ));

  // Host removal, guest leave/rejoin, and host transfer remain room scoped.
  c.once("dialog", (dialog) => void dialog.accept());
  await c.getByRole("button", { name: "Remove Pilot QA from room" }).click();
  await expect(p.getByRole("heading", { name: "Start your crew" })).toBeVisible({ timeout: 15000 });
  await p.getByLabel("YOUR NAME").fill("Pilot QA");
  await p.getByLabel("ROOM CODE").fill(code);
  await p.getByRole("button", { name: "Join room", exact: true }).click();
  await expect(p.locator(".error")).toContainText(
    "You were removed from this room and can’t rejoin it.",
  );
  await e.getByRole("button", { name: "Leave room", exact: true }).click();
  await expect(e.getByText("You left the room.")).toBeVisible();
  await e.getByLabel("ROOM CODE").fill(code);
  await e.getByRole("button", { name: "Join room", exact: true }).click();
  await expect(e.getByRole("heading", { name: "Flight crew" })).toBeVisible();
  await expect.poll(() => last.get(e)?.players.find((player) => player.id === last.get(e)?.me)?.role).toBe("Pilot");
  await c.getByRole("button", { name: "Leave room", exact: true }).click();
  await expect.poll(() => last.get(e)?.hostId).toBe(last.get(e)?.me);
  await e.getByRole("button", { name: "Leave room", exact: true }).click();
  await expect(e.getByText("You left the room.")).toBeVisible();
  expect(runtimeErrors.filter((message) =>
    !/status of (?:400 \(Bad Request\)|410 \(Gone\))/.test(message),
  )).toEqual([]);
});
