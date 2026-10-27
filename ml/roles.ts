// Data roles (benchmarks/<date>/roles.json): which cases may fit a model, calibrate its
// thresholds, be looked at while developing, or stay untouched until a candidate is frozen.
// Written once, committed before any tuning, and checked wherever data is used:
// ml/train.py (--roles), ml/lofo.ts, and ml/evaluate.ts, which refuses holdout cases
// without a matching freeze (ml/holdout.ts).
import crypto from "node:crypto";
import fs from "node:fs";

export type Role = "fit" | "calibrate" | "dev" | "holdout";

export interface Roles {
  version: number;
  /** Case id -> role. Every case of every dataset in use is listed. */
  cases: Record<string, Role>;
  [k: string]: unknown;
}

export function loadRoles(file: string): Roles {
  const r = JSON.parse(fs.readFileSync(file, "utf8")) as Roles;
  if (!r.cases || typeof r.cases !== "object") throw new Error(`${file} has no cases`);
  return r;
}

export function roleOf(r: Roles, caseId: string): Role {
  const role = r.cases[caseId];
  if (!role) throw new Error(`case ${caseId} has no role in roles.json`);
  return role;
}

export const sha256File = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/**
 * What a frozen candidate is: the model file's hash, and the settings it is evaluated with.
 * Written by ml/holdout.ts --freeze and committed before any holdout run.
 */
export interface Freeze {
  frozen_at: string;
  roles_sha256: string;
  arms: { name: string; model: string; model_sha256: string }[];
  /** ml/evaluate.ts options, identical for every arm. */
  settings: Record<string, string>;
}

/** Throws unless `model` is one of the frozen arms, unchanged, under the same roles. */
export function checkFreeze(freezeFile: string, model: string, rolesFile: string): Freeze {
  const f = JSON.parse(fs.readFileSync(freezeFile, "utf8")) as Freeze;
  if (f.roles_sha256 !== sha256File(rolesFile)) throw new Error("roles.json changed since the freeze");
  const h = sha256File(model);
  if (!f.arms.some((a) => a.model_sha256 === h)) throw new Error(`${model} is not a frozen arm (sha256 ${h.slice(0, 12)}…)`);
  return f;
}
