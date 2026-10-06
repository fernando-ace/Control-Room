<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Control Room rules

- Inspect the current implementation, Git diff, and relevant tests before changing code; follow the goal prompt in `goals/` when assigned from `ROADMAP.json`.
- Preserve server authority: clients never choose identity, time, canonical state, damage, or outcomes. Keep Supabase anonymous-auth assumptions unless the assigned goal explicitly changes them.
- Keep role-private information in server-only state and role-filtered snapshots. Do not weaken privacy, timing, reconnect, retry, or multiplayer guarantees.
- Never reduce assertions or relax acceptance criteria to make checks pass. Preserve deterministic engine behavior where tests rely on it.
- Validate with `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`; run live multiplayer/browser checks for relevant changes when credentials and services are available. Check responsive behavior near 390 px when UI changes.
- Commit completed, reviewed goal work locally. Do not push or deploy unless explicitly asked. Keep commits scoped and preserve unrelated changes.
- If any acceptance criterion cannot be honestly met, report the goal incomplete and identify the missing evidence.
- Feature goals must not change `ROADMAP.json`, `goals/`, `scripts/goals.mjs`, or `docs/AGENT_WORKFLOW.md` unless their prompt explicitly requires it.
