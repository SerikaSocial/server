import { beforeAll, afterAll, expect, test } from "bun:test";
import { Elysia } from "elysia";
const enabled=process.env.SERIKA_SOCIAL_INTEGRATION==="1";
let db:any,redis:any,app:any,staffToken:string,guestToken:string,eventId:string;
const staff="20000000-0000-4000-8000-000000000001",guest="20000000-0000-4000-8000-000000000002",world="20000000-0000-4000-8000-000000000010",version="20000000-0000-4000-8000-000000000011";
const hash="b".repeat(64),key=(name:string)=>`events/${hash}/${name}`;
const config={artistKey:key("artist.ska"),animationKey:key("animation.glb"),audioKey:key("track.ogg"),clip:"Dance",duration:120,performer:[0,4.2,-44],yaw:180,scale:1,cameras:[{time:0,position:[0,6,-34],target:[0,5.6,-44],fov:40}]};
async function req(method:string,path:string,token:string|null=staffToken,body?:any){const r=await app.handle(new Request("http://localhost"+path,{method,headers:{...(token?{Authorization:`Bearer ${token}`}:{ }),...(body?{"Content-Type":"application/json"}:{})},...(body?{body:JSON.stringify(body)}:{})}));const raw=await r.text();let parsed:any;try{parsed=JSON.parse(raw)}catch{parsed={error:raw}}return{status:r.status,body:parsed};}
beforeAll(async()=>{if(!enabled)return;
 if(process.env.DATABASE_URL!=="postgresql://postgres:serika-ui184-test@127.0.0.1:55492/serika_ui184_test"||process.env.REDIS_URL!=="redis://127.0.0.1:65492/0")throw Error("Refusing non-disposable database");
 const mod=await import("../src/db.ts");db=mod.prisma;redis=mod.redis;
 await db.notification.deleteMany();await db.instance.deleteMany();await db.world.deleteMany();await db.user.deleteMany();await redis.flushdb();
 await db.user.create({data:{id:staff,accountsId:staff,username:"event-staff",isAdmin:true}});await db.user.create({data:{id:guest,accountsId:guest,username:"event-guest"}});
 const{signSession}=await import("../src/tokens.ts");staffToken=await signSession({sub:staff,accountsId:staff,username:"event-staff",isAdmin:true});guestToken=await signSession({sub:guest,accountsId:guest,username:"event-guest",isAdmin:false});
 await db.world.create({data:{id:world,name:"Suisei test venue",authorId:staff,eventOnly:true,isUnlisted:true,releaseStatus:1,publishedVersionId:version,capacity:2,versions:{create:{id:version,version:1,buildStatus:2,reviewStatus:5,assets:{create:{platform:1,bytes:1n,blake3:Buffer.alloc(32),cdnKey:"test.serikaworld"}}}}}});
 const {putBytes}=await import("../src/storage.ts");for(const n of ["banner.png","artist.ska","animation.glb","track.ogg"])await putBytes(key(n),new Uint8Array([1]),"application/octet-stream");
 await redis.sadd("nodes","event-test");await redis.hset("node:event-test","endpoint","relay.example:4200","load","0");
 const{eventRoutes,adminEventRoutes}=await import("../src/routes/events.ts");const{worldRoutes}=await import("../src/routes/worlds.ts");const{instanceRoutes}=await import("../src/routes/instances.ts");
 app=new Elysia().use(eventRoutes).use(adminEventRoutes).use(worldRoutes).use(instanceRoutes).onError(({error}:any)=>({error:error.message}));
});
afterAll(async()=>{if(db)await db.$disconnect();if(redis)await redis.quit();});
test.skipIf(!enabled)("real auth blocks anonymous and nonstaff administration",async()=>{expect((await req("GET","/v1/admin/events/",null)).status).toBe(401);expect((await req("GET","/v1/admin/events/",guestToken)).status).toBe(403);expect((await req("POST","/v1/admin/events/",guestToken,{})).status).toBeGreaterThanOrEqual(400);});
test.skipIf(!enabled)("event venue never appears in public catalogue and normal matchmaking is rejected",async()=>{expect((await req("GET","/v1/worlds/",null)).body.some((w:any)=>w.id===world)).toBe(false);expect((await req("POST","/v1/instances/join-world",guestToken,{worldId:world})).body.error).toBe("event_join_required");});
test.skipIf(!enabled)("staff setup stays a draft and cannot be joined before opening",async()=>{const r=await req("POST","/v1/admin/events/",staffToken,{worldId:world,title:"Suisei",bannerKey:key("banner.png"),config});expect(r.status).toBe(200);eventId=r.body.id;expect(r.body.status).toBe("draft");expect((await req("GET","/v1/events/",guestToken)).body).toHaveLength(0);expect((await req("POST",`/v1/events/${eventId}/join`,guestToken,{})).body.error).toBe("event_closed");});
test.skipIf(!enabled)("opening shows the banner and reserves a shared dedicated instance",async()=>{expect((await req("POST",`/v1/admin/events/${eventId}/control`,staffToken,{action:"open",revision:0})).body.status).toBe("open");expect((await req("GET","/v1/events/",guestToken)).body).toHaveLength(1);const[a,b]=await Promise.all([req("POST",`/v1/events/${eventId}/join`,staffToken,{}),req("POST",`/v1/events/${eventId}/join`,guestToken,{})]);expect(a.status).toBe(200);expect(b.status).toBe(200);expect(a.body.instance.id).toBe(b.body.instance.id);expect(a.body.ticket).toBeTruthy();expect(a.body.instance.mode).toBe(1);});
test.skipIf(!enabled)("server clock start, stale commands and late-join state",async()=>{const now=Date.now();const r=await req("POST",`/v1/admin/events/${eventId}/control`,staffToken,{action:"play",revision:1});expect(r.body.startedAt).toBeGreaterThanOrEqual(now+9900);expect(r.body.revision).toBe(2);expect((await req("GET",`/v1/events/${eventId}`,guestToken)).body.startedAt).toBe(r.body.startedAt);expect((await req("POST",`/v1/admin/events/${eventId}/control`,staffToken,{action:"stop",revision:1})).status).toBe(409);});
test.skipIf(!enabled)("stop keeps doors open; close hides banner and rejects subsequent joins",async()=>{expect((await req("POST",`/v1/admin/events/${eventId}/control`,staffToken,{action:"stop",revision:2})).body.status).toBe("open");const r=await req("POST",`/v1/admin/events/${eventId}/control`,staffToken,{action:"close",revision:3});expect(r.body.status).toBe("ended");expect((await req("GET","/v1/events/",guestToken)).body).toHaveLength(0);expect((await req("POST",`/v1/events/${eventId}/join`,guestToken,{})).body.error).toBe("event_closed");expect(await db.instance.count({where:{eventId,closedAt:null}})).toBe(0);});

test.skipIf(!enabled)("closed instances are marked for relay eviction and drafts can be edited",async()=>{const instances=await db.instance.findMany({where:{eventId}});for(const i of instances)expect(await redis.get(`inst:${i.id}:closed`)).toBe("1");expect((await req("POST",`/v1/admin/events/${eventId}/config`,staffToken,{worldId:world,title:"Suisei encore",bannerKey:key("banner.png"),config})).body.title).toBe("Suisei encore");});
test.skipIf(!enabled)("only one event may open in a venue",async()=>{const first=await req("GET","/v1/admin/events/",staffToken);const e=first.body.find((e:any)=>e.id===eventId);expect((await req("POST",`/v1/admin/events/${eventId}/control`,staffToken,{action:"open",revision:e.revision})).status).toBe(200);const second=await req("POST","/v1/admin/events/",staffToken,{worldId:world,title:"Other show",bannerKey:key("banner.png"),config});expect((await req("POST",`/v1/admin/events/${second.body.id}/control`,staffToken,{action:"open",revision:0})).status).toBe(409);});

test.skipIf(!enabled || !process.env.EVENT_FIXTURES)("real venue, VRM, animation and audio upload workflow",async()=>{
 const dir=process.env.EVENT_FIXTURES!;
 async function upload(route:string,name:string,path:string){const body=new FormData();body.set("file",new File([await Bun.file(path).arrayBuffer()],name));if(route==="venues")body.set("name","Suisei exported venue");const r=await app.handle(new Request("http://localhost/v1/admin/events/"+route,{method:"POST",headers:{Authorization:`Bearer ${staffToken}`},body}));const result=await r.json();expect(r.status).toBe(200);return result as any;}
 const venue=await upload("venues","concert.serikaworld",process.env.EVENT_VENUE!);expect((await db.world.findUnique({where:{id:venue.id}})).isUnlisted).toBe(true);
 const artist=await upload("assets/artist","artist.vrm",dir+"/artist.vrm");expect(artist.key.endsWith("/artist.ska")).toBe(true);
 const animation=await upload("assets/animation","animation.glb",dir+"/animation.glb");expect(animation.clips[0].name).toBe("Dance_Simple");
 const audio=await upload("assets/audio","track.wav",dir+"/track.wav");expect(audio.key.endsWith("/track.wav")).toBe(true);
});
test.skipIf(!enabled || !process.env.EVENT_INTRO)("intro video upload returns a reusable OGV asset",async()=>{
 const body=new FormData();body.set("file",new File([await Bun.file(process.env.EVENT_INTRO!).arrayBuffer()],"intro.ogv"));
 const response=await app.handle(new Request("http://localhost/v1/admin/events/assets/intro",{method:"POST",headers:{Authorization:`Bearer ${staffToken}`},body}));
 expect(response.status).toBe(200);const result=await response.json() as any;expect(result.key.endsWith("/intro.ogv")).toBe(true);
 const edit=await req("POST","/v1/admin/events/",staffToken,{worldId:world,title:"Preshow test",bannerKey:key("banner.png"),config:{...config,introKey:result.key,introDuration:232.4667,segments:[{title:"Test",start:0,duration:120}]}});
 expect(edit.status).toBe(200);expect(edit.body.config.introUrl).toContain("intro.ogv");expect(edit.body.config.segments).toHaveLength(1);
});
