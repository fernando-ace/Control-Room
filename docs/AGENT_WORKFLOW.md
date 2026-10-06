# Control Room goal workflow

The roadmap in `ROADMAP.json` lists independent goals and their dependencies. A goal is READY when it is incomplete and every dependency is complete. Path declarations are advisory; agents still need to inspect diffs and coordinate.

```sh
npm run goals:validate
npm run goals:status
npm run goals:ready
```

Use `npm run goals:prompt -- CR-02` to print a self-contained prompt. Start a READY goal in a sibling Git worktree with `npm run goals:worktree -- CR-02`; use `npm run goals:worktree -- CR-02 dry-run` to inspect the branch and path without creating anything (`npm` reserves its own `--dry-run` flag). Worktrees do not receive uncommitted changes or environment secrets; configure required environment variables separately. The helper never pushes.

Suggested human workflow:

1. Check status and READY goals.
2. Start up to three compatible lanes: primary local, isolated worktree, and Codex Cloud where the goal is marked cloud-safe.
3. Let each goal finish independently and review its diff, evidence, and local commit.
4. Integrate accepted branches and resolve conflicts.
5. Mark a goal complete only after it has been reviewed and integrated: ensure the integrated worktree is clean, then run `npm run goals:complete -- CR-02 reviewed`. Commit the resulting `ROADMAP.json` completion update locally.
6. Run CR-08 when the parallel feature batch converges, then CR-09 for adversarial verification.
7. Start the next READY batch.

The repository tooling prepares prompts and identifies suitable candidates; it does not launch Codex Cloud tasks. Before stopping overnight, choose a READY cloud-safe goal whose definition of done can be validated without interactive decisions, then start that task yourself.

## Current first batch

Initially, CR-01, CR-02, CR-03, and CR-07 are READY. The first recommendation pairs CR-01 in the primary local lane with CR-02 in a cloud lane: their declared paths are separate, and CR-02 avoids authoritative game rules. CR-03 and CR-07 touch UI files shared with CR-02, so the static overlap check leaves them out of this batch. Review actual diffs and coordinate before starting additional work; path declarations cannot prove compatibility.
