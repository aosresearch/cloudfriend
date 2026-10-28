import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { checkFreeze, checkHoldoutCases, HOLDOUT_SETTINGS, roleOf, sha256File, type Freeze, type Roles } from "../ml/roles.ts";
import { BUILTIN_MODEL } from "../src/triage/runtime.ts";
import { tempDir } from "./helpers.ts";

const ROOT = path.join(import.meta.dirname, "..");
const roles: Roles = { version: 1, cases: { "a-1": "fit", "b-1": "calibrate", "c-1": "dev", "gaia-x": "holdout" } };
const write = (dir: string, name: string, body: string) => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, body);
  return f;
};

describe("data roles", () => {
  it("knows every case's role and refuses unknown cases", () => {
    assert.equal(roleOf(roles, "b-1"), "calibrate");
    assert.throws(() => roleOf(roles, "zzz"), /no role/);
  });

  it("the trainer refuses rows of the wrong role", { skip: spawnSync("python3", ["-c", "import lightgbm"]).status !== 0 && "no lightgbm" }, () => {
    const dir = tempDir();
    const r = write(dir, "roles.json", JSON.stringify(roles));
    const rows = (c: string) => `case,t,y,w,f0\n${c},1,0,1,0.1\n${c},2,1,1,0.9\n`;
    const run = (train: string, valid: string) =>
      spawnSync("python3", [path.join(ROOT, "ml/train.py"), "--train", write(dir, "t.csv", rows(train)), "--valid", write(dir, "v.csv", rows(valid)), "--out", path.join(dir, "m.json"), "--featurizer-version", "3", "--roles", r], { encoding: "utf8" });
    const leak = run("c-1", "b-1");
    assert.notEqual(leak.status, 0);
    assert.match(leak.stderr, /without the role fit: c-1 \(dev\)/);
    const calib = run("a-1", "a-1");
    assert.match(calib.stderr, /without the role calibrate: a-1 \(fit\)/);
  });

  it("holdout cases run only for a frozen model under the same roles", () => {
    const dir = tempDir();
    const r = write(dir, "roles.json", JSON.stringify(roles));
    const model = write(dir, "m.json", fs.readFileSync(BUILTIN_MODEL, "utf8"));
    const frozen = { frozen_at: "x", roles_sha256: sha256File(r), arms: [{ name: "baseline", model, model_sha256: sha256File(model) }], settings: { ...HOLDOUT_SETTINGS } };
    const freeze = write(dir, "freeze.json", JSON.stringify(frozen));
    assert.doesNotThrow(() => checkFreeze(freeze, model, r));
    const { decider: _, ...partial } = HOLDOUT_SETTINGS;
    const incomplete = write(dir, "incomplete.json", JSON.stringify({ ...frozen, settings: partial }));
    assert.throws(() => checkFreeze(incomplete, model, r), /doesn't set decider/);
    const notHoldout = write(dir, "bad-unavailable.json", JSON.stringify({ ...frozen, unavailable: { "a-1": "no logs" } }));
    assert.throws(() => checkFreeze(notHoldout, model, r), /not a holdout case/);
    const other = write(dir, "other.json", fs.readFileSync(BUILTIN_MODEL, "utf8").replace('"note"', '"notes"'));
    assert.throws(() => checkFreeze(freeze, other, r), /not a frozen arm/);
    write(dir, "roles.json", JSON.stringify({ ...roles, version: 2 }));
    assert.throws(() => checkFreeze(freeze, model, r), /roles.json changed/);
  });

  it("evaluate.ts refuses a holdout case without a freeze", () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, "streams"));
    write(dir, "cases.json", JSON.stringify([{ id: "gaia-x", dataset: "gaia", split: "holdout", start_ms: 0, end_ms: 1, events: 0, positives: 0 }]));
    const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(ROOT, "ml/evaluate.ts"), "--data", dir, "--model", BUILTIN_MODEL, "--split", "all", "--decider", "oracle"], { encoding: "utf8" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /holdout cases need --freeze and --roles/);
  });

  it("a holdout run needs every holdout case, unless a verified absence was frozen", () => {
    const f: Freeze = { frozen_at: "x", roles_sha256: "", arms: [], settings: { ...HOLDOUT_SETTINGS } };
    const two: Roles = { version: 1, cases: { "g-15": "holdout", "g-16": "holdout", "c-1": "dev" } };
    assert.doesNotThrow(() => checkHoldoutCases(f, two, ["g-15", "g-16"]));
    assert.throws(() => checkHoldoutCases(f, two, ["g-16"]), /g-15 is missing/);
    const absent = { ...f, unavailable: { "g-15": "no business logs in the source for this day" } };
    assert.doesNotThrow(() => checkHoldoutCases(absent, two, ["g-16"]));
    assert.throws(() => checkHoldoutCases(absent, two, ["g-15", "g-16"]), /recorded as unavailable but is in the data/);
  });
});
