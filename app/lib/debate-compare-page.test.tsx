// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import CompareRoute from "../routes/debates.$debateId.compare";

const { callAction, useActionQuery } = vi.hoisted(() => ({callAction:vi.fn(), useActionQuery:vi.fn()}));
vi.mock("@agent-native/core/client/use-action", () => ({callAction, useActionQuery}));

it("loads older pages and compares a partial historical run without generating messages", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const row = (id:string) => ({id,status:"failed",modelId:"test",createdAt:"2026-01-01"});
  callAction.mockImplementation(async (name, args, opts) => {
    expect(name).toBe("list-debate-runs");
    expect(opts.method).toBe("GET");
    return args.cursor ? {runs:[row("older")],nextCursor:null} : {runs:[row("latest"),row("second")],nextCursor:"page-2"};
  });
  useActionQuery.mockImplementation((name, {runId}) => {
    expect(name).toBe("get-debate-run");
    return {data:runId && {...row(runId),debateId:"d",startedAt:null,finishedAt:null,
      evidencePack:{claim:"claim "+runId,debateId:"d",papers:[]},messages:[]}};
  });
  const host = document.createElement("div");
  const root = createRoot(host);
  const client = new QueryClient();
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter><Routes>
      <Route element={<Outlet context={{debateId:"d"}}/>}><Route index element={<CompareRoute/>}/></Route>
    </Routes></MemoryRouter></QueryClientProvider>));
    await vi.waitFor(async () => {
      await act(async () => new Promise(resolve=>setTimeout(resolve,5)));
      expect(host.textContent).toContain("claim latest");
    });
    const more = [...host.querySelectorAll("button")].find(b=>b.textContent==="加载更早的运行")!;
    await act(async()=>more.click());
    await vi.waitFor(async () => {
      await act(async () => new Promise(resolve=>setTimeout(resolve,5)));
      expect(host.querySelector('option[value="older"]')).toBeTruthy();
    });
    const right = host.querySelectorAll("select")[1]!;
    await act(async () => {right.value="older"; right.dispatchEvent(new Event("change",{bubbles:true}));});
    expect(host.textContent).toContain("claim latest");
    expect(host.textContent).toContain("claim older");
    expect(host.textContent).toContain("暂无已保存的发言");
    expect(host.textContent).toContain("费用：未记录");
  } finally {
    await act(async()=>root.unmount());
    client.clear();
    vi.unstubAllGlobals();
  }
});

