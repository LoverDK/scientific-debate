import { expect, it } from "vitest";
import type { EvidencePackPaper } from "../../server/lib/debate-evidence";
import { compareEvidence, elapsed } from "./debate-compare";

const paper = (externalId: string): EvidencePackPaper => ({
  id: externalId, externalId, title: "Study", authors: ["Author"], year: null, doi: null,
  url: null, providerUrl:"", abstract:"Abstract", abstractTruncated:false, stance:null,
});
it("distinguishes same-size evidence packs, revised claims, changed abstracts and reordered papers", () => {
  const a = { debateId:"d", claim:"before", papers:[paper("A"),paper("B"),paper("C")] };
  const b = { debateId:"d", claim:"after", papers:[paper("C"),{...paper("B"),abstract:"updated"},paper("D")] };
  expect(compareEvidence(a,b)).toEqual({onlyA:["A"],onlyB:["D"],changed:["B"],orderChanged:true,claimChanged:true});
  expect(compareEvidence(a,a)).toEqual({onlyA:[],onlyB:[],changed:[],orderChanged:false,claimChanged:false});
});
it("shows elapsed time only for a valid, finished execution interval", () => {
  expect(elapsed("2026-01-01T12:00:00Z","2026-01-01T12:00:01.500Z")).toBe(1.5);
  expect(elapsed("2026-01-01",null)).toBeNull();
  expect(elapsed("2026-01-02","2026-01-01")).toBeNull();
  expect(elapsed("invalid","also invalid")).toBeNull();
});
