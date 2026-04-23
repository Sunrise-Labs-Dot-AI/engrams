import { describe, it, expect } from "vitest";
import {
  getInitialConfidence,
  applyConfirm,
  applyCorrect,
  applyMistake,
  applyUsed,
} from "../confidence.js";

describe("getInitialConfidence", () => {
  it("returns 0.90 for stated", () => {
    expect(getInitialConfidence("stated")).toBe(0.9);
  });

  it("returns 0.75 for observed", () => {
    expect(getInitialConfidence("observed")).toBe(0.75);
  });

  it("returns 0.65 for inferred", () => {
    expect(getInitialConfidence("inferred")).toBe(0.65);
  });

  it("returns 0.70 for cross-agent", () => {
    expect(getInitialConfidence("cross-agent")).toBe(0.7);
  });
});

describe("applyConfirm", () => {
  it("sets confidence to max (0.99)", () => {
    expect(applyConfirm(0.7)).toBe(0.99);
    expect(applyConfirm(0.5)).toBe(0.99);
    expect(applyConfirm(0.99)).toBe(0.99);
  });
});

describe("applyCorrect", () => {
  it("floors at 0.9 (stated-truth floor)", () => {
    expect(applyCorrect(0.1)).toBe(0.9);
    expect(applyCorrect(0.5)).toBe(0.9);
    expect(applyCorrect(0.9)).toBe(0.9);
  });

  it("leaves higher confidence unchanged", () => {
    expect(applyCorrect(0.95)).toBe(0.95);
    expect(applyCorrect(0.99)).toBe(0.99);
  });

  it("is idempotent when called repeatedly", () => {
    const once = applyCorrect(0.5);
    const twice = applyCorrect(once);
    expect(twice).toBe(once);
  });
});

describe("applyMistake", () => {
  it("decreases confidence by 0.15", () => {
    expect(applyMistake(0.7)).toBeCloseTo(0.55);
  });

  it("floors at 0.10", () => {
    expect(applyMistake(0.15)).toBe(0.1);
    expect(applyMistake(0.1)).toBe(0.1);
  });
});

describe("applyUsed", () => {
  it("increases confidence by 0.02", () => {
    expect(applyUsed(0.7)).toBeCloseTo(0.72);
  });

  it("caps at 0.99", () => {
    expect(applyUsed(0.98)).toBe(0.99);
  });
});
