import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roadmapPath = path.join(root, "ROADMAP.json");
const safetyValues = new Set(["high", "medium", "low"]);

export function validateRoadmap(roadmap, hasPrompt = () => true) {
  const errors = [];
  if (!roadmap || !Array.isArray(roadmap.goals)) return ["Roadmap must contain a goals array."];
  const ids = new Set();
  for (const goal of roadmap.goals) {
    if (!goal || typeof goal !== "object") { errors.push("Each goal must be an object."); continue; }
    if (typeof goal.id !== "string" || !/^CR-\d{2}$/.test(goal.id)) errors.push(`Invalid goal ID: ${goal.id}`);
    if (ids.has(goal.id)) errors.push(`Duplicate goal ID: ${goal.id}`);
    ids.add(goal.id);
    if (typeof goal.title !== "string" || !goal.title.trim()) errors.push(`${goal.id}: title is required.`);
    if (!Array.isArray(goal.dependsOn) || goal.dependsOn.some((d) => typeof d !== "string")) errors.push(`${goal.id}: dependsOn must be an array of IDs.`);
    if (!Number.isInteger(goal.priority) || goal.priority < 1) errors.push(`${goal.id}: priority must be a positive integer.`);
    if (!safetyValues.has(goal.parallelSafety)) errors.push(`${goal.id}: invalid parallelSafety.`);
    if (typeof goal.cloudSafe !== "boolean") errors.push(`${goal.id}: cloudSafe must be boolean.`);
    if (!Array.isArray(goal.touches) || goal.touches.length === 0 || goal.touches.some((p) => typeof p !== "string" || !p)) errors.push(`${goal.id}: touches must be a non-empty string array.`);
    if (typeof goal.prompt !== "string" || !hasPrompt(goal.prompt)) errors.push(`${goal.id}: missing prompt file ${goal.prompt ?? ""}.`);
    if (typeof goal.completed !== "boolean") errors.push(`${goal.id}: completed must be boolean.`);
  }
  for (const goal of roadmap.goals) {
    for (const dependency of Array.isArray(goal?.dependsOn) ? goal.dependsOn : []) {
      if (!ids.has(dependency)) errors.push(`${goal.id}: unknown dependency ${dependency}.`);
      if (dependency === goal.id) errors.push(`${goal.id}: cannot depend on itself.`);
    }
  }
  const byId = new Map(roadmap.goals.filter((g) => g && typeof g.id === "string").map((g) => [g.id, g]));
  const visiting = new Set();
  const visited = new Set();
  function visit(id, chain = []) {
    if (visiting.has(id)) { errors.push(`Dependency cycle: ${[...chain, id].join(" -> ")}.`); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) if (byId.has(dependency)) visit(dependency, [...chain, id]);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of byId.keys()) visit(id);
  return [...new Set(errors)];
}

export function parseRoadmap(source, hasPrompt = () => true) {
  let roadmap;
  try {
    roadmap = JSON.parse(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { roadmap: null, errors: [`Roadmap is not valid JSON: ${detail}`] };
  }
  return { roadmap, errors: validateRoadmap(roadmap, hasPrompt) };
}

export function readyGoals(goals) {
  const byId = new Map(goals.map((g) => [g.id, g]));
  return goals.filter((g) => !g.completed && g.dependsOn.every((id) => byId.get(id)?.completed === true));
}

export function blockers(goal, goals) {
  const byId = new Map(goals.map((g) => [g.id, g]));
  return goal.dependsOn.filter((id) => byId.get(id)?.completed !== true);
}

function patternsOverlap(a, b) {
  const normalize = (p) => p.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\*.*$/, "").replace(/\/$/, "");
  const x = normalize(a), y = normalize(b);
  if (!x || !y) return true;
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

export function recommendLanes(goals, limit = 3) {
  const available = readyGoals(goals).sort((a, b) => a.priority - b.priority);
  const primary = available.find((g) => g.parallelSafety === "low") ?? null;
  const candidates = available
    .filter((g) => g.parallelSafety === "high" || g.parallelSafety === "medium")
    .sort((a, b) => safetyRank(a.parallelSafety) - safetyRank(b.parallelSafety) || a.priority - b.priority);
  const selected = [];
  const parallelSlots = Math.max(0, limit - (primary ? 1 : 0));
  for (const goal of candidates) {
    if (selected.length >= parallelSlots) break;
    if (primary && goal.touches.some((p) => primary.touches.some((q) => patternsOverlap(p, q)))) continue;
    if (selected.some((other) => goal.touches.some((p) => other.touches.some((q) => patternsOverlap(p, q))))) continue;
    selected.push(goal);
    if (selected.length >= parallelSlots) break;
  }
  return { primary: primary ?? selected.shift() ?? null, parallel: selected };
}

function safetyRank(safety) { return safety === "high" ? 0 : safety === "medium" ? 1 : 2; }

export function worktreePlan(goal, repoRoot, options = {}) {
  const slug = goal.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const branch = `goal/${goal.id}-${slug}`;
  const parent = path.dirname(repoRoot);
  const repoName = path.basename(repoRoot);
  const target = path.join(parent, `${repoName}-${goal.id.toLowerCase()}`);
  return { branch, target, dryRun: options.dryRun === true };
}

export function worktreeGitArgs(plan) {
  return ["worktree", "add", "-b", plan.branch, plan.target, "HEAD"];
}

function runGit(args) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
}

function loadRoadmap() {
  const parsed = parseRoadmap(readFileSync(roadmapPath, "utf8"), (prompt) => existsSync(path.join(root, prompt)));
  if (parsed.errors.length) throw new Error(parsed.errors.join("\n"));
  return parsed.roadmap;
}
function getGoal(roadmap, id) { return roadmap.goals.find((goal) => goal.id === id); }

function printStatus(roadmap) {
  const ready = new Set(readyGoals(roadmap.goals).map((g) => g.id));
  for (const goal of roadmap.goals) {
    if (goal.completed) console.log(`DONE     ${goal.id} ${goal.title}`);
    else if (ready.has(goal.id)) console.log(`READY    ${goal.id} ${goal.title}`);
    else console.log(`BLOCKED  ${goal.id} ${goal.title} — waiting for ${blockers(goal, roadmap.goals).join(", ")}`);
  }
}

function main(args) {
  const [command, ...rest] = args;
  if (!command || !["validate", "status", "ready", "prompt", "complete", "worktree"].includes(command)) throw new Error("Usage: goals.mjs <validate|status|ready|prompt|complete|worktree> [ID] [dry-run|reviewed]");
  const roadmap = loadRoadmap();
  const errors = validateRoadmap(roadmap, (prompt) => existsSync(path.join(root, prompt)));
  if (errors.length && command !== "validate") throw new Error(`Roadmap is invalid:\n${errors.join("\n")}`);
  if (command === "validate") {
    if (errors.length) throw new Error(errors.join("\n"));
    console.log(`Roadmap valid: ${roadmap.goals.length} goals, no unknown dependencies or cycles.`);
  } else if (command === "status") printStatus(roadmap);
  else if (command === "ready") {
    const ready = readyGoals(roadmap.goals).sort((a, b) => a.priority - b.priority);
    console.log(`READY NOW (${ready.length})`);
    for (const goal of ready) console.log(`  ${goal.id} ${goal.title} [${goal.parallelSafety}; cloud ${goal.cloudSafe ? "yes" : "no"}]`);
    const lanes = recommendLanes(roadmap.goals);
    console.log("\nSuggested lanes (advisory; declared paths cannot guarantee conflict-free work)");
    if (!lanes.primary && lanes.parallel.length === 0) console.log("  No goals are ready.");
    if (lanes.primary) console.log(`  PRIMARY LOCAL\n  ${lanes.primary.id} ${lanes.primary.title}`);
    for (const goal of lanes.parallel) console.log(`  ${goal.cloudSafe ? "CLOUD" : "WORKTREE"}\n  ${goal.id} ${goal.title}`);
  } else {
    const id = rest.find((x) => !x.startsWith("--"));
    const goal = getGoal(roadmap, id);
    if (!goal) throw new Error(`Unknown goal ID: ${id ?? "(missing)"}`);
    if (command === "prompt") console.log(readFileSync(path.join(root, goal.prompt), "utf8"));
    if (command === "complete") {
      if (goal.completed) throw new Error(`${id} is already complete.`);
      if (blockers(goal, roadmap.goals).length) throw new Error(`Cannot complete ${id}; dependencies remain incomplete: ${blockers(goal, roadmap.goals).join(", ")}.`);
      // npm reserves hyphen-prefixed flags; use `reviewed` as the documented npm token.
      if (!rest.includes("--reviewed") && !rest.includes("reviewed")) throw new Error("Completion requires the reviewed token after the work is reviewed and integrated.");
      const status = runGit(["status", "--porcelain"]);
      if (status.status !== 0) throw new Error(status.stderr || "Could not read Git status.");
      if (status.stdout.trim()) throw new Error("Working tree must be clean after integration before marking a goal complete.");
      goal.completed = true;
      writeFileSync(roadmapPath, `${JSON.stringify(roadmap, null, 2)}\n`);
      console.log(`${id} marked complete after review/integration.`);
    }
    if (command === "worktree") {
      if (goal.completed) throw new Error(`${id} is already complete.`);
      const missing = blockers(goal, roadmap.goals);
      if (missing.length) throw new Error(`${id} is blocked by: ${missing.join(", ")}.`);
      // npm consumes --dry-run as its own flag; accept a positional `dry-run` token too.
      const dryRun = rest.includes("--dry-run") || rest.includes("dry-run");
      const plan = worktreePlan(goal, root, { dryRun });
      console.log(`Branch: ${plan.branch}\nWorktree: ${plan.target}\nPrompt: ${path.join(root, goal.prompt)}\nSecrets: configure environment variables separately; none are copied.`);
      if (plan.dryRun) console.log("Dry run: no Git changes made.");
      else {
        if (existsSync(plan.target)) throw new Error(`Refusing to use existing path: ${plan.target}`);
        const branchCheck = runGit(["show-ref", "--verify", "--quiet", `refs/heads/${plan.branch}`]);
        if (branchCheck.status === 0) throw new Error(`Refusing to reuse existing branch: ${plan.branch}`);
        if (branchCheck.status !== 1) throw new Error(branchCheck.stderr || "Could not check branch name.");
        mkdirSync(path.dirname(plan.target), { recursive: true });
        const result = runGit(worktreeGitArgs(plan));
        if (result.status !== 0) throw new Error(result.stderr || result.stdout || "git worktree add failed.");
        console.log("Worktree created. The source worktree's uncommitted changes are not included.");
      }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
