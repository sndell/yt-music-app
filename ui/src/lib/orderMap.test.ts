import { describe, expect, it } from "vitest";
import { orderFreshLast, orderItems, pinFirst } from "./orderMap";

const idOf = (value: string) => value;

describe("orderItems", () => {
  it("puts saved ids first, in the saved order, then the rest", () => {
    expect(orderItems(["a", "b", "c"], idOf, ["c", "a"])).toEqual(["c", "a", "b"]);
  });

  it("returns the input untouched when nothing is saved", () => {
    const items = ["a", "b"];
    expect(orderItems(items, idOf, undefined)).toBe(items);
  });
});

describe("pinFirst", () => {
  it("moves the pinned id to the front", () => {
    expect(pinFirst(["a", "LM", "b"], idOf, "LM")).toEqual(["LM", "a", "b"]);
  });

  it("leaves the array alone when the pinned id is not present", () => {
    const items = ["a", "b"];
    expect(pinFirst(items, idOf, "LM")).toBe(items);
  });
});

describe("orderFreshLast", () => {
  it("puts ids seen for the first time at the bottom", () => {
    expect(orderFreshLast(["LM", "a", "new"], "LM", ["new"])).toEqual(["LM", "a", "new"]);
  });

  it("moves a fresh id to the bottom even when it arrived first", () => {
    expect(orderFreshLast(["new", "LM", "a"], "LM", ["new"])).toEqual(["LM", "a", "new"]);
  });

  it("keeps the pinned id first and the fresh ids in order", () => {
    expect(orderFreshLast(["a", "LM", "b", "second", "first"], "LM", ["second", "first"])).toEqual([
      "LM",
      "a",
      "b",
      "second",
      "first",
    ]);
  });
});
