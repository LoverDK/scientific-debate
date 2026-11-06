import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { closeDbExec, getDatabaseUrl, getMigrationDatabaseUrl, runMigrations, withMigrationRuntime } from "@agent-native/core/db";
import { getDb, schema } from "../server/db/index.js";
import { DEBATES_APP_MIGRATIONS_TABLE, debatesAppMigrations } from "../server/db/migrations.js";
import add from "./add-run-discussion.js";
import list from "./list-run-discussion.js";

if(process.env.DATABASE_URL!=="pglite:memory" || getDatabaseUrl()!=="pglite:memory" || getMigrationDatabaseUrl()!=="pglite:memory") throw Error("Memory database required");
const owner={caller:"cli" as const,userEmail:"owner@example.test"};
const foreign={caller:"cli" as const,userEmail:"other@example.test"};
const anon={caller:"cli" as const};
const runId="test-run";
const note={runId,kind:"question" as const,body:"Does the sample size support this claim?"};
beforeAll(async()=>{await withMigrationRuntime(async()=>{await runMigrations(debatesAppMigrations,{table:DEBATES_APP_MIGRATIONS_TABLE})(undefined);});});
beforeEach(async()=>{
  vi.stubGlobal("fetch",vi.fn(()=>{throw Error("Network forbidden");}));
  const db=getDb();
  await db.delete(schema.debates);
  await db.insert(schema.debates).values({id:"d",claim:"Claim",ownerEmail:owner.userEmail});
  await db.insert(schema.debateRuns).values({id:runId,debateId:"d",status:"completed",modelId:"fixture",createdByEmail:owner.userEmail,
    evidenceSnapshotJson:JSON.stringify({debateId:"d",claim:"Claim",papers:[{id:"p",externalId:"W1",title:"Snapshot paper"}]})});
  await db.insert(schema.debateMessages).values({id:"m",runId,role:"judge",payloadJson:"{}",citedExternalIdsJson:"[]"});
});
afterEach(()=>vi.unstubAllGlobals());
afterAll(async()=>await closeDbExec());
it("persists all five human intents without changing the run or model messages",async()=>{
  const db=getDb();
  const runs=await db.select().from(schema.debateRuns);
  const messages=await db.select().from(schema.debateMessages);
  for(const kind of ["viewpoint","question","challenge","citation_explanation","follow_up"] as const){
    await add.run({...note,kind,role:"judge",citedExternalId:"W1"},owner);
  }
  const result=await list.run({runId},owner);
  expect(result.notes.map(n=>n.kind).sort()).toEqual(["challenge","citation_explanation","follow_up","question","viewpoint"]);
  expect(result.notes.every(n=>n.role==="judge" && n.citedExternalId==="W1")).toBe(true);
  expect(await db.select().from(schema.debateRuns)).toEqual(runs);
  expect(await db.select().from(schema.debateMessages)).toEqual(messages);
  expect(fetch).not.toHaveBeenCalled();
});
it("isolates private contributions on both paths",async()=>{
  await add.run(note,owner);
  for(const [user,statusCode] of [[anon,401],[foreign,404]] as const){
    await expect(add.run(note,user)).rejects.toMatchObject({statusCode});
    await expect(list.run({runId},user)).rejects.toMatchObject({statusCode});
  }
});
it("validates role and paper against the selected run and preserves notes when archived",async()=>{
  await expect(add.run({...note,citedExternalId:"W2"},owner)).rejects.toMatchObject({statusCode:400});
  await expect(add.run({...note,role:"opponent"},owner)).rejects.toMatchObject({statusCode:400});
  await expect(add.run({...note,kind:"citation_explanation"},owner)).rejects.toMatchObject({statusCode:400});
  await add.run(note,owner);
  await getDb().update(schema.debates).set({archivedAt:new Date().toISOString()});
  await expect(add.run(note,owner)).rejects.toMatchObject({statusCode:409});
  const result=await list.run({runId},owner);
  expect(result.archived).toBe(true); expect(result.notes).toHaveLength(1);
});
