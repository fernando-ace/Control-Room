import { expect, test, Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { join } from "node:path";
import type { Snapshot } from "../lib/types";
process.loadEnvFile(".env.local");

type ApiResult = { status: number; body: Record<string, unknown> };
// This suite requires real Supabase credentials and runs at real mission speed.
// It deliberately has no test-clock override or production debug endpoint.
test("three independent sessions complete two distinct Solar Storm sequences, reconnect, and retry", async ({
  browser,
}) => {
  test.setTimeout(540000);
  const authStateDir = process.env.LIVE_AUTH_STATE_DIR;
  const contexts = await Promise.all([0, 1, 2].map((index) => browser.newContext(
    authStateDir ? { storageState: join(authStateDir, `state-${index}.json`) } : {},
  )));
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
    await page
      .getByLabel("YOUR NAME")
      .fill(["Commander QA", "Pilot QA", "Engineer QA"][index]);
    const createRoom = page.getByRole("button", { name: /Create room/ });
    let authError: string | null = null;
    await expect.poll(async () => {
      const ready = await createRoom.isEnabled();
      authError = (await page.locator(".error").allTextContents())[0] ?? null;
      return ready || Boolean(authError);
    }, {
      timeout: 300000,
      intervals: [250],
    }).toBe(true);
    if (authError) throw new Error(`Supabase anonymous sign-in failed: ${authError}`);
    await expect(page.getByText("No signup. Just your name and a room code.", { exact: true })).toBeVisible();
  }));
  await c.getByLabel("YOUR NAME").fill("Commander QA");
  await expect(c.getByRole("button", { name: /Create room/ })).toBeEnabled();
  await c.getByRole("button", { name: /Create room/ }).click();
  await expect(c.getByRole("heading", { name: "Flight crew" })).toBeVisible({
    timeout: 30000,
  });
  const code = last.get(c)!.code;
  await c.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await c.getByRole("button", { name: "Copy room code" }).click();
  await expect(c.getByText("Copied!", { exact: true })).toBeVisible();
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
  await expect(c.locator(".briefing")).toContainText("crew’s eyes");
  await expect(p.locator(".briefing")).toContainText("course and launch control");
  await expect(e.locator(".briefing")).toContainText("powered and cool");
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
  const ready = async () => {
    await Promise.all(
      crewPages.map((page) =>
        page
          .getByRole("button", { name: "Station ready", exact: true })
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
    expect(variant.order).toHaveLength(3);
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
    for (let stage = 0; stage < 3; stage++) {
      const event = variant.order[stage];
      const seconds = variant.stageStarts[stage];
      await at(seconds);
      const stormNumber = variant.order.slice(0, stage).filter((previous) => previous !== "coolant").length + 1;
      for (const page of crewPages) {
        await expect(page.locator(".mission-brief")).toContainText(
          event === "coolant" ? "Coolant failure" : `${stormNumber === 1 ? "First" : "Second"} storm wave`,
        );
      }
      if (event === "coolant") {
        await expect.poll(() => crewPages.map((page) => last.get(page)?.station.brokenSymbol).find(Boolean)).toMatch(/^(○|△|□)$/);
        const clue = crewPages.map((page) => last.get(page)!.station.brokenSymbol).find(Boolean)!;
        const symbols = last.get(pageForRole("Engineer"))!.station.symbols!;
        const circuit = Object.entries(symbols).find(([, symbol]) => symbol === clue)![0];
        await pageForRole("Engineer").getByRole("button", { name: `${circuit} ${clue}`, exact: true }).click();
        await expect.poll(() => last.get(pageForRole("Engineer"))?.station.isolated).toBe(circuit);
        await pageForRole("Engineer").getByRole("button", { name: "Vent coolant", exact: true }).click();
        try {
          await expect.poll(() => last.get(pageForRole("Engineer"))?.station.vented).toBe(true);
        } catch (error) {
          throw new Error(`${error instanceof Error ? error.message : error}\nRecent room API failures: ${apiFailures.slice(-12).join(" | ") || "none"}`);
        }
        await pageForRole("Engineer").getByRole("button", { name: "Reset circuit", exact: true }).click();
        await expect.poll(() => last.get(c)?.mission?.repairedAt).toBeTruthy();
      } else {
        const wave = event === "storm-1" ? 0 : 1;
        const commander = last.get(c)!.station;
        await Promise.all([
          c.getByRole("button", { name: commander.sectors![wave], exact: true }).click(),
          pageForRole("Engineer").getByRole("button", { name: "Shield Defensive systems", exact: true }).click(),
          pageForRole("Pilot").getByLabel("TARGET HEADING").fill(String(commander.headings![wave])).then(() =>
            pageForRole("Pilot").getByRole("button", { name: "Set heading" }).click(),
          ),
        ]);
        await expect.poll(() => last.get(c)?.mission?.completedAt[wave], { timeout: 25000 }).toBeTruthy();
      }
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
      expect(page.getByRole("heading", { name: "You brought them home." })).toBeVisible(),
    ));
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
  expect(secondRun.variant.order).not.toEqual(firstRun.variant.order);
  expect(secondRun.startAt).toBeGreaterThan(firstRun.startAt);
  expect(secondRun.phase).toBe(0);
  expect(secondRun.hull).toBe(100);
  expect(secondRun.completedAt).toEqual([null, null]);
  expect(secondRun.repairedAt).toBeNull();
  expect(last.get(c)!.players.map((player) => player.role)).toEqual([
    "Commander", "Pilot", "Engineer",
  ]);
  expect(last.get(pageForRole("Engineer"))!.station.isolated).toBeNull();
  expect(last.get(pageForRole("Engineer"))!.station.vented).toBe(false);
  expect(last.get(pageForRole("Pilot"))!.station.codeEntered).toBe("");
  await expect(pageForRole("Pilot").getByLabel("CODE FROM COMMANDER")).toHaveValue("");
  await expect(pageForRole("Pilot").getByLabel("TARGET HEADING")).toHaveValue("180");
  await completeCurrentMission();
  await c.getByRole("button", { name: /Return to lobby/ }).click();
  await Promise.all(crewPages.map((page) =>
    expect(page.getByRole("heading", { name: "Flight crew" })).toBeVisible(),
  ));

  // Host removal, guest leave/rejoin, and host transfer remain room scoped.
  c.once("dialog", (dialog) => void dialog.accept());
  await c.getByRole("button", { name: "Remove Pilot QA from room" }).click();
  await expect(p.getByRole("heading", { name: "Assemble your crew" })).toBeVisible({ timeout: 15000 });
  await p.getByLabel("YOUR NAME").fill("Pilot QA");
  await p.getByLabel("ROOM CODE").fill(code);
  await p.getByRole("button", { name: "Join room", exact: true }).click();
  await expect(p.locator(".error")).toContainText("removed you from this room");
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
  for (const context of contexts) await context.close();
});
