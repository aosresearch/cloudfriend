// Data roles (benchmarks/<date>/roles.json): which cases may fit a model, calibrate its
// thresholds, be looked at while developing, or stay untouched until a candidate is frozen.
// Written once, committed before any tuning, and checked wherever data is used:
// ml/train.py (--roles), ml/lofo.ts, and ml/evaluate.ts, which refuses holdout cases
// without a matching freeze (ml/holdout.ts).
import { spawnSync } from "node:child_process";
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
 * The ml/evaluate.ts options a holdout run is frozen with. A freeze must set every one of them.
 * Audit is off (the gates ask what routing alone reaches) and the cautious oracle decides, with
 * the weak-label oracle as a separately frozen sensitivity run.
 */
export const HOLDOUT_SETTINGS: Readonly<Record<string, string>> = {
  decider: "oracle-cautious",
  strategies: "cascade,classifier,keyword",
  "audit-rate": "0",
  "batch-size": "100",
  "batch-wait": "10000",
  "audit-wait": "300000",
  "decider-concurrency": "2",
  "verdict-ttl": "900000",
  "novel-guard": "on",
  "escalated-ttl": String(7 * 86_400_000),
  "escalated-memory": String(90 * 86_400_000),
  "suppression-ttl": String(30 * 86_400_000),
  "drops-per-case": "60",
};

/**
 * What a frozen candidate is: the model file's hash, and the settings it is evaluated with.
 * Written by ml/holdout.ts --freeze and committed before any holdout run.
 */
export interface Freeze {
  frozen_at: string;
  roles_sha256: string;
  arms: { name: string; model: string; model_sha256: string }[];
  /** ml/evaluate.ts options, identical for every arm: every key of HOLDOUT_SETTINGS. */
  settings: Record<string, string>;
  /** Holdout cases whose source data is verifiably absent, with the evidence. Recorded before any run. */
  unavailable?: Record<string, string>;
}

/** Throws unless `model` is one of the frozen arms, unchanged, under the same roles, with a complete freeze. */
export function checkFreeze(freezeFile: string, model: string, rolesFile: string): Freeze {
  const f = JSON.parse(fs.readFileSync(freezeFile, "utf8")) as Freeze;
  if (f.roles_sha256 !== sha256File(rolesFile)) throw new Error("roles.json changed since the freeze");
  const missing = Object.keys(HOLDOUT_SETTINGS).filter((k) => !(k in (f.settings ?? {})));
  if (missing.length) throw new Error(`the freeze doesn't set ${missing.join(", ")}: an incomplete freeze can't run the holdout`);
  const roles = loadRoles(rolesFile);
  for (const [c, why] of Object.entries(f.unavailable ?? {})) {
    if (roles.cases[c] !== "holdout") throw new Error(`unavailable case ${c} is not a holdout case`);
    if (!why.trim()) throw new Error(`unavailable case ${c} needs the evidence of its absence`);
  }
  const h = sha256File(model);
  if (!f.arms.some((a) => a.model_sha256 === h)) throw new Error(`${model} is not a frozen arm (sha256 ${h.slice(0, 12)}…)`);
  return f;
}

/**
 * Every holdout case of the roles must be in the data, unless the freeze recorded it as
 * unavailable; and an "unavailable" case that is there after all is an error, not a skip.
 */
export function checkHoldoutCases(f: Freeze, roles: Roles, present: Iterable<string>): void {
  const have = new Set(present);
  const unavailable = f.unavailable ?? {};
  for (const [c, role] of Object.entries(roles.cases)) {
    if (role !== "holdout") continue;
    if (c in unavailable && have.has(c)) throw new Error(`${c} is recorded as unavailable but is in the data`);
    if (!(c in unavailable) && !have.has(c)) throw new Error(`holdout case ${c} is missing from the data (record a verified absence at freeze time)`);
  }
}

/** Throws unless each file is committed and unchanged from HEAD. */
export function checkCommitted(...files: string[]): void {
  for (const file of files) {
    if (spawnSync("git", ["ls-files", "--error-unmatch", file], { encoding: "utf8" }).status !== 0) throw new Error(`${file} is not committed`);
    if (spawnSync("git", ["diff", "--quiet", "HEAD", "--", file]).status !== 0) throw new Error(`${file} differs from the commit`);
  }
}
