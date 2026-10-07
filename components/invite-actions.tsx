"use client";

import { useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { createRoomInvite } from "@/lib/invites";

export default function InviteActions({ code }: { code: string }) {
  const [copied, setCopied] = useState<"invite" | "code" | null>(null);
  const [copyUnavailable, setCopyUnavailable] = useState(false);
  const resetTimer = useRef<number | undefined>(undefined);

  const copy = async (kind: "invite" | "code") => {
    const value =
      kind === "invite"
        ? createRoomInvite(window.location.origin, code).text
        : code;
    try {
      await navigator.clipboard.writeText(value);
      setCopyUnavailable(false);
      setCopied(kind);
      window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => setCopied(null), 2200);
    } catch {
      setCopied(null);
      setCopyUnavailable(true);
    }
  };

  return (
    <div className="invite-actions">
      <button className="primary" onClick={() => void copy("invite")}>
        {copied === "invite" ? <Check size={18} /> : <Copy size={18} />}
        {copied === "invite" ? "Invite copied" : "Copy Invite"}
      </button>
      <button onClick={() => void copy("code")}>
        {copied === "code" ? <Check size={18} /> : <Copy size={18} />}
        {copied === "code" ? "Room code copied" : "Copy room code"}
      </button>
      {(copied || copyUnavailable) && (
        <span className="invite-feedback" role="status" aria-live="polite">
          {copyUnavailable
            ? `Copy unavailable. Share room code ${code}.`
            : copied === "invite"
              ? "Invite copied"
              : "Room code copied"}
        </span>
      )}
    </div>
  );
}
