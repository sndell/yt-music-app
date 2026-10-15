import { describe, expect, it } from "vitest";
import { orderItems, pinFirst } from "./orderMap";

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
