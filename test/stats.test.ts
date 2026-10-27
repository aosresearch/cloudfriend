import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { binomCdf, bootstrap, lowerBound, upperBound } from "../src/stats.ts";

describe("exact bounds", () => {
  it("matches known Clopper-Pearson values", () => {
    // Zero in n: 1 - 0.05^(1/n).
    assert.ok(Math.abs(upperBound(0, 300) - (1 - 0.05 ** (1 / 300))) < 1e-6);
    assert.ok(upperBound(0, 300) > 0.0099 && upperBound(0, 300) < 0.0101, "about 1% after 0 of 300");
    assert.ok(upperBound(0, 600) < 0.005, "under 0.5% needs about 600");
    assert.ok(upperBound(0, 590) > 0.005);
    // 3 of 100, one-sided 95%: 0.0757 (from the beta quantile).
    assert.ok(Math.abs(upperBound(3, 100) - 0.0757) < 5e-4);
    assert.ok(Math.abs(lowerBound(97, 100) - (1 - 0.0757)) < 5e-4);
    assert.equal(upperBound(5, 5), 1);
    assert.ok(Math.abs(binomCdf(1, 2, 0.5) - 0.75) < 1e-12);
  });

  it("bootstraps a statistic over groups", () => {
    const ci = bootstrap([0, 1, 1, 1, 0, 1, 1, 1, 1, 1], (g) => g.reduce((a, b) => a + b, 0) / g.length)!;
    assert.ok(ci[0] < 0.8 && ci[1] > 0.8 && ci[1] <= 1);
  });
});
