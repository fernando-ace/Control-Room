import { expect, test, Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import type { Snapshot } from "../lib/types";
process.loadEnvFile(".env.local");

type ApiResult = { status: number; body: Record<string, unknown> };
// This suite requires real Supabase credentials and runs at real mission speed.
// It deliberately has no test-clock override or production debug endpoint.
test("three independent sessions complete Solar Storm, reconnect, fail, and retry", async ({
  browser,
}) => {
  const contexts = await Promise.all([0, 1, 2, 3].map(() => browser.newContext()));
  const pages = await Promise.all(contexts.map((c) => c.newPage()));
  const [c, p, e] = pages;
  const crewPages = [c, p, e];
  const last = new Map<Page, Snapshot>();
  const startSnapshots = new Map<number, Snapshot>();
  const realtimePages = new Set<Page>();
  for (const [index, page] of pages.entries()) {
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
    await page.goto("/");
    await expect(
      page.getByText(
        "No account needed. Your name and a six-character code are all you need.",
        { exact: true },
      ),
    ).toBeVisible({ timeout: 30000 });
    if (index === 3) {
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await expect(page.getByLabel("YOUR NAME")).toBeFocused();
      await page.keyboard.type("Fourth QA");
    } else {
      await page
        .getByLabel("YOUR NAME")
        .fill(["Commander QA", "Pilot QA", "Engineer QA"][index]);
    }
    await expect(page.getByRole("button", { name: /Create room/ })).toBeEnabled({
      timeout: 30000,
    });
  }
  await c.getByLabel("YOUR NAME").fill("Commander QA");
  await expect(c.getByRole("button", { name: /Create room/ })).toBeEnabled();
  await c.getByRole("button", { name: /Create room/ }).click();
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
  await pages[3].keyboard.press("Tab");
  await expect(
    pages[3].getByRole("button", { name: "Create room" }),
  ).toBeFocused();
  await pages[3].keyboard.press("Tab");
  await expect(pages[3].getByLabel("ROOM CODE")).toBeFocused();
  await pages[3].keyboard.type(code.toLowerCase());
  await expect(pages[3].getByLabel("ROOM CODE")).toHaveValue(code);
  await pages[3].keyboard.press("Tab");
  await expect(
    pages[3].getByRole("button", { name: "Join room" }),
  ).toBeFocused();
  await pages[3].keyboard.press("Enter");
  await expect(pages[3].locator(".error")).toContainText(
    "That room already has three players.",
  );
  await expect
    .poll(() => last.get(c)?.players.length, { timeout: 8000, intervals: [250] })
    .toBe(3);

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
  const outsider = apiClient(await tokenFor(pages[3]));
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
  expect(outsiderRoom.error).toBeNull();
  expect(outsiderRoom.data).toEqual([]);
  expect(outsiderMembership.error).toBeNull();
  expect(outsiderMembership.data).toEqual([]);
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
  const postActions = (
    page: Page,
    actions: Array<{ type: string; value?: string | number | boolean }>,
  ): Promise<ApiResult[]> =>
    page.evaluate(async (sequence) => {
      const key = Object.keys(localStorage).find(
        (candidate) =>
          candidate.startsWith("sb-") && candidate.endsWith("-auth-token"),
      );
      if (!key) throw new Error("Anonymous session storage was not found");
      const accessToken = JSON.parse(localStorage.getItem(key)!).access_token;
      const results: ApiResult[] = [];
      for (const action of sequence) {
        const response = await fetch("/api/room", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            op: "action",
            code: localStorage.getItem("cr-room"),
            actionId: crypto.randomUUID(),
            action,
          }),
        });
        results.push({ status: response.status, body: await response.json() });
      }
      return results;
    }, actions);

  // Exercise host swapping, then restore the original stations.
  await c
    .locator(".seat")
    .filter({ hasText: "Pilot QA" })
    .getByRole("button", { name: "Swap role" })
    .click();
  await expect(p.locator(".briefing h1")).toHaveText("Commander");
  await c
    .locator(".seat")
    .filter({ hasText: "Pilot QA" })
    .getByRole("button", { name: "Swap role" })
    .click();
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
      p.getByRole("heading", { name: "Navigation", exact: true }),
    ).toBeVisible();
    for (const page of crewPages) {
      await expect(page.locator(".mission-brief")).toBeVisible();
      await expect(page.locator(".mission-brief")).toContainText("YOUR JOB");
      await expect(page.locator(".objective-list")).toContainText("ACTIVE");
      await expect(page.getByText("NEEDS CREW")).toBeVisible();
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
  await e.setViewportSize({ width: 390, height: 844 });
  const mobileWidth = await e.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(mobileWidth.content).toBeLessThanOrEqual(mobileWidth.viewport);
  await e.screenshot({ path: "test-results/onboarding-engineer-mobile.png", fullPage: true });
  await e.setViewportSize({ width: 1280, height: 800 });
  const start = last.get(c)!.mission!.startAt;
  await expect.poll(() => startSnapshots.has(start)).toBe(true);
  expect(startSnapshots.get(start)!.mission!.serverNow).toBe(start);
  expect(last.get(c)!.station.code).toBeDefined();
  expect(last.get(c)!.station.headings).toBeDefined();
  expect(last.get(c)!.station.symbols).toBeUndefined();
  expect(last.get(c)!.station.target).toBeUndefined();
  expect(last.get(p)!.station.code).toBeUndefined();
  expect(last.get(p)!.station.headings).toBeUndefined();
  expect(last.get(p)!.station.symbols).toBeUndefined();
  expect(last.get(p)!.station.heading).toBeDefined();
  expect(last.get(e)!.station.code).toBeUndefined();
  expect(last.get(e)!.station.headings).toBeUndefined();
  expect(last.get(e)!.station.heading).toBeUndefined();
  expect(last.get(p)!.station.symbols).toBeUndefined();
  expect(last.get(e)!.station.headings).toBeUndefined();
  await p.reload();
  await expect(
    p.getByRole("heading", { name: "Navigation", exact: true }),
  ).toBeVisible();
  expect(last.get(p)!.players.find((x) => x.id === last.get(p)!.me)!.role).toBe(
    "Pilot",
  );
  const beforeConcurrent = last.get(c)!.revision;
  const [, , forgedAction] = await Promise.all([
    c.getByRole("button", { name: "Port", exact: true }).click(),
    e
      .getByRole("button", { name: "Shield Defensive systems", exact: true })
      .click(),
    postAction(
      p,
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
  expect((forgedAction.body as Snapshot).me).toBe(last.get(p)!.me);
  expect((forgedAction.body as Snapshot).mission?.result).toBeNull();
  expect((forgedAction.body as Snapshot).mission?.hull).toBeGreaterThan(0);
  expect((forgedAction.body as Snapshot).revision).toBeGreaterThan(
    beforeConcurrent,
  );
  await expect.poll(() => realtimePages.size, { timeout: 12000 }).toBeGreaterThan(0);
  await expect
    .poll(() => typeof last.get(c)?.mission?.completedAt[0], { timeout: 30000 })
    .toBe("number");
  expect(last.get(c)!.mission!.hull).toBeGreaterThan(95);
  const waitUntil = async (seconds: number) => {
    await expect
      .poll(() => last.get(c)?.mission?.serverNow, { timeout: 160000, intervals: [1000] })
      .toBeGreaterThanOrEqual(start + seconds * 1000);
  };
  await waitUntil(51);
  await expect(e.getByRole("button", { name: /A ○/ })).toBeEnabled();
  const symbol = last.get(c)!.station.brokenSymbol!;
  const circuit = Object.entries(last.get(e)!.station.symbols!).find(
    ([, s]) => s === symbol,
  )![0];
  const wrongCircuit = Object.keys(last.get(e)!.station.symbols!).find(
    (candidate) => candidate !== circuit,
  )!;
  const hullBeforeWrongReset = last.get(c)!.mission!.hull;
  await e
    .getByRole("button", {
      name: `${wrongCircuit} ${last.get(e)!.station.symbols![wrongCircuit]}`,
      exact: true,
    })
    .click();
  await expect
    .poll(() => last.get(e)?.station.isolated, { timeout: 12000 })
    .toBe(wrongCircuit);
  await e.getByRole("button", { name: "Vent coolant", exact: true }).click();
  await expect
    .poll(() => last.get(e)?.station.vented, { timeout: 12000 })
    .toBe(true);
  const wrongReset = await postAction(e, "live-wrong-reset-qa", {
    type: "reset",
  });
  expect(wrongReset.status).toBe(200);
  const hullAfterWrongReset = (wrongReset.body as Snapshot).mission!.hull;
  expect(hullAfterWrongReset).toBeCloseTo(hullBeforeWrongReset - 10, 0);
  const [cooldownIsolate, cooldownVent, cooldownReset] = await postActions(e, [
    { type: "isolate", value: wrongCircuit },
    { type: "vent" },
    { type: "reset" },
  ]);
  expect(cooldownIsolate.status).toBe(200);
  expect(cooldownVent.status).toBe(200);
  expect(cooldownReset.status).toBe(400);
  expect(cooldownReset.body.error).toContain("Reset cooling down");
  const duplicateReset = await postAction(e, "live-wrong-reset-qa", {
    type: "reset",
  });
  expect(duplicateReset.status).toBe(200);
  expect((duplicateReset.body as Snapshot).mission!.hull).toBe(
    hullAfterWrongReset,
  );
  await waitUntil(55);
  await e
    .getByRole("button", { name: `${circuit} ${symbol}`, exact: true })
    .click();
  await expect
    .poll(() => last.get(e)?.station.isolated, { timeout: 12000 })
    .toBe(circuit);
  await e.getByRole("button", { name: "Vent coolant", exact: true }).click();
  await expect
    .poll(() => last.get(e)?.station.vented, { timeout: 12000 })
    .toBe(true);
  await e.getByRole("button", { name: "Reset circuit", exact: true }).click();
  await expect
    .poll(() => typeof last.get(c)?.mission?.repairedAt)
    .toBe("number");
  await waitUntil(91);
  await Promise.all([
    c.getByRole("button", { name: "Starboard", exact: true }).click(),
    p
      .getByLabel("TARGET HEADING")
      .fill("60")
      .then(() => p.getByRole("button", { name: "Set heading" }).click()),
  ]);
  await expect
    .poll(() => typeof last.get(c)?.mission?.completedAt[1], { timeout: 25000 })
    .toBe("number");
  await waitUntil(131);
  await expect(
    c.getByRole("button", { name: "Authorize departure" }),
  ).toBeEnabled();
  await Promise.all([
    e
      .getByRole("button", { name: "Engines Escape propulsion", exact: true })
      .click(),
    p
      .getByLabel("TARGET HEADING")
      .fill("180")
      .then(() => p.getByRole("button", { name: "Set heading" }).click()),
    c.getByRole("button", { name: "Authorize departure" }).click(),
  ]);
  await p.getByLabel("CODE FROM COMMANDER").fill(last.get(c)!.station.code!);
  await p.getByRole("button", { name: "Enter code", exact: true }).click();
  await expect.poll(() => last.get(p)?.station.heading).toBeCloseTo(180, 0);
  await p.getByRole("button", { name: /Initiate escape/ }).click();
  await Promise.all(
    crewPages.map((page) =>
      expect(
        page.getByRole("heading", { name: "You brought them home." }),
      ).toBeVisible(),
    ),
  );
  await c.getByRole("button", { name: /Return to lobby/ }).click();
  await Promise.all(
    crewPages.map((page) =>
      expect(page.getByRole("heading", { name: "Flight crew" })).toBeVisible(),
    ),
  );
  await ready();
  await Promise.all(
    crewPages.map((page) =>
      expect(
        page.getByRole("heading", { name: "The storm won this time." }),
      ).toBeVisible({ timeout: 155000 }),
    ),
  );
  const failedCode = last.get(c)!.station.code;
  const failedSymbol = last.get(c)!.station.brokenSymbol;
  const failedMissionStart = last.get(c)!.mission!.startAt;
  await c.getByRole("button", { name: /Return to lobby/ }).click();
  await Promise.all(
    crewPages.map((page) =>
      expect(page.getByRole("heading", { name: "Flight crew" })).toBeVisible(),
    ),
  );
  await ready();
  expect(last.get(c)!.mission!.startAt).toBeGreaterThan(failedMissionStart);
  expect(last.get(c)!.station.code).toMatch(/^\d{4}$/);
  expect(last.get(c)!.station.brokenSymbol).toMatch(/^(○|△|□)$/);
  expect(failedCode).toMatch(/^\d{4}$/);
  expect(failedSymbol).toMatch(/^(○|△|□)$/);
  for (const context of contexts) await context.close();
});
