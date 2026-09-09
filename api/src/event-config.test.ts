import { expect, test } from "bun:test";
import { transition, validateShowConfig, inspectGlb, prepareAnimationGlb, showAssetKeys, serializeShowConfig } from "./event-config.ts";
const hash = "a".repeat(64);
const config = () => ({ artistKey:`events/${hash}/artist.ska`,animationKey:`events/${hash}/animation.glb`,audioKey:`events/${hash}/track.ogg`,clip:"Dance",duration:120,performer:[0,4.2,-44],yaw:180,scale:1,cameras:[{time:0,position:[0,6,-34],target:[0,5.6,-44],fov:40}] });
test("opening, restarting and closing have distinct state transitions",()=>{expect(transition("draft","open")).toBe("open");expect(transition("open","play")).toBe("live");expect(transition("live","stop")).toBe("open");expect(transition("live","close")).toBe("ended");expect(transition("ended","open")).toBe("open");expect(()=>transition("draft","play")).toThrow();expect(()=>transition("ended","play")).toThrow();});
test("show validates known stored asset kinds and rejects arbitrary URLs",()=>{expect(validateShowConfig(config()).duration).toBe(120);expect(()=>validateShowConfig({...config(),artistKey:"http://localhost/secret"})).toThrow();expect(()=>validateShowConfig({...config(),artistKey:config().audioKey})).toThrow();});
test("camera paths cannot contain NaN, duplicate times, missing t=0 or self targets",()=>{const c=config();for(const cameras of [[{...c.cameras[0],time:1}],[c.cameras[0],c.cameras[0]],[{...c.cameras[0],fov:NaN}],[{...c.cameras[0],target:c.cameras[0].position}]])expect(()=>validateShowConfig({...c,cameras})).toThrow();});
test("external glTF resource paths are refused before engine import",()=>{const json=Buffer.from(JSON.stringify({asset:{version:"2.0"},buffers:[{uri:"file:///etc/passwd"}]}).padEnd(128," "));const b=Buffer.alloc(20+json.length);b.writeUInt32LE(0x46546c67);b.writeUInt32LE(2,4);b.writeUInt32LE(b.length,8);b.writeUInt32LE(json.length,12);b.writeUInt32LE(0x4e4f534a,16);json.copy(b,20);expect(()=>inspectGlb(b)).toThrow("Embed");});

test("unnamed and duplicate clips receive unique engine-safe names",()=>{const json=Buffer.from(JSON.stringify({asset:{version:"2.0"},skins:[{}],animations:[{}, {name:"Dance/Take"},{name:"Dance:Take"}]}));const b=Buffer.alloc(20+json.length);b.writeUInt32LE(0x46546c67);b.writeUInt32LE(2,4);b.writeUInt32LE(b.length,8);b.writeUInt32LE(json.length,12);b.writeUInt32LE(0x4e4f534a,16);json.copy(b,20);const result=prepareAnimationGlb(b);expect(result.clips.map((c:any)=>c.name)).toEqual(["Animation_1","Dance_Take","Dance_Take_2"]);expect(inspectGlb(result.bytes).animations[2].name).toBe("Dance_Take_2");});
test("intro, set list and lighting survive validation; malformed cues are rejected",()=>{
 const c={...config(),introKey:`events/${hash}/intro.ogv`,introDuration:232.4,segments:[{title:"Song",start:0,duration:120}],lights:[{time:0,color:[.3,.5,1],energy:1}],mouth:[0,.4,.2],cameras:[{...config().cameras[0],cut:true}]};
 expect(validateShowConfig(c).introKey).toBe(c.introKey);expect(validateShowConfig(c).segments).toHaveLength(1);expect(validateShowConfig(c).cameras[0]!.cut).toBe(true);
 expect(()=>validateShowConfig({...c,introKey:`events/${hash}/track.ogg`})).toThrow();
 expect(()=>validateShowConfig({...c,segments:[{title:"Too long",start:119,duration:20}]})).toThrow();
 expect(()=>validateShowConfig({...c,lights:[{time:0,color:[5,0,1],energy:1}]})).toThrow();
 expect(()=>validateShowConfig({...c,mouth:[NaN]})).toThrow();
});
test("entrance path survives saving and rejects malformed or unordered movement",()=>{
 const performerPath=[{time:0,position:[-8,4.2,-44],yaw:270},{time:20,position:[0,4.2,-44],yaw:180}];
 expect(validateShowConfig({...config(),performerPath}).performerPath).toEqual(performerPath);
 for(const path of [[performerPath[1]], [performerPath[0],performerPath[0]], [{...performerPath[0],yaw:NaN}], [{...performerPath[0],position:[0,Infinity,0]}]])
  expect(()=>validateShowConfig({...config(),performerPath:path})).toThrow();
});

test("beat and mouth analysis survives saving with bounded sample rates",()=>{
 const analysis={mouth:[0,.8,0],mouthGain:1.05,mouthFps:25,mouthRound:[0,.3,0],beats:[0,1,.1],musicEnergy:[0,.7,.8],musicFps:25};
 const result=validateShowConfig({...config(),...analysis});
 expect(result.mouthGain).toBe(1.05);expect(result.beats).toEqual(analysis.beats);expect(result.mouthFps).toBe(25);expect(result.mouthRound).toEqual(analysis.mouthRound);
 for(const invalid of [{mouthGain:NaN},{mouthGain:3},{musicFps:0},{mouthFps:Infinity},{beats:[NaN]},{musicEnergy:[2]},{mouthRound:[-1]}]) expect(()=>validateShowConfig({...config(),...analysis,...invalid})).toThrow();
});

test("millisecond song boundaries tolerate floating-point addition but reject overlaps",()=>{
 const segments=[{title:"A",start:0,duration:243.234},{title:"B",start:243.234,duration:270.374},{title:"C",start:513.608,duration:10}];
 expect(validateShowConfig({...config(),duration:524,segments}).segments).toHaveLength(3);
 expect(()=>validateShowConfig({...config(),duration:524,segments:[segments[0],{...segments[1],start:243.2}]})).toThrow();
});

test("authored lighting looks, fades and sparse accents survive portable import",()=>{
 const lights=[{time:0,color:[.2,.4,.8],energy:.3,look:"intimate",fade:6,accent:0},{time:94,color:[.3,.7,1],energy:.8,look:"lift",fade:1.3,accent:.5}];
 expect(validateShowConfig({...config(),lights}).lights).toEqual(lights);
 for(const invalid of [{look:"arbitrary"},{fade:NaN},{fade:0},{fade:31},{accent:-1},{accent:Infinity},{accent:2}])
  expect(()=>validateShowConfig({...config(),lights:[{...lights[0],...invalid}]})).toThrow();
});

test("reveal and simultaneous deterministic stage effects survive save and reject malformed cues",()=>{
 const fire={time:20,duration:.8,kind:"fire",strength:.8,group:0,seed:42};
 const smoke={...fire,kind:"smoke",duration:6};
 const c={...config(),revealTime:20,effects:[fire,smoke]};
 const saved=validateShowConfig(c);
 expect(saved.revealTime).toBe(20);expect(saved.effects).toEqual(c.effects);
 expect(validateShowConfig(config()).effects).toEqual([]);
 for(const bad of [{time:NaN},{time:-1},{time:119.5,duration:2},{duration:0},{duration:16},{kind:"arbitrary"},{strength:2},{group:4},{group:.5},{seed:-1},{seed:Infinity}])
  expect(()=>validateShowConfig({...c,effects:[{...fire,...bad}]})).toThrow();
 for(const revealTime of [-1,121,NaN])expect(()=>validateShowConfig({...c,revealTime})).toThrow();
 expect(()=>validateShowConfig({...c,effects:[{...fire,time:40},fire]})).toThrow();
 expect(()=>validateShowConfig({...c,effects:Array(513).fill(fire)})).toThrow();
});

test("stage audio is opt-in with paired stored tracks, bounded gain and independent intro audio",()=>{
 const defaults=validateShowConfig(config());
 expect(defaults.stageAudio).toBe(false);expect(defaults.stageAudioGainDb).toBe(-6);expect(defaults.lightSticks).toBe(false);
 const aux={stageAudio:true,stageAudioLeftKey:`events/${"b".repeat(64)}/track.ogg`,stageAudioRightKey:`events/${"c".repeat(64)}/track.wav`,introAudioKey:`events/${"d".repeat(64)}/track.mp3`,stageAudioGainDb:-9,lightSticks:true};
 const saved=validateShowConfig({...config(),...aux});
 for(const [field,value] of Object.entries(aux))expect((saved as any)[field]).toEqual(value);
 for(const invalid of [
  {stageAudio:true},{stageAudio:true,stageAudioLeftKey:aux.stageAudioLeftKey},{stageAudio:true,stageAudioRightKey:aux.stageAudioRightKey},
  {stageAudio:"true"},{lightSticks:1},{stageAudioGainDb:1},{stageAudioGainDb:-31},{stageAudioGainDb:NaN},{stageAudioGainDb:Infinity},
  {stageAudioLeftKey:config().artistKey},{stageAudioRightKey:"https://example.com/track.ogg"},{introAudioKey:`events/${hash}/intro.ogv`},{introAudioKey:""},
 ])expect(()=>validateShowConfig({...config(),...invalid})).toThrow();
 expect(validateShowConfig({...config(),introAudioKey:aux.introAudioKey,stageAudioLeftKey:null,stageAudioRightKey:null}).introAudioKey).toBe(aux.introAudioKey);
 expect(validateShowConfig({...config(),stageAudioGainDb:-30}).stageAudioGainDb).toBe(-30);
 expect(validateShowConfig({...config(),stageAudioGainDb:0}).stageAudioGainDb).toBe(0);
});

test("all auxiliary assets participate in create/edit existence checks and URLs come only from keys",()=>{
 const aux={stageAudio:true,stageAudioLeftKey:`events/${"b".repeat(64)}/track.ogg`,stageAudioRightKey:`events/${"c".repeat(64)}/track.ogg`,introAudioKey:`events/${"d".repeat(64)}/track.ogg`,introKey:`events/${hash}/intro.ogv`,introDuration:60};
 const saved=validateShowConfig({...config(),...aux,stageAudioLeftUrl:"file:///secret",introAudioUrl:"http://localhost/secret"});
 expect(showAssetKeys(saved)).toEqual([saved.artistKey,saved.animationKey,saved.audioKey,aux.introKey,aux.stageAudioLeftKey,aux.stageAudioRightKey,aux.introAudioKey]);
 const urls=serializeShowConfig(saved,key=>`https://assets.example/${key}`);
 expect(urls.stageAudioLeftUrl).toBe(`https://assets.example/${aux.stageAudioLeftKey}`);
 expect(urls.stageAudioRightUrl).toBe(`https://assets.example/${aux.stageAudioRightKey}`);
 expect(urls.introAudioUrl).toBe(`https://assets.example/${aux.introAudioKey}`);
 const empty=serializeShowConfig(validateShowConfig(config()),key=>key);
 expect(empty.stageAudioLeftUrl).toBeNull();expect(empty.stageAudioRightUrl).toBeNull();expect(empty.introAudioUrl).toBeNull();
});

test("laser cue patterns survive saving and reject unknown patterns",()=>{
 const cue={time:20,duration:4,kind:"laser",strength:.6,group:3,seed:17};
 for(const pattern of ["lines","fan","comet"]){const effects=[{...cue,pattern}];expect(validateShowConfig({...config(),effects}).effects).toEqual(effects);}
 expect(validateShowConfig({...config(),effects:[cue]}).effects).toEqual([cue]);
 for(const pattern of ["", "solid", null, 3])expect(()=>validateShowConfig({...config(),effects:[{...cue,pattern}]})).toThrow();
});

test("a YouTube watch-party does not need concert performer assets",()=>{
 const video={duration:7200,videoUrl:"https://www.youtube.com/watch?v=9VIcgVU4f1E",preshowVideoUrl:"https://www.youtube.com/watch?v=S6C7og5g7Dc",preshowStartSeconds:1775,scheduledStart:1788962400000};
 const saved=validateShowConfig(video);
 expect(saved.videoUrl).toBe(video.videoUrl);
 expect(saved.preshowVideoUrl).toBe(video.preshowVideoUrl);
 expect(saved.preshowStartSeconds).toBe(1775);
 expect(saved.scheduledStart).toBe(1788962400000);
 expect(saved.cameras).toEqual([]);
 expect(showAssetKeys(saved)).toEqual([]);
 expect(serializeShowConfig(saved,key=>key).artistUrl).toBeNull();
 expect(()=>validateShowConfig({...video,videoUrl:"http://youtube.com/watch?v=x"})).toThrow();
 expect(()=>validateShowConfig({...video,videoUrl:"https://example.com/watch"})).toThrow();
 expect(()=>validateShowConfig({duration:7200})).toThrow();
});
