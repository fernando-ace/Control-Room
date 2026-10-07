import { describe, expect, it } from "vitest";
import { createRoomInvite, parseRoomInviteUrl } from "../lib/invites";

describe("room invites", () => {
  it("parses a room code from a shareable URL", () => {
    expect(parseRoomInviteUrl("https://control.example/?room=abc234")).toEqual({
      status: "valid",
      code: "ABC234",
    });
  });

  it.each([
    "not a URL",
    "javascript://example/?room=ABC234",
    "https://control.example/?room=ABC12",
    "https://control.example/?room=ABC234&room=DEF456",
    "https://control.example/other?room=ABC234",
  ])("rejects malformed invite URL %s", (url) => {
    expect(parseRoomInviteUrl(url)).toEqual({ status: "invalid" });
  });

  it("distinguishes a regular landing page from an invite URL", () => {
    expect(parseRoomInviteUrl("https://control.example/")).toEqual({
      status: "none",
    });
  });

  it("creates a shareable link and a ready-to-send invite message", () => {
    expect(createRoomInvite("https://control.example", "ABC234")).toEqual({
      url: "https://control.example/?room=ABC234",
      text: "Join my Control Room crew: https://control.example/?room=ABC234\nRoom code: ABC234",
    });
  });
});
