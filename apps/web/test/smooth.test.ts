import { describe, expect, it } from "vitest";
import { ema, nearest } from "../components/charts/smooth";

describe("ema", () => {
  it("is identity at weight 0", () => expect(ema([1, 5, 2], 0)).toEqual([1, 5, 2]));
  it("is debiased (first point unchanged) and smooths", () => {
    const s = ema([10, 0, 0], 0.5);
    expect(s[0]).toBeCloseTo(10);
    expect(s[1]).toBeCloseTo(10 / 3); // (2.5) / (1 - 0.25)
    expect(s[2]).toBeLessThan(s[1]);
  });
});

describe("nearest", () => {
  it("finds the closest index", () => {
    expect(nearest([0, 10, 20], 14)).toBe(1);
    expect(nearest([0, 10, 20], 16)).toBe(2);
    expect(nearest([0, 10, 20], -5)).toBe(0);
    expect(nearest([0, 10, 20], 99)).toBe(2);
    expect(nearest([], 1)).toBe(-1);
  });
});
