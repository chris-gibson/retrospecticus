import { describe, expect, test } from "bun:test";
import { compareVersions } from "@retrospecticus/shared";

describe("compareVersions", () => {
  test("orders releases numerically, not as text", () => {
    expect(compareVersions("0.1.10", "0.1.9")!).toBeGreaterThan(0);
    expect(compareVersions("0.2.0", "0.10.0")!).toBeLessThan(0);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
  });

  test("a pre-release sorts before its release and by its identifiers", () => {
    expect(compareVersions("0.2.0-rc.1", "0.2.0")!).toBeLessThan(0);
    expect(compareVersions("0.2.0-rc.2", "0.2.0-rc.10")!).toBeLessThan(0);
    expect(compareVersions("0.2.0-alpha", "0.2.0-beta")!).toBeLessThan(0);
    expect(compareVersions("0.2.0-rc.1", "0.1.9")!).toBeGreaterThan(0);
  });

  test("anything else is not compared", () => {
    expect(compareVersions("dev", "0.1.0")).toBeNull();
    expect(compareVersions("0.1", "0.1.0")).toBeNull();
  });
});
