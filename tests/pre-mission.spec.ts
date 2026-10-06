import { expect, test } from "@playwright/test";

test("crew can create, join, coordinate, and enter the role briefing", async ({
  browser,
}) => {
  test.setTimeout(90000);
  const contexts = await Promise.all(
    [0, 1, 2, 3].map(() => browser.newContext()),
  );
  const [commander, pilot, engineer, challenger] = await Promise.all(
    contexts.map((context) => context.newPage()),
  );
  const crew = [commander, pilot, engineer];
  const observedRoles = new Map<
    (typeof crew)[number],
    string
  >();
  for (const page of crew) {
    page.on("response", async (response) => {
      if (!response.url().endsWith("/api/room") || !response.ok()) return;
      try {
        const snapshot = await response.json();
        observedRoles.set(
          page,
          snapshot.players
            .map((player: { name: string; role: string }) => `${player.name}:${player.role}`)
            .join(" | "),
        );
      } catch {
        // Some responses may detach while independent contexts are closing.
      }
    });
  }

  try {
    for (const [index, page] of [
      commander,
      pilot,
      engineer,
      challenger,
    ].entries()) {
      await page.setViewportSize({ width: 1365, height: 900 });
      await page.goto("/");
      await expect(
        page.getByRole("heading", { name: "Three stations. One chance to survive." }),
      ).toBeVisible();
      await expect(
        page.getByText("No account needed. Your name and a six-character code are all you need.", { exact: true }),
      ).toBeVisible();
      if (index === 3) {
        await page.keyboard.press("Tab");
        await page.keyboard.press("Tab");
        await page.keyboard.press("Tab");
        await expect(page.getByLabel("YOUR NAME")).toBeFocused();
        await page.keyboard.type("Challenger QA");
        await page.keyboard.press("Tab");
        await expect(page.getByRole("button", { name: "Create room" })).toBeFocused();
      } else {
        await page.getByLabel("YOUR NAME").fill(
          ["Commander QA", "Pilot QA", "Engineer QA"][index],
        );
      }
      await expect(page.getByRole("button", { name: "Create room" })).toBeEnabled({
        timeout: 30000,
      });
    }

    await commander.getByRole("button", { name: "Create room" }).click();
    await expect(
      commander.getByRole("heading", { name: "Flight crew" }),
    ).toBeVisible();
    const roomCode = await commander.locator(".room-code b").innerText();
    await commander.context().grantPermissions([
      "clipboard-read",
      "clipboard-write",
    ]);
    await commander.getByRole("button", { name: "Copy room code" }).click();
    await expect(
      commander.getByRole("status").filter({ hasText: "Copied!" }),
    ).toBeVisible();

    for (const [page, name] of [
      [pilot, "Pilot QA"],
      [engineer, "Engineer QA"],
    ] as const) {
      await page.getByLabel("YOUR NAME").fill(name);
      await page.getByLabel("ROOM CODE").fill(roomCode.toLowerCase());
      await expect(page.getByLabel("ROOM CODE")).toHaveValue(roomCode);
      await page.getByRole("button", { name: "Join room" }).click();
      await expect(page.getByRole("heading", { name: "Flight crew" })).toBeVisible();
    }

    for (const page of crew) {
      await expect(page.locator(".seat")).toHaveCount(3);
      await expect(page.locator(".briefing h1")).toHaveText(
        page === commander ? "Commander" : page === pilot ? "Pilot" : "Engineer",
      );
      await expect(page.getByRole("heading", { name: "Your Job" })).toBeVisible();
    }
    await expect(commander.locator(".seat").filter({ hasText: "Commander QA" })).toContainText("HOST");
    await expect(commander.locator(".seat").filter({ hasText: "Commander QA" })).toContainText("YOU");

    const pilotSeat = commander.locator(".seat").filter({ hasText: "Pilot QA" });
    await pilotSeat.getByRole("button", { name: "Swap role with Pilot QA" }).click();
    await expect.poll(() => observedRoles.get(commander) ?? "").toContain("Pilot QA:Commander");
    await expect(commander.locator(".error")).toHaveCount(0);
    await expect.poll(() => observedRoles.get(pilot) ?? "").toContain("Pilot QA:Commander");
    await expect(pilot.locator(".briefing h1")).toHaveText("Commander");
    await pilotSeat.getByRole("button", { name: "Swap role with Pilot QA" }).click();
    await expect(pilot.locator(".briefing h1")).toHaveText("Pilot");

    await commander.setViewportSize({ width: 768, height: 1024 });
    let dimensions = await commander.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    }));
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
    await commander.setViewportSize({ width: 390, height: 844 });
    dimensions = await commander.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    }));
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
    await expect(
      commander.getByRole("button", { name: "Remove Pilot QA from room" }),
    ).toBeVisible();

    await engineer.getByRole("button", { name: "Leave room" }).click();
    await expect(engineer.getByRole("button", { name: "Create room" })).toBeVisible();
    await expect(
      commander.locator(".seat").filter({ hasText: "Open station" }),
    ).toContainText("Engineer");
    await challenger.getByLabel("ROOM CODE").fill(roomCode.toLowerCase());
    await expect(challenger.getByLabel("ROOM CODE")).toHaveValue(roomCode);
    await challenger.keyboard.press("Tab");
    await expect(challenger.getByRole("button", { name: "Join room" })).toBeFocused();
    await challenger.keyboard.press("Enter");
    await expect(challenger.getByRole("heading", { name: "Flight crew" })).toBeVisible();
    await expect(
      commander.locator(".seat").filter({ hasText: "Challenger QA" }),
    ).toContainText("Engineer");

    await Promise.all(
      [commander, pilot, challenger].map((page) =>
        page.getByRole("button", { name: "Mark station ready" }).click(),
      ),
    );
    await expect(commander.locator(".lobby-waiting")).toContainText(
      "All three stations are ready",
    );
    await expect(
      commander.getByRole("button", { name: "Launch Solar Storm" }),
    ).toBeEnabled();
    await commander.getByRole("button", { name: "Launch Solar Storm" }).click();
    for (const page of [commander, pilot, challenger]) {
      await expect(page.locator(".mission-brief")).toBeVisible();
      await expect(page.locator(".mission-brief")).toContainText("YOUR JOB");
    }
    await expect(commander.locator(".mission-brief")).toContainText("YOUR JOB · Commander");
    await expect(pilot.locator(".mission-brief")).toContainText("YOUR JOB · Pilot");
    await expect(challenger.locator(".mission-brief")).toContainText("YOUR JOB · Engineer");

    commander.once("dialog", (dialog) => dialog.accept());
    await commander.getByRole("button", { name: "Remove Challenger QA from room" }).click();
    await expect(challenger.getByRole("button", { name: "Create room" })).toBeVisible({ timeout: 15000 });
    await expect(challenger.locator(".error")).toContainText(
      "You were removed from this room and can’t rejoin it.",
      { timeout: 15000 },
    );
    await challenger.getByRole("button", { name: "Join room" }).click();
    await expect(challenger.locator(".error")).toContainText(
      "You were removed from this room and can’t rejoin it.",
      { timeout: 15000 },
    );
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
