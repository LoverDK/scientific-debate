import { expect, it } from "vitest";
import { selectEvidenceCandidates } from "./evidence-candidates.js";

const papers = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => ({ externalId: prefix + i }));

it("keeps both search directions within the candidate budget", () => {
  const selected = selectEvidenceCandidates(papers("S", 20), papers("C", 10), 15);
  expect(selected).toHaveLength(15);
  expect(selected.filter(p => p.externalId.startsWith("C"))).toHaveLength(7);
  expect(selected.slice(0, 4).map(p => p.externalId)).toEqual(["S0", "C0", "S1", "C1"]);
});

it("skips duplicates without wasting slots and preserves first occurrence", () => {
  const first = { externalId: "W1", title: "first" };
  const supporting = [first, first, { externalId: "W2", title: "second" }];
  const challenging = [{ externalId: "W1", title: "duplicate" }, { externalId: "W3", title: "third" }];
  expect(selectEvidenceCandidates(supporting, challenging, 3)).toEqual([first, challenging[1], supporting[2]]);
  expect(supporting).toHaveLength(3);
  expect(challenging[0]?.title).toBe("duplicate");
});

it("uses remaining capacity when a direction is empty or exhausted", () => {
  expect(selectEvidenceCandidates([], papers("C", 4), 10)).toHaveLength(4);
  expect(selectEvidenceCandidates(papers("S", 5), papers("C", 1), 5).map(p => p.externalId))
    .toEqual(["S0", "C0", "S1", "S2", "S3"]);
  expect(selectEvidenceCandidates([], [], 10)).toEqual([]);
  expect(selectEvidenceCandidates(papers("S", 5), [], 0)).toEqual([]);
});

it("rejects an invalid budget", () => {
  for (const budget of [-1, 1.5, NaN, Infinity]) {
    expect(() => selectEvidenceCandidates([], [], budget)).toThrow(RangeError);
  }
});
