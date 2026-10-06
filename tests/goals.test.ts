import { describe, expect, it } from "vitest";
import { blockers, parseRoadmap, readyGoals, recommendLanes, validateRoadmap, worktreeGitArgs, worktreePlan } from "../scripts/goals.mjs";
import { readFileSync } from "node:fs";

const goal = (id: string, extra: Record<string, unknown> = {}) => ({
  id, title: id, dependsOn: [], priority: Number(id.slice(-2)), parallelSafety: "medium",
  cloudSafe: true, touches: [`${id.toLowerCase()}/**`], prompt: `${id}.md`, completed: false, ...extra,
});

describe("goal roadmap", () => {
  it("parses JSON roadmap text and reports invalid JSON", () => {
    expect(parseRoadmap(JSON.stringify({ goals: [goal("CR-01")] })).errors).toEqual([]);
    expect(parseRoadmap("{not-json").errors[0]).toContain("not valid JSON");
  });

  it("provides a self-contained prompt with required sections for every roadmap goal", () => {
    const source = readFileSync(new URL("../ROADMAP.json", import.meta.url), "utf8");
    const parsed = parseRoadmap(source);
    expect(parsed.errors).toEqual([]);
    for (const roadmapGoal of parsed.roadmap.goals) {
      const prompt = readFileSync(new URL(`../${roadmapGoal.prompt}`, import.meta.url), "utf8");
      for (const section of ["Objective and context", "Dependencies", "Invariants", "Scope", "Non-goals", "Definition of done", "Validation and completion"]) {
        expect(prompt, `${roadmapGoal.id} missing ${section}`).toContain(`## ${section}`);
      }
      expect(prompt.toLowerCase()).toContain("inspect");
      expect(prompt.toLowerCase()).toContain("filenames");
      expect(prompt.toLowerCase()).toMatch(/weaken|reduce assertions/);
      expect(prompt.toLowerCase()).toContain("incomplete");
      expect(prompt.toLowerCase()).toContain("report");
      expect(prompt.toLowerCase()).toContain("commit");
      expect(prompt.toLowerCase()).toContain("do not push or deploy");
      expect(prompt.toLowerCase()).toContain("roadmap");
    }
  });

  it("validates unique IDs, prompts, dependencies, and safety values", () => {
    const roadmap = { goals: [goal("CR-01"), goal("CR-02", { dependsOn: ["CR-01"] })] };
    expect(validateRoadmap(roadmap)).toEqual([]);
    expect(validateRoadmap({ goals: [goal("CR-01"), goal("CR-01")] })).toContain("Duplicate goal ID: CR-01");
    expect(validateRoadmap({ goals: [goal("CR-01", { dependsOn: ["CR-99"], parallelSafety: "unsafe" })] }).join(" "))
      .toContain("unknown dependency CR-99");
    expect(validateRoadmap({ goals: [goal("CR-01")] }, () => false).join(" ")).toContain("missing prompt file");
  });

  it("finds dependency cycles", () => {
    const errors = validateRoadmap({ goals: [goal("CR-01", { dependsOn: ["CR-02"] }), goal("CR-02", { dependsOn: ["CR-01"] })] });
    expect(errors.some((error) => error.includes("Dependency cycle"))).toBe(true);
  });

  it("derives readiness and blockers from completion state", () => {
    const goals = [goal("CR-01"), goal("CR-02", { dependsOn: ["CR-01"] }), goal("CR-03", { completed: true })];
    expect((readyGoals(goals) as typeof goals).map((g) => g.id)).toEqual(["CR-01"]);
    expect(blockers(goals[1], goals)).toEqual(["CR-01"]);
    goals[0].completed = true;
    expect((readyGoals(goals) as typeof goals).map((g) => g.id)).toEqual(["CR-02"]);
  });

  it("recommends a conservative batch and excludes overlapping paths", () => {
    const goals = [
      goal("CR-02", { priority: 2, parallelSafety: "medium", touches: ["components/**"] }),
      goal("CR-03", { priority: 3, cloudSafe: false, touches: ["components/control-room.tsx"] }),
      goal("CR-04", { priority: 4, parallelSafety: "high", touches: ["docs/**"] }),
    ];
    const lanes = recommendLanes(goals);
    expect(lanes.primary?.id).toBe("CR-04");
    expect(lanes.parallel.map((g) => g.id)).toEqual(["CR-02"]);
    const coreLanes = recommendLanes([goal("CR-01", { parallelSafety: "low" }), ...goals]);
    expect(coreLanes.primary?.id).toBe("CR-01");
    expect(coreLanes.parallel.map((g) => g.id)).toEqual(["CR-04", "CR-02"]);
    const conflictingCore = recommendLanes([
      goal("CR-01", { parallelSafety: "low", touches: ["components/**"] }),
      ...goals,
    ]);
    expect(conflictingCore.parallel.map((g) => g.id)).toEqual(["CR-04"]);
  });

  it("builds a sibling worktree plan without creating it", () => {
    const plan = worktreePlan(goal("CR-02", { title: "Gameplay feedback polish" }), "C:/work/Control-Room", { dryRun: true });
    expect(plan.branch).toBe("goal/CR-02-gameplay-feedback-polish");
    expect(plan.target.replaceAll("\\", "/")).toBe("C:/work/Control-Room-cr-02");
    expect(plan.dryRun).toBe(true);
    expect(worktreeGitArgs(plan)).toEqual(["worktree", "add", "-b", "goal/CR-02-gameplay-feedback-polish", plan.target, "HEAD"]);
  });
});
