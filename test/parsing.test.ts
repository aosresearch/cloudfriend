import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { FEATURE_NAMES, Featurizer, statusInText } from "../src/triage/features.ts";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "parsing.json");
const { cases } = JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as { cases: { text: string; status: number | null; errorish: boolean; note: string }[] };
const col = (name: string) => FEATURE_NAMES.indexOf(name);

describe("parsing (test/fixtures/parsing.json)", () => {
  for (const c of cases) {
    it(`featurizer v3: ${c.note}`, () => {
      const got = statusInText(c.text);
      assert.equal(Number.isNaN(got) ? null : got, c.status);
      const f = new Featurizer({ version: 3 }).featurize({ source: "app", received_at: 0, data: { message: c.text } });
      assert.equal(f.errorish, c.errorish);
      if (c.status === null) {
        assert.ok(Number.isNaN(f.values[col("status")]!), "no status feature");
        assert.equal(f.values[col("kw_unavailable")], 0, "no bare-number keyword");
      }
    });
  }

  it("featurizer v2 keeps its old reading, so v2 models replay unchanged", () => {
    const gaia = cases[0]!.text;
    const v2 = new Featurizer({ version: 2 }).featurize({ source: "app", received_at: 0, data: { message: gaia } });
    const v3 = new Featurizer({ version: 3 }).featurize({ source: "app", received_at: 0, data: { message: gaia } });
    assert.equal(v2.values.length, v3.values.length);
    assert.equal(v3.errorish, false);
  });

  it("weak labels (ml/datasets/common.py) agree", { skip: spawnSync("python3", ["--version"]).status !== 0 && "no python3" }, () => {
    const r = spawnSync("python3", ["-I", path.join(import.meta.dirname, "..", "ml", "datasets", "check_parsing.py"), FIXTURE], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
});
