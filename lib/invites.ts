export type RoomInvite =
  | { status: "none" }
  | { status: "valid"; code: string }
  | { status: "invalid" };

const roomCodePattern = /^[A-Z2-9]{6}$/;

export function parseRoomInviteUrl(value: string): RoomInvite {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { status: "invalid" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:")
    return { status: "invalid" };

  const codes = url.searchParams.getAll("room");
  if (codes.length === 0) return { status: "none" };
  if (codes.length !== 1 || url.pathname !== "/")
    return { status: "invalid" };

  const code = codes[0].trim().toUpperCase();
  return roomCodePattern.test(code)
    ? { status: "valid", code }
    : { status: "invalid" };
}

export function createRoomInvite(origin: string, code: string) {
  const url = new URL("/", origin);
  url.searchParams.set("room", code);
  const link = url.toString();
  return { url: link, text: `Join my Control Room crew: ${link}\nRoom code: ${code}` };
}
