import { mock } from "bun:test";
import assert from "node:assert/strict";
const cases: {name:string,run:()=>Promise<void>}[]=[];
let reset=()=>{};
const beforeEach=(fn:()=>void)=>{reset=fn;};
const test=(name:string,run:()=>Promise<void>)=>cases.push({name,run});
const expect=(value:unknown)=>({toBe:(expected:unknown)=>assert.equal(value,expected),toBeUndefined:()=>assert.equal(value,undefined)});
import { Elysia } from "elysia";

// Exercise the real HTTP handlers without production auth, SQL or Redis connections.
// Persistence is in memory; Lua atomicity and network timing need an integration environment.
class MemoryRedis {
  hashes = new Map<string, Record<string,string>>();
  lists = new Map<string,string[]>();
  strings = new Map<string,string>();
  clear() { this.hashes.clear(); this.lists.clear(); this.strings.clear(); }
  async hgetall(k:string) { return {...this.hashes.get(k)}; }
  async hkeys(k:string) { return Object.keys(await this.hgetall(k)); }
  async hget(k:string,f:string) { return this.hashes.get(k)?.[f] ?? null; }
  async hexists(k:string,f:string) { return (await this.hget(k,f)) === null ? 0 : 1; }
  async hset(k:string,f:string|Record<string,string>,v?:string) {
    const h=this.hashes.get(k) ?? {}; Object.assign(h, typeof f === "string" ? {[f]:v!} : f);
    this.hashes.set(k,h); return 1;
  }
  async del(k:string) { this.hashes.delete(k); this.lists.delete(k); this.strings.delete(k); return 1; }
  async expire(..._:unknown[]) { return 1; }
  async get(k:string) { return this.strings.get(k) ?? null; }
  async set(k:string,v:string,..._:unknown[]) { this.strings.set(k,v); return "OK"; }
  async llen(k:string) { return (this.lists.get(k) ?? []).length; }
  async lrange(k:string,a:number,b:number) { return (this.lists.get(k) ?? []).slice(a,b<0?undefined:b+1); }
  async lpos(k:string,v:string) { const n=(this.lists.get(k) ?? []).indexOf(v); return n<0?null:n; }
  async lpush(k:string,v:string) { const a=this.lists.get(k) ?? []; a.unshift(v); this.lists.set(k,a); return a.length; }
  async ltrim(k:string,a:number,b:number) { this.lists.set(k,await this.lrange(k,a,b)); }
  pipeline() {
    const pending:(()=>Promise<unknown>)[]=[];
    const p={hset:(...a:Parameters<MemoryRedis['hset']>)=>{pending.push(()=>this.hset(...a));return p;},
      del:(k:string)=>{pending.push(()=>this.del(k));return p;},
      exec:async()=>{for(const fn of pending)await fn();}};
    return p;
  }
  async eval(script:string,_count:number,...a:string[]) {
    if(script.includes("HSETNX")) {
      const [completed,tasks,key,user,,limit]=a as [string,string,string,string,string,string];
      if(!(await this.hexists(completed,key))) {
        await this.hset(completed,key,"1");
        await this.hset(tasks,user,String(Math.min(Number(await this.hget(tasks,user) ?? 0)+1,Number(limit))));
      }
      return Number(await this.hget(tasks,user) ?? 0);
    }
    const [k,meta,user,,round,started]=a as [string,string,string,string,string,string];
    if(await this.hget(meta,"phase")!=="1" || await this.hget(meta,"round")!==round || await this.hget(meta,"startedAt")!==started) return [0,-1];
    const list=this.lists.get(k) ?? [];
    const existing=list.indexOf(user); if(existing>=0)return [existing+1,1];
    list.push(user);this.lists.set(k,list);return [list.length,0];
  }
}
const redis=new MemoryRedis();
mock.module("../src/db.ts",()=>({redis,prisma:{
  instance:{findUnique:async()=>({id:"test",ownerId:"host",closedAt:null})},
  user:{findUnique:async()=>({isAdmin:false})},
}}));
mock.module("../src/auth-plugin.ts",()=>({authed:new Elysia().derive({as:"scoped"},({headers})=>({
  session:{sub:headers["x-test-user"] ?? "host"},
}))}));
const {gameRoutes}=await import("../src/routes/games.ts");
const app=new Elysia().use(gameRoutes);
async function request(path:string,body?:unknown,user="host") {
  const response=await app.handle(new Request("http://localhost/v1/games/test/"+path,{
    method:body===undefined?"GET":"POST",headers:{"content-type":"application/json","x-test-user":user},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),
  }));
  return {status:response.status,data:await response.json() as any};
}
async function roster(ids:string[]) { await redis.hset("inst:test:roster",Object.fromEntries(ids.map(id=>[id,"1"]))); }
async function releaseCountdown() { await redis.hset("game:test:meta","roundStartedAt",String(Date.now()-4000)); }
beforeEach(()=>redis.clear());

test("physical-start protocol runs all three solo arenas, rejects stale finishes, and supports replay",async()=>{
  await roster(["host"]);
  expect((await request("start",{mode:1})).status).toBe(200);
  let state=(await request("state")).data;
  expect((await request("finish",{round:1,startedAt:state.startedAt})).status).toBe(409);
  for(let round=1;round<=3;round++) {
    await releaseCountdown(); state=(await request("state")).data;
    expect(state.round).toBe(round);expect(state.phase).toBe(1);
    expect((await request("finish",{round:round-1,startedAt:state.startedAt})).status).toBe(409);
    const payload={round,startedAt:state.startedAt};
    expect((await request("finish",payload)).data.place).toBe(1);
    expect((await request("finish",payload)).data.duplicate).toBe(true);
    expect((await request("end-round",{})).status).toBe(200);
  }
  expect((await request("state")).data.outcome).toBe(3);
  expect((await request("start",{mode:1})).status).toBe(200);
  expect((await request("state")).data.round).toBe(1);
});

test("rope waits for the team, handles a departure, and host abort returns a result",async()=>{
  await roster(["host","peer"]);
  expect((await request("start",{mode:2})).data.mode).toBe(2);
  await releaseCountdown();const state=(await request("state")).data;
  expect((await request("finish",{round:1,startedAt:state.startedAt})).status).toBe(200);
  expect((await request("state")).data.phase).toBe(1);
  await redis.del("inst:test:roster");await roster(["host"]);
  expect((await request("state")).data.outcome).toBe(5);
  await request("start",{mode:2});
  expect((await request("abort",{},"peer")).status).toBe(403);
  expect((await request("abort",{})).status).toBe(200);
  expect((await request("state")).data.outcome).toBe(4);
});

test("ship lobby requires four, keeps roles private and accepts each of ten consoles only once",async()=>{
  await roster(["host","p2","p3"]);
  expect((await request("start",{mode:0})).data.error).toBe("not_enough_players");
  await roster(["p4"]);
  expect((await request("start",{mode:0})).status).toBe(200);
  const roles=await redis.hgetall("game:test:roles");
  const crew=Object.keys(roles).find(id=>roles[id]==="0")!;
  expect((await request("state")).data.roles).toBeUndefined();
  for(let id=0;id<10;id++) {
    expect((await request("task",{taskId:id},crew)).status).toBe(200);
    expect((await request("task",{taskId:id},crew)).status).toBe(200);
  }
  const me=(await request("me",undefined,crew)).data;
  expect(me.tasks).toBe(5);expect(me.completedTasks.length).toBe(10);
  expect((await request("task",{taskId:10},crew)).status).toBe(400);
});

for(const item of cases) { reset(); await item.run(); console.log("PASS: "+item.name); }
