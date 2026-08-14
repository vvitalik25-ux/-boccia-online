import { DurableObject } from "cloudflare:workers";

const EMPTY_ROOM_TTL_MS = 30 * 60 * 1000;
const ROOM_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
let C = { x: 0, y: 0, w: 288, h: 600 };
let BW = C.w / 6;
let BALL_R = Math.max(7.8, Math.min(12.5, C.w * .032));
const MIN_SPEED = 0.045;

function setPhysicsProfile(profile){
  const w=clamp(profile?.w??288,120,1200);
  const h=clamp(profile?.h??w*(12.5/6),250,2500);
  const r=clamp(
    profile?.r??Math.max(7.8,Math.min(12.5,w*.032)),
    5,
    20
  );

  C={x:0,y:0,w,h};
  BW=C.w/6;
  BALL_R=r;
}

const BALL_TYPES = [
  { id: "superHard", decel: .060, restitution: .58, damping: .95, mass: 1.14 },
  { id: "hard", decel: .071, restitution: .51, damping: .93, mass: 1.09 },
  { id: "medium", decel: .085, restitution: .43, damping: .89, mass: 1.03 },
  { id: "mediumSoft", decel: .098, restitution: .35, damping: .85, mass: .99 },
  { id: "soft", decel: .113, restitution: .27, damping: .80, mass: .95 },
  { id: "superSoft", decel: .130, restitution: .19, damping: .75, mass: .91 },
];
const BALL_TYPE_MAP = Object.fromEntries(BALL_TYPES.map((x) => [x.id, x]));
const STANDARD_KIT = BALL_TYPES.map((x) => x.id);

const FORMAT_CONFIGS = {
  individual: { id:"individual", redBoxes:[3], blueBoxes:[4], perPlayer:6, totalEnds:4, jackOrder:[3,4,3,4] },
  pairs: { id:"pairs", redBoxes:[2,4], blueBoxes:[3,5], perPlayer:3, totalEnds:4, jackOrder:[2,3,4,5] },
  teams: { id:"teams", redBoxes:[1,3,5], blueBoxes:[2,4,6], perPlayer:2, totalEnds:6, jackOrder:[1,2,3,4,5,6] },
};

function cors(headers={}) {
  return {
    "Access-Control-Allow-Origin":"*",
    "Access-Control-Allow-Methods":"GET,OPTIONS",
    "Access-Control-Allow-Headers":"Content-Type",
    ...headers
  };
}
function json(data,status=200){
  return new Response(JSON.stringify(data),{
    status,
    headers:cors({"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"})
  });
}
function clone(v){return v==null?v:JSON.parse(JSON.stringify(v))}
function clamp(v,a,b){return Math.max(a,Math.min(b,Number(v)))}
function opponent(side){return side==="red"?"blue":"red"}
function cfg(s){return FORMAT_CONFIGS[s.matchFormat]||FORMAT_CONFIGS.individual}
function sideBoxes(s,side){return side==="red"?cfg(s).redBoxes:cfg(s).blueBoxes}
function sideForBox(s,box){return cfg(s).redBoxes.includes(Number(box))?"red":"blue"}
function totalSideBalls(s){return cfg(s).perPlayer*cfg(s).redBoxes.length}
function jackBoxForEnd(s,n){const a=cfg(s).jackOrder;return a[(Math.max(1,n)-1)%a.length]}
function nextJackBoxAfter(s,box){const a=cfg(s).jackOrder,i=a.indexOf(Number(box));return a[(i>=0?i+1:0)%a.length]}
function currentSide(s){
  if(s.phase==="red"||s.phase==="jackRed")return"red";
  if(s.phase==="blue"||s.phase==="jackBlue")return"blue";
  return null;
}
function sidePhase(side,kind="colour"){return kind==="jack"?(side==="red"?"jackRed":"jackBlue"):side}
function ballsLeft(s,side){return side==="red"?s.redLeft:s.blueLeft}
function setBallsLeft(s,side,n){if(side==="red")s.redLeft=n;else s.blueLeft=n}
function mx(m){return C.w*(m/6)}
function my(m){return C.h*(m/12.5)}
function throwingY(){return my(10)}
function crossPoint(){return{x:mx(3),y:my(5)}}
function vYAtX(x){
  const leftY=my(7),vertexY=my(8.5),mid=C.w/2;
  if(x<=mid){const t=clamp(x/(C.w/2),0,1);return leftY+(vertexY-leftY)*t}
  const t=clamp((x-mid)/(C.w/2),0,1);return vertexY+(leftY-vertexY)*t;
}
function ballType(id){return BALL_TYPE_MAP[id]||BALL_TYPE_MAP.medium}
function physicsFor(b){return ballType(b.hardnessId||(b.kind==="jack"?"soft":"medium"))}
function dist(a,b){return Math.hypot(a.x-b.x,a.y-b.y,(a.z||0)-(b.z||0))}
function realismSoftnessFactor(id=null){
  const map={superHard:.45,hard:.58,medium:.72,mediumSoft:.87,soft:1.02,superSoft:1.18};
  return map[id||"soft"]??1.02;
}
function createRealismProfile(realistic,kind,id=null){
  if(!realistic)return null;
  const softness=realismSoftnessFactor(id||(kind==="jack"?"soft":"medium"));
  return{
    seed:Math.random()*Math.PI*2,phase:Math.random()*Math.PI*2,
    phaseSpeed:.08+softness*.05+Math.random()*.025,
    floorBias:(Math.random()-.5)*.0075*softness,
    wobble:.0034*softness+Math.random()*.0026*softness,
    forward:.0018*softness+Math.random()*.0014*softness,
    decelBias:1+(Math.random()-.5)*.18*softness,
    decelWave:.070*softness+Math.random()*.042*softness,
    releaseAngle:(Math.random()-.5)*(.016+.031*softness),
    releaseSpeed:1+((Math.random()-.5)*(.020+.038*softness)),
    slowThreshold:.62+Math.random()*.18,
    slipChance:.010*softness+Math.random()*.010*softness,
    slipStrength:.0038*softness+Math.random()*.0042*softness,
    holdFrames:0,holdDir:Math.random()<.5?-1:1
  };
}
function applyRealismToLaunch(realistic,vx,vy,kind,id){
  if(!realistic)return{vx,vy};
  const p=createRealismProfile(true,kind,id);
  const a=p.releaseAngle,c=Math.cos(a),sn=Math.sin(a),sp=p.releaseSpeed;
  return{vx:(vx*c-vy*sn)*sp,vy:(vx*sn+vy*c)*sp};
}
function defaultLauncherPositions(){
  return{1:{u:.5,v:.54},2:{u:.5,v:.54},3:{u:.5,v:.54},4:{u:.5,v:.54},5:{u:.5,v:.54},6:{u:.5,v:.54}};
}
function launcherPointForBox(s,box){
  const p=s.launcherPositions[box]||{u:.5,v:.54},top=throwingY(),bottom=my(12.5);
  return{x:BW*(box-1)+BW*p.u,y:top+(bottom-top)*p.v};
}
function defaultAllocationForSide(s,side){
  const boxes=sideBoxes(s,side),per=cfg(s).perPlayer,out={};
  boxes.forEach(b=>out[b]=[]);
  let n=0;
  for(const id of STANDARD_KIT){
    const b=boxes[Math.floor(n/per)%boxes.length];
    if(out[b].length<per)out[b].push(id);
    n++;
  }
  return out;
}
function resetBallInventory(s){
  s.ballAllocation={red:defaultAllocationForSide(s,"red"),blue:defaultAllocationForSide(s,"blue")};
  s.ballInventory={red:[],blue:[]};
  for(const side of["red","blue"]){
    for(const box of sideBoxes(s,side)){
      for(const id of(s.ballAllocation[side][box]||[]))s.ballInventory[side].push({id,used:false,ownerBox:Number(box)});
    }
  }
  s.selectedBall={red:"medium",blue:"medium"};
  s.activePlayerBox={red:sideBoxes(s,"red")[0],blue:sideBoxes(s,"blue")[0]};
  ensureActivePlayer(s,"red");ensureActivePlayer(s,"blue");
}
function unusedItemsForBox(s,side,box){return s.ballInventory[side].filter(x=>!x.used&&x.ownerBox===Number(box))}
function remainingForBox(s,side,box){return unusedItemsForBox(s,side,box).length}
function availableBoxes(s,side){return sideBoxes(s,side).filter(b=>remainingForBox(s,side,b)>0)}
function ensureActivePlayer(s,side){
  const locked=s.firstColourLockedBox[side];
  if(locked&&remainingForBox(s,side,locked)>0){s.activePlayerBox[side]=locked;return locked}
  if(remainingForBox(s,side,s.activePlayerBox[side])>0)return s.activePlayerBox[side];
  s.activePlayerBox[side]=availableBoxes(s,side)[0]??sideBoxes(s,side)[0];
  return s.activePlayerBox[side];
}
function availableBallIds(s,side){const box=ensureActivePlayer(s,side);return unusedItemsForBox(s,side,box).map(x=>x.id)}
function isBallAvailable(s,side,id){const box=ensureActivePlayer(s,side);return unusedItemsForBox(s,side,box).some(x=>x.id===id)}
function ensureSelectedBall(s,side){
  ensureActivePlayer(s,side);
  if(isBallAvailable(s,side,s.selectedBall[side]))return s.selectedBall[side];
  const pref=["medium","mediumSoft","soft","hard","superSoft","superHard"];
  s.selectedBall[side]=pref.find(id=>isBallAvailable(s,side,id))||availableBallIds(s,side)[0]||"medium";
  return s.selectedBall[side];
}
function consumeBall(s,side,id){
  const box=ensureActivePlayer(s,side);
  const item=s.ballInventory[side].find(x=>x.id===id&&!x.used&&x.ownerBox===box);
  if(!item)return false;item.used=true;return true;
}
function createInitialState(config){
  setPhysicsProfile(config?.physicsProfile);
  const format="individual";
  const s={
    version:30,revision:0,matchFormat:"individual",
    fieldOrientation:config.fieldOrientation==="horizontal"?"horizontal":"vertical",
    realisticMode:!!config.realisticMode,
    physicsProfile:clone(config.physicsProfile||{w:288,h:600,r:Math.max(7.8,Math.min(12.5,288*.032))}),
    totalEnds:FORMAT_CONFIGS.individual.totalEnds,endNo:1,
    redScore:0,blueScore:0,redLeft:0,blueLeft:0,phase:"jackRed",currentJackBox:3,
    activePlayerBox:{red:3,blue:4},firstColourLockedBox:{red:null,blue:null},
    lastColourSide:null,jackNeedsCross:false,tieBreak:false,tieFirst:null,
    equidistantSequence:false,equidistantNextSide:null,selectedBall:{red:"medium",blue:"medium"},
    jackHardness:{red:"soft",blue:"soft"},currentJackHardness:"soft",
    kitConfig:{red:[...STANDARD_KIT],blue:[...STANDARD_KIT]},
    ballAllocation:{red:{},blue:{}},ballInventory:{red:[],blue:[]},
    launcherPositions:defaultLauncherPositions(),jack:null,balls:[],matchStarted:true,modal:null
  };
  s.redLeft=totalSideBalls(s);s.blueLeft=totalSideBalls(s);resetBallInventory(s);
  s.currentJackBox=jackBoxForEnd(s,1);
  const js=sideForBox(s,s.currentJackBox);s.activePlayerBox[js]=s.currentJackBox;s.phase=sidePhase(js,"jack");
  return s;
}
function toSim(o){
  if(!o)return null;
  return{
    kind:o.kind,side:o.side,x:(Number(o.u)||0)*C.w,y:(Number(o.v)||0)*C.h,z:(Number(o.z)||0)*C.w,
    vx:0,vy:0,vz:0,r:BALL_R,hitCd:0,entered:!!o.entered,
    hardnessId:o.hardnessId||(o.kind==="jack"?"soft":"medium"),
    realism:o.realism?clone(o.realism):null,_shot:false
  };
}
function fromSim(o){
  if(!o)return null;
  return{
    kind:o.kind,side:o.side,u:o.x/C.w,v:o.y/C.h,z:(o.z||0)/C.w,
    hardnessId:o.hardnessId||(o.kind==="jack"?"soft":"medium"),entered:!!o.entered,
    realism:o.realism?clone(o.realism):null
  };
}
function animationMetaFor(objects){
  return objects.map(o=>({
    kind:o.kind,
    side:o.side,
    hardnessId:o.hardnessId||(o.kind==="jack"?"soft":"medium")
  }));
}
function captureExactAnimationFrame(objects){
  return objects.map(o=>{
    if(o._dead)return null;
    return[o.x/C.w,o.y/C.h,(o.z||0)/C.w];
  });
}
function speedFromPower(power){
  const min=4.3,max=Math.sqrt(2*BALL_TYPE_MAP.medium.decel*C.h*.96)*1.12;
  return min+(max-min)*clamp(power,.08,1);
}
function isInsideBoundary(b){return b.x-b.r>C.x&&b.x+b.r<C.w&&b.y-b.r>C.y&&b.y+b.r<C.h}
function isJackValidSim(b){return !!b&&isInsideBoundary(b)&&b.y+b.r<vYAtX(b.x)}
function applyGravityAndFloor(b){
  if((b.z||0)>0||(b.vz||0)!==0){
    b.vz=(b.vz||0)-.070;b.z=(b.z||0)+b.vz;
    if(b.z<0){b.z=0;if(Math.abs(b.vz)<.15)b.vz=0;else b.vz*=-.14}
  }
}
function softCompressionFactor(b){
  const id=b.hardnessId||(b.kind==="jack"?"soft":"medium");
  return({superHard:.992,hard:.982,medium:.968,mediumSoft:.950,soft:.932,superSoft:.914})[id]??.968;
}
function supportLiftFor(top,support){
  const sumR=top.r+support.r,compression=(softCompressionFactor(top)+softCompressionFactor(support))/2,effective=sumR*compression;
  const dx=top.x-support.x,dy=top.y-support.y,h=Math.hypot(dx,dy);
  if(h>=effective)return null;return(support.z||0)+Math.sqrt(Math.max(0,effective*effective-h*h));
}
function climbFactor(b){const p=physicsFor(b);return Math.max(.72,Math.min(1.28,1.18-(p.restitution-.19)*.75))}
function resolveMultiSupportStacking(objs){
  for(const top of objs){
    const speed=Math.hypot(top.vx||0,top.vy||0),candidates=[];
    for(const s of objs){
      if(s===top)continue;if((s.z||0)>(top.z||0)+top.r*.55)continue;
      const dx=s.x-top.x,dy=s.y-top.y,h=Math.hypot(dx,dy),range=(top.r+s.r)*1.03;
      if(h<range){const lift=supportLiftFor(top,s);if(lift!==null)candidates.push({s,dx,dy,h,lift})}
    }
    if(candidates.length<2)continue;
    let bestPair=null,bestQuality=-Infinity;
    for(let i=0;i<candidates.length;i++)for(let j=i+1;j<candidates.length;j++){
      const a=candidates[i],b=candidates[j],la=Math.max(.001,a.h),lb=Math.max(.001,b.h);
      const dot=(a.dx*b.dx+a.dy*b.dy)/(la*lb),spread=(1-dot)/2;if(spread<.34)continue;
      const gap=Math.hypot(a.s.x-b.s.x,a.s.y-b.s.y),maxGap=(a.s.r+b.s.r)*1.32;if(gap>maxGap)continue;
      const target=Math.max(a.lift,b.lift),quality=spread*2.2-Math.abs(a.lift-b.lift)/(top.r*2)-gap/(maxGap*8);
      if(quality>bestQuality){bestQuality=quality;bestPair={target}}
    }
    if(!bestPair)continue;
    const cf=climbFactor(top),relativeLift=Math.max(0,bestPair.target-(top.z||0));
    if(speed>.55){
      const threshold=.62/cf;
      if(speed>threshold){
        const energy=Math.min(1.8,speed/5.2),desired=Math.min(bestPair.target,(top.z||0)+relativeLift*(.48+.38*Math.min(1,energy)));
        top.z=Math.max(top.z||0,desired);
        if(speed>4){top.vz=Math.max(top.vz||0,Math.min(1.70,(speed-2)*.17*cf));const keep=.88+Math.min(.08,speed*.008);top.vx*=keep;top.vy*=keep}
        else{top.vz=Math.max(top.vz||0,.12*cf);top.vx*=.78;top.vy*=.78}
      }
    }
    if((top.z||0)>top.r*.28&&speed<1.25){
      const target=bestPair.target*.965;
      if(top.z<target)top.z+=(target-top.z)*.42;else if(top.z>target+top.r*.18)top.z+=(target-top.z)*.12;
      if(Math.abs(top.vz||0)<.24)top.vz=0;top.vx*=.90;top.vy*=.90;
    }
  }
}
function resolve3DBallContact(a,b){
  const pa=physicsFor(a),pb=physicsFor(b),dx=b.x-a.x,dy=b.y-a.y,dz=(b.z||0)-(a.z||0),horiz=Math.hypot(dx,dy);
  const d3=Math.sqrt(dx*dx+dy*dy+dz*dz),min=a.r+b.r;if(d3<=0||d3>=min)return false;
  const nx=dx/(horiz||1),ny=dy/(horiz||1),ma=pa.mass,mb=pb.mass,total=ma+mb,overlap=min-d3;
  const verticalShare=Math.min(.92,Math.abs(dz)/(min*.74)),elevated=Math.min(1,Math.max(a.z||0,b.z||0)/(min*.72));
  const push=overlap*(1-verticalShare*.78)*(1-elevated*.58);
  a.x-=nx*push*(mb/total);a.y-=ny*push*(mb/total);b.x+=nx*push*(ma/total);b.y+=ny*push*(ma/total);
  const rvx=b.vx-a.vx,rvy=b.vy-a.vy,along=rvx*nx+rvy*ny;
  if(along<0){
    const rel=Math.abs(along),e=(pa.restitution+pb.restitution)/2,compact=horiz<min*.94,threshold=.55+e*.45;
    if(compact&&rel>threshold){
      const mover=Math.hypot(a.vx,a.vy)>=Math.hypot(b.vx,b.vy)?a:b,support=mover===a?b:a,cf=climbFactor(mover);
      const lift=supportLiftFor(mover,support),maxZ=(mover.r+support.r)*.92;
      if(lift!==null){const gain=Math.min(1,rel/4.5);mover.z=Math.max(mover.z||0,Math.min(maxZ,(mover.z||0)+(lift-(mover.z||0))*(.30+.42*gain)))}
      if(rel>3.2)mover.vz=Math.max(mover.vz||0,Math.min(1.55,(rel-1.7)*.16*cf));else mover.vz=Math.max(mover.vz||0,Math.min(.58,rel*.10*cf));
    }
    const imp=-(1+e)*along/(1/ma+1/mb);
    a.vx-=imp*nx/ma;a.vy-=imp*ny/ma;b.vx+=imp*nx/mb;b.vy+=imp*ny/mb;
    const damp=Math.sqrt(pa.damping*pb.damping);a.vx*=damp;a.vy*=damp;b.vx*=damp;b.vy*=damp;
  }
  const top=(a.z||0)>=(b.z||0)?a:b,bottom=top===a?b:a,h=Math.hypot(top.x-bottom.x,top.y-bottom.y);
  if(h<min*.78&&(top.z||0)>0){const allowed=Math.sqrt(Math.max(0,min*min-h*h)),target=(bottom.z||0)+allowed*.72;if(top.z<target){top.z=Math.min(target,top.z+overlap*.32);top.vz=Math.max(0,top.vz||0)}}
  return true;
}
function simulateThrow(s,shot){
  setPhysicsProfile(s.physicsProfile);

  let jack=toSim(s.jack),balls=(s.balls||[]).map(toSim);
  const animationFrames=[];
  const events=[];
  const pos=launcherPointForBox(s,shot.box),a=shot.angle*Math.PI/180,speed=speedFromPower(shot.power);
  const launch=applyRealismToLaunch(s.realisticMode,Math.sin(a)*speed,-Math.cos(a)*speed,shot.kind==="jack"?"jack":shot.side,shot.hardnessId);
  const moving={
    kind:shot.kind==="jack"?"jack":shot.side,side:shot.side,x:pos.x,y:pos.y,z:0,vx:launch.vx,vy:launch.vy,vz:0,
    r:BALL_R,hitCd:0,entered:false,hardnessId:shot.hardnessId,
    realism:createRealismProfile(s.realisticMode,shot.kind==="jack"?"jack":shot.side,shot.hardnessId),_shot:true
  };
  if(moving.realism)moving.realism.startSpeed=Math.hypot(moving.vx,moving.vy);
  if(shot.kind==="jack")jack=moving;else balls.push(moving);
  let jackFouled=false,settle=0;

  const animationObjects=jack?[jack,...balls]:[...balls];
  const animationMeta=animationMetaFor(animationObjects);

  for(let step=0;step<1500;step++){
    const objs=jack?[jack,...balls]:[...balls];
    for(const b of objs){
      b.x+=b.vx;b.y+=b.vy;applyGravityAndFloor(b);if(b.y-b.r<throwingY())b.entered=true;
      const sp=Math.hypot(b.vx,b.vy);
      if(sp>0){
        const pp=physicsFor(b);
        if(s.realisticMode&&b.realism&&(b.z||0)===0){
          if(!b.realism.startSpeed||sp>b.realism.startSpeed)b.realism.startSpeed=sp;
          const ux=b.vx/sp,uy=b.vy/sp,px=-uy,py=ux,start=Math.max(.001,b.realism.startSpeed||sp);
          const ratio=clamp(sp/start,0,1),inst=Math.pow(1-ratio,1.65);
          const low=sp<=b.realism.slowThreshold?1+((b.realism.slowThreshold-sp)/Math.max(.08,b.realism.slowThreshold))*1.35:1;
          const drift=.05+inst*1.45*low;b.realism.phase+=b.realism.phaseSpeed*(.8+inst*.9);
          const side=(b.realism.floorBias+Math.sin(b.realism.phase+b.realism.seed)*b.realism.wobble)*drift;
          b.vx+=px*side;b.vy+=py*side;
          if(b.realism.holdFrames>0){const burst=b.realism.slipStrength*inst*low*b.realism.holdDir;b.vx+=px*burst;b.vy+=py*burst;b.realism.holdFrames--}
          else if(Math.random()<b.realism.slipChance*inst*low){b.realism.holdDir=Math.random()<.5?-1:1;b.realism.holdFrames=1+Math.floor(Math.random()*3)}
          const fwd=1+Math.sin(b.realism.phase*.67+b.realism.seed)*b.realism.forward*inst*low;b.vx*=fwd;b.vy*=fwd;
        }
        const base=pp.decel*(b.realism?.decelBias??1),wave=s.realisticMode&&b.realism?(1+Math.sin((b.realism.phase||0)*.53+b.realism.seed)*(b.realism.decelWave||0)):1;
        const decel=Math.max(pp.decel*.55,base*wave),ns=Math.max(0,sp-decel),k=ns/sp;b.vx*=k;b.vy*=k;
      }
      if(Math.hypot(b.vx,b.vy)<MIN_SPEED){b.vx=0;b.vy=0}if(b.hitCd>0)b.hitCd--;
    }
    const objs2=jack?[jack,...balls]:[...balls];resolveMultiSupportStacking(objs2);
    for(let i=0;i<objs2.length;i++)for(let j=i+1;j<objs2.length;j++)resolve3DBallContact(objs2[i],objs2[j]);
    resolveMultiSupportStacking(objs2);

    for(const b of [...(jack?[jack]:[]),...balls]){
      const out=b.x-b.r<=0||b.x+b.r>=C.w||b.y-b.r<=0||b.y+b.r>=C.h;if(!out)continue;
      b.vx=b.vy=0;
      if(b.kind==="jack"){
        b._dead=true;
        if(b._shot&&shot.kind==="jack"){
          jackFouled=true;
          jack=null;
        }else{
          jack=null;
          s.jackNeedsCross=true;
        }
      }else{
        // This is exactly the toast used by local 1 × 1 physics().
        events.push({
          type:"ball_out",
          frame:animationFrames.length,
          message:"Мяч вне площадки"
        });
        b._dead=true;
        const idx=balls.indexOf(b);if(idx>=0)balls.splice(idx,1);
      }
    }

    // One saved frame == one local physics() step.
    animationFrames.push(captureExactAnimationFrame(animationObjects));

    const all=jack?[jack,...balls]:[...balls];
    const any=all.some(b=>Math.hypot(b.vx,b.vy)>.06||Math.abs(b.vz||0)>.05);
    if(!any)settle++;else settle=0;if(settle>13)break;
  }

  const shotBall=shot.kind==="jack"?(jack&&jack._shot?jack:null):(balls.find(b=>b._shot)||null);
  if(shotBall&&!shotBall.entered){
    if(shot.kind==="jack"){
      shotBall._dead=true;
      jackFouled=true;
      jack=null;
    }else{
      events.push({
        type:"ball_not_entered",
        frame:Math.max(0,animationFrames.length-1),
        message:"Мяч не вошёл в игровую зону"
      });
      shotBall._dead=true;
      const idx=balls.indexOf(shotBall);if(idx>=0)balls.splice(idx,1);
    }

    // In local physics this removal happens in the same settle frame before draw().
    if(animationFrames.length){
      animationFrames[animationFrames.length-1]=captureExactAnimationFrame(animationObjects);
    }
  }

  for(const b of balls)delete b._shot;
  if(jack)delete jack._shot;

  s.jack=fromSim(jack);
  s.balls=balls.map(fromSim);

  return{
    jackFouled,
    events,
    animation:{
      mode:"local-1v1-raf",
      objects:animationMeta,
      frames:animationFrames
    }
  };
}
function jackCrossPlacementPoint(s){
  const p=crossPoint(),balls=(s.balls||[]).map(toSim),blockers=balls.filter(b=>Math.hypot(b.x-p.x,b.y-p.y)<BALL_R+b.r);
  if(!blockers.length)return p;
  const maxY=throwingY()-BALL_R-1;
  for(let y=p.y;y<=maxY;y+=.5){if(balls.every(b=>Math.hypot(p.x-b.x,y-b.y)>=BALL_R+b.r-.05))return{x:p.x,y}}
  return{x:p.x,y:Math.min(maxY,p.y+BALL_R*2)};
}
function placeJackOnCross(s){
  const p=jackCrossPlacementPoint(s);
  s.jack={kind:"jack",side:"neutral",u:p.x/C.w,v:p.y/C.h,z:0,hardnessId:s.currentJackHardness||"soft",entered:true,realism:createRealismProfile(s.realisticMode,"jack",s.currentJackHardness||"soft")};
  s.jackNeedsCross=false;
}
function scoreCurrentEnd(s){
  const eps=.55,j=toSim(s.jack);if(!j)return{red:0,blue:0};
  const reds=s.balls.filter(b=>b.kind==="red").map(b=>dist(toSim(b),j)).sort((a,b)=>a-b);
  const blues=s.balls.filter(b=>b.kind==="blue").map(b=>dist(toSim(b),j)).sort((a,b)=>a-b);
  const r0=reds[0]??Infinity,b0=blues[0]??Infinity;if(!isFinite(r0)&&!isFinite(b0))return{red:0,blue:0};
  if(Math.abs(r0-b0)<=eps)return{red:reds.filter(d=>Math.abs(d-r0)<=eps).length,blue:blues.filter(d=>Math.abs(d-b0)<=eps).length};
  if(r0<b0)return{red:reds.filter(d=>d<b0-eps).length,blue:0};
  return{red:0,blue:blues.filter(d=>d<r0-eps).length};
}
function sideToPlay(s){
  if(s.redLeft<=0&&s.blueLeft<=0){s.equidistantSequence=false;s.equidistantNextSide=null;return null}
  const j=toSim(s.jack),reds=s.balls.filter(b=>b.kind==="red").map(toSim),blues=s.balls.filter(b=>b.kind==="blue").map(toSim);
  if(!reds.length&&s.redLeft>0){s.equidistantSequence=false;s.equidistantNextSide=null;return"red"}
  if(!blues.length&&s.blueLeft>0){s.equidistantSequence=false;s.equidistantNextSide=null;return"blue"}
  if(s.redLeft<=0){s.equidistantSequence=false;s.equidistantNextSide=null;return"blue"}
  if(s.blueLeft<=0){s.equidistantSequence=false;s.equidistantNextSide=null;return"red"}
  const eps=.55,rd=Math.min(...reds.map(b=>dist(b,j))),bd=Math.min(...blues.map(b=>dist(b,j)));
  if(Math.abs(rd-bd)<=eps){
    const rc=reds.filter(b=>Math.abs(dist(b,j)-rd)<=eps).length,bc=blues.filter(b=>Math.abs(dist(b,j)-bd)<=eps).length;
    if(rc===bc){
      if(!s.equidistantSequence){s.equidistantSequence=true;s.equidistantNextSide=s.lastColourSide||"red"}
      else s.equidistantNextSide=opponent(s.equidistantNextSide||s.lastColourSide||"red");
      return s.equidistantNextSide;
    }
    s.equidistantSequence=false;s.equidistantNextSide=null;return rc<bc?"red":"blue";
  }
  s.equidistantSequence=false;s.equidistantNextSide=null;return rd<bd?"blue":"red";
}
function startRegulationEnd(s){
  s.balls=[];s.jack=null;s.redLeft=totalSideBalls(s);s.blueLeft=totalSideBalls(s);s.lastColourSide=null;s.jackNeedsCross=false;
  s.tieBreak=false;s.tieFirst=null;s.equidistantSequence=false;s.equidistantNextSide=null;s.firstColourLockedBox={red:null,blue:null};s.modal=null;
  resetBallInventory(s);s.currentJackBox=jackBoxForEnd(s,s.endNo);const js=sideForBox(s,s.currentJackBox);s.activePlayerBox[js]=s.currentJackBox;s.phase=sidePhase(js,"jack");
}
function startTieBreak(s,first){
  s.balls=[];s.redLeft=totalSideBalls(s);s.blueLeft=totalSideBalls(s);s.lastColourSide=null;s.jackNeedsCross=false;s.tieBreak=true;s.tieFirst=first;
  s.equidistantSequence=false;s.equidistantNextSide=null;s.firstColourLockedBox={red:null,blue:null};s.modal=null;resetBallInventory(s);
  s.currentJackHardness=s.jackHardness[first]||"soft";const p=crossPoint();
  s.jack={kind:"jack",side:"neutral",u:p.x/C.w,v:p.y/C.h,z:0,hardnessId:s.currentJackHardness,entered:true,realism:createRealismProfile(s.realisticMode,"jack",s.currentJackHardness)};
  s.phase=first;
}
function finishMatch(s,winner,tb){
  s.phase="finished";s.modal={title:`${winner==="red"?"Красные":"Синие"} победили! 🏆`,text:tb?`Основной матч ${s.redScore}:${s.blueScore}. Победитель определён в тай-брейке.`:`Финальный счёт ${s.redScore}:${s.blueScore}.`};
}
function finishEnd(s){
  s.phase="end";
  const pts=scoreCurrentEnd(s);

  if(s.tieBreak){
    const interim=clone(s);

    if(pts.red===pts.blue){
      const nextFirst=s.tieFirst==="red"?"blue":"red";
      startTieBreak(s,nextFirst);
      return{
        kind:"tiebreak_equal",
        points:pts,
        interimState:interim,
        resetAim:true,
        afterEvent:{type:"tiebreak_start",side:nextFirst}
      };
    }

    const winner=pts.red>pts.blue?"red":"blue";
    finishMatch(s,winner,true);
    return{
      kind:"tiebreak_win",
      winner,
      points:pts,
      interimState:interim,
      resetAim:false
    };
  }

  s.redScore+=pts.red;
  s.blueScore+=pts.blue;

  // Local updateUI() has already displayed this score while phase=end.
  const interim=clone(s);

  if(s.endNo>=s.totalEnds){
    if(s.redScore===s.blueScore){
      const first=Math.random()<.5?"red":"blue";
      startTieBreak(s,first);
      return{
        kind:"end",
        points:pts,
        interimState:interim,
        resetAim:true,
        afterEvent:{type:"tiebreak_start",side:first}
      };
    }

    finishMatch(s,s.redScore>s.blueScore?"red":"blue",false);
    return{
      kind:"end",
      points:pts,
      interimState:interim,
      resetAim:false
    };
  }

  s.endNo++;
  startRegulationEnd(s);

  return{
    kind:"end",
    points:pts,
    interimState:interim,
    resetAim:true
  };
}
function resolveJackThrow(s,side,fouled,events=[]){
  const j=toSim(s.jack);

  if(fouled||!j||!isJackValidSim(j)){
    s.jack=null;
    s.currentJackBox=nextJackBoxAfter(s,s.currentJackBox);
    const next=sideForBox(s,s.currentJackBox);

    events.push({
      type:"invalid_jack",
      nextBox:s.currentJackBox
    });

    s.activePlayerBox[next]=s.currentJackBox;
    s.phase=sidePhase(next,"jack");
    return;
  }

  events.push({type:"jack_in"});
  s.firstColourLockedBox[side]=s.currentJackBox;
  s.activePlayerBox[side]=s.currentJackBox;
  s.phase=side;
  ensureSelectedBall(s,side);
}
function resolveColourThrow(s,events=[]){
  const j=toSim(s.jack);

  if(s.jackNeedsCross||!j||!isJackValidSim(j)){
    placeJackOnCross(s);
    events.push({type:"jack_cross"});
  }

  if(s.redLeft<=0&&s.blueLeft<=0){
    return finishEnd(s);
  }

  const next=sideToPlay(s);
  if(!next){
    return finishEnd(s);
  }

  s.phase=next;
  ensureActivePlayer(s,next);
  ensureSelectedBall(s,next);
  return null;
}
function applyThrow(s,side,data){
  if(currentSide(s)!==side)throw new Error("Сейчас ход другого игрока");
  if(s.phase==="finished")throw new Error("Матч уже завершён");
  const kind=s.phase==="jackRed"||s.phase==="jackBlue"?"jack":"colour";
  const angle=clamp(data.angle,-58,58),power=clamp(data.power,.08,1),box=kind==="jack"?s.currentJackBox:ensureActivePlayer(s,side);
  let hardness;
  if(kind==="jack"){hardness=s.jackHardness[side]||"soft";s.currentJackHardness=hardness}
  else{
    hardness=ensureSelectedBall(s,side);if(!isBallAvailable(s,side,hardness))throw new Error("Выбранный мяч уже использован");
    if(!consumeBall(s,side,hardness))throw new Error("Не удалось списать мяч");
    setBallsLeft(s,side,ballsLeft(s,side)-1);s.lastColourSide=side;if(s.firstColourLockedBox[side])s.firstColourLockedBox[side]=null;
  }
  const result=simulateThrow(s,{side,kind,box,hardnessId:hardness,angle,power});
  const events=result.events||[];
  let transition=null;

  if(kind==="jack"){
    resolveJackThrow(s,side,result.jackFouled,events);
  }else{
    transition=resolveColourThrow(s,events);
  }

  return{
    state:s,
    animation:result.animation,
    events,
    transition
  };
}
function applySelectPlayer(s,side,data){
  if(currentSide(s)!==side||s.phase!==side)throw new Error("Сейчас нельзя менять спортсмена");
  const box=Number(data.box);if(!sideBoxes(s,side).includes(box))throw new Error("Этот бокс не принадлежит вашей стороне");
  if(s.firstColourLockedBox[side]&&s.firstColourLockedBox[side]!==box)throw new Error("Первый мяч после джека бросает тот же бокс");
  if(remainingForBox(s,side,box)<=0)throw new Error("У этого бокса не осталось мячей");
  s.activePlayerBox[side]=box;ensureSelectedBall(s,side);return s;
}
function applySelectBall(s,side,data){
  if(currentSide(s)!==side||s.phase!==side)throw new Error("Сейчас нельзя выбирать мяч");
  const id=String(data.hardnessId||"");if(!BALL_TYPE_MAP[id])throw new Error("Неизвестный тип мяча");
  if(!isBallAvailable(s,side,id))throw new Error("Такого мяча не осталось у активного бокса");
  s.selectedBall[side]=id;return s;
}
function applyLauncher(s,side,data){
  if(currentSide(s)!==side)throw new Error("Сейчас ход другого игрока");
  const expected=s.phase==="jackRed"||s.phase==="jackBlue"?s.currentJackBox:ensureActivePlayer(s,side),box=Number(data.box);
  if(box!==expected)throw new Error("Можно двигаться только в активном боксе");
  const margin=Math.max(4,BALL_R-1);
  const mu=margin/BW,mv=margin/(my(12.5)-throwingY());
  s.launcherPositions[box]={
    u:clamp(data.u,mu,1-mu),
    v:clamp(data.v,mv,1-mv)
  };
  return s;
}
function applyDecline(s,side){
  if(currentSide(s)!==side||s.phase!==side)throw new Error("Сейчас нельзя отказаться от мячей");
  if(ballsLeft(s,side)<=0)throw new Error("Мячей уже не осталось");

  for(const item of s.ballInventory[side])item.used=true;
  setBallsLeft(s,side,0);

  const other=opponent(side);
  if(ballsLeft(s,other)>0){
    s.phase=other;
    ensureActivePlayer(s,other);
    ensureSelectedBall(s,other);
    return{state:s,transition:null};
  }

  return{
    state:s,
    transition:finishEnd(s)
  };
}
function makeRoomCode(){let out="";for(let i=0;i<5;i++)out+=ROOM_CHARS[Math.floor(Math.random()*ROOM_CHARS.length)];return out}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(request.method==="OPTIONS")return new Response(null,{status:204,headers:cors()});
    if(url.pathname==="/"||url.pathname==="/health")return new Response("Boccia SERVER GAME — OK",{headers:cors({"Content-Type":"text/plain; charset=utf-8"})});

    if(url.pathname==="/create-room"){
      if(!env.BOCCIA_ROOMS)return json({error:"BOCCIA_ROOMS binding missing"},500);
      const clientKey=String(url.searchParams.get("clientKey")||"").slice(0,160);if(!clientKey)return json({error:"clientKey required"},400);
      const pw=Number(url.searchParams.get("physicsW"));
      const ph=Number(url.searchParams.get("physicsH"));
      const pr=Number(url.searchParams.get("physicsR"));

      const config={
        matchFormat:"individual",
        fieldOrientation:url.searchParams.get("orientation")==="horizontal"?"horizontal":"vertical",
        realisticMode:url.searchParams.get("realism")==="1",
        physicsProfile:{
          w:Number.isFinite(pw)?pw:288,
          h:Number.isFinite(ph)?ph:600,
          r:Number.isFinite(pr)?pr:Math.max(7.8,Math.min(12.5,288*.032))
        }
      };
      for(let attempt=0;attempt<12;attempt++){
        const code=makeRoomCode(),id=env.BOCCIA_ROOMS.idFromName(code),stub=env.BOCCIA_ROOMS.get(id);
        const init=await stub.fetch(new Request("https://room.internal/init",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code,clientKey,config})}));
        if(init.status===201)return json({code,config},201);
        if(init.status!==409)return json({error:"Could not create room"},500);
      }
      return json({error:"Could not allocate room code"},503);
    }

    if(url.pathname.startsWith("/room-check/")){
      const code=url.pathname.split("/")[2]?.toUpperCase().replace(/[^A-Z0-9]/g,"");
      if(!code||code.length<4||code.length>8)return json({exists:false},404);
      const stub=env.BOCCIA_ROOMS.get(env.BOCCIA_ROOMS.idFromName(code)),r=await stub.fetch("https://room.internal/exists");
      return r.status===200?json({exists:true}):json({exists:false},404);
    }

    if(url.pathname.startsWith("/room/")){
      const code=url.pathname.split("/")[2]?.toUpperCase().replace(/[^A-Z0-9]/g,"");
      if(!code||code.length<4||code.length>8)return new Response("Invalid room code",{status:400});
      if((request.headers.get("Upgrade")||"").toLowerCase()!=="websocket")return new Response("WebSocket required",{status:426});
      return env.BOCCIA_ROOMS.get(env.BOCCIA_ROOMS.idFromName(code)).fetch(request);
    }
    return new Response("Not found",{status:404,headers:cors()});
  }
};

export class BocciaRoom extends DurableObject {
  constructor(ctx,env){
    super(ctx,env);this.sessions=new Map();
    for(const ws of this.ctx.getWebSockets()){const p=ws.deserializeAttachment();if(p)this.sessions.set(ws,p)}
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping","pong"));
  }
  async fetch(request){
    const url=new URL(request.url);
    if(url.pathname==="/init"&&request.method==="POST"){
      if(await this.ctx.storage.get("createdAt"))return new Response("exists",{status:409});
      const body=await request.json(),config={
        matchFormat:"individual",
        fieldOrientation:body?.config?.fieldOrientation==="horizontal"?"horizontal":"vertical",
        realisticMode:!!body?.config?.realisticMode,
        physicsProfile:{
          w:Number(body?.config?.physicsProfile?.w)||288,
          h:Number(body?.config?.physicsProfile?.h)||600,
          r:Number(body?.config?.physicsProfile?.r)||Math.max(7.8,Math.min(12.5,288*.032))
        }
      };
      await this.ctx.storage.put("createdAt",Date.now());await this.ctx.storage.put("roomCode",String(body.code||""));
      await this.ctx.storage.put("config",config);await this.ctx.storage.put("revision",0);
      await this.ctx.storage.put("seats",{red:{clientKey:String(body.clientKey||"").slice(0,160),ready:false},blue:null});
      await this.ctx.storage.put("processedActions",[]);await this.ctx.storage.setAlarm(Date.now()+EMPTY_ROOM_TTL_MS);
      return new Response("created",{status:201});
    }
    if(url.pathname==="/exists")return new Response(await this.ctx.storage.get("createdAt")?"yes":"no",{status:await this.ctx.storage.get("createdAt")?200:404});
    if(!await this.ctx.storage.get("createdAt"))return new Response("Room not found",{status:404});
    if((request.headers.get("Upgrade")||"").toLowerCase()!=="websocket")return new Response("WebSocket required",{status:426});
    await this.ctx.storage.deleteAlarm();
    const pair=new WebSocketPair(),[client,server]=Object.values(pair);this.ctx.acceptWebSocket(server);
    const player={id:crypto.randomUUID(),clientKey:null,side:null,ready:false};server.serializeAttachment(player);this.sessions.set(server,player);
    return new Response(null,{status:101,webSocket:client});
  }
  async getSeats(){return(await this.ctx.storage.get("seats"))||{red:null,blue:null}}
  async getState(){return(await this.ctx.storage.get("gameState"))||null}
  async getRevision(){return Number((await this.ctx.storage.get("revision"))||0)}
  async getConfig(){return(await this.ctx.storage.get("config"))||{
    matchFormat:"individual",
    fieldOrientation:"vertical",
    realisticMode:false,
    physicsProfile:{w:288,h:600,r:Math.max(7.8,Math.min(12.5,288*.032))}
  }}
  async playerList(){
    const seats=await this.getSeats(),result=[];
    for(const side of["red","blue"]){
      const seat=seats[side];if(!seat)continue;let connected=false,id=null;
      for(const p of this.sessions.values())if(p.clientKey&&p.clientKey===seat.clientKey){connected=true;id=p.id;break}
      result.push({id,side,ready:!!seat.ready,connected});
    }
    return result;
  }
  async roomStatePayload(extra={}){return{type:"room_state",players:await this.playerList(),config:await this.getConfig(),...extra}}
  async snapshotPayload(extra={}){return{type:"snapshot",revision:await this.getRevision(),state:await this.getState(),players:await this.playerList(),config:await this.getConfig(),...extra}}
  async broadcast(data){const msg=JSON.stringify(data);for(const ws of this.ctx.getWebSockets())try{ws.send(msg)}catch{}}
  async broadcastRoomState(extra={}){await this.broadcast(await this.roomStatePayload(extra))}
  async sendSnapshot(ws,extra={}){try{ws.send(JSON.stringify(await this.snapshotPayload(extra)))}catch{}}
  async processed(actionId){if(!actionId)return false;const ids=(await this.ctx.storage.get("processedActions"))||[];return ids.includes(String(actionId))}
  async rememberAction(actionId){
    if(!actionId)return;const ids=(await this.ctx.storage.get("processedActions"))||[],id=String(actionId);
    if(!ids.includes(id))ids.push(id);while(ids.length>80)ids.shift();await this.ctx.storage.put("processedActions",ids);
  }
  async maybeStartGame(triggerActionId=null){
    if(await this.getState())return;
    const seats=await this.getSeats();if(!seats.red?.ready||!seats.blue?.ready)return;
    const ps=await this.playerList();if(!ps.find(p=>p.side==="red")?.connected||!ps.find(p=>p.side==="blue")?.connected)return;
    const initial=createInitialState(await this.getConfig());initial.revision=1;
    await this.ctx.storage.put("revision",1);await this.ctx.storage.put("gameState",initial);
    await this.broadcast(await this.snapshotPayload({ackActionId:triggerActionId}));
  }
  async applyGameAction(ws,player,data){
    const actionId=String(data.actionId||"");if(!actionId)return;
    if(await this.processed(actionId)){await this.sendSnapshot(ws,{ackActionId:actionId});return}
    const state=await this.getState();
    if(!state){ws.send(JSON.stringify({type:"action_error",message:"Матч ещё не запущен",ackActionId:actionId,revision:await this.getRevision(),state:null}));return}
    let next=clone(state);
    let animation=null;
    let events=[];
    let transition=null;

    // Use exactly the creator's local 1 × 1 court geometry.
    setPhysicsProfile(next.physicsProfile);

    try{
      if(data.type==="throw"){
        const result=applyThrow(next,player.side,data);
        next=result.state;
        animation=result.animation||null;
        events=result.events||[];
        transition=result.transition||null;
      }
      else if(data.type==="select_player")next=applySelectPlayer(next,player.side,data);
      else if(data.type==="select_ball")next=applySelectBall(next,player.side,data);
      else if(data.type==="set_launcher")next=applyLauncher(next,player.side,data);
      else if(data.type==="decline"){
        const result=applyDecline(next,player.side);
        next=result.state;
        transition=result.transition||null;
      }
      else throw new Error("Неизвестное действие");
    }catch(err){
      await this.rememberAction(actionId);
      ws.send(JSON.stringify({type:"action_error",message:err?.message||"Действие отклонено",ackActionId:actionId,revision:await this.getRevision(),state}));
      return;
    }
    const revision=(await this.getRevision())+1;next.revision=revision;
    await this.ctx.storage.put("revision",revision);await this.ctx.storage.put("gameState",next);await this.rememberAction(actionId);
    await this.broadcast(await this.snapshotPayload({
      ackActionId:actionId,
      action:data.type,
      actor:player.side,
      animation,
      events,
      transition
    }));
  }
  async webSocketMessage(ws,message){
    let data;try{data=JSON.parse(message)}catch{return}
    let player=this.sessions.get(ws)||ws.deserializeAttachment()||{id:crypto.randomUUID(),clientKey:null,side:null,ready:false};

    if(data.type==="join"){
      const clientKey=String(data.clientKey||"").slice(0,160);if(!clientKey)return;
      const seats=await this.getSeats();let side=null;
      if(seats.red?.clientKey===clientKey)side="red";else if(seats.blue?.clientKey===clientKey)side="blue";
      else if(!seats.red){side="red";seats.red={clientKey,ready:false}}else if(!seats.blue){side="blue";seats.blue={clientKey,ready:false}}
      else{ws.send(JSON.stringify({type:"room_full"}));return}
      for(const[otherWs,other]of this.sessions.entries())if(otherWs!==ws&&other.clientKey&&other.clientKey===clientKey){this.sessions.delete(otherWs);try{otherWs.close(1012,"reconnected")}catch{}}
      player={id:crypto.randomUUID(),clientKey,side,ready:!!seats[side]?.ready};seats[side]={clientKey,ready:player.ready};
      await this.ctx.storage.put("seats",seats);ws.serializeAttachment(player);this.sessions.set(ws,player);await this.ctx.storage.deleteAlarm();
      ws.send(JSON.stringify({type:"joined",playerId:player.id,side:player.side,ready:player.ready,revision:await this.getRevision(),state:await this.getState(),players:await this.playerList(),config:await this.getConfig()}));
      await this.broadcastRoomState();return;
    }
    if(!player.side)return;
    if(data.type==="sync"){await this.sendSnapshot(ws);return}
    if(data.type==="ready"){
      const actionId=String(data.actionId||"");if(!actionId)return;
      if(await this.processed(actionId)){ws.send(JSON.stringify(await this.roomStatePayload({ackActionId:actionId})));await this.maybeStartGame(actionId);return}
      if(await this.getState()){await this.rememberAction(actionId);await this.sendSnapshot(ws,{ackActionId:actionId});return}
      const seats=await this.getSeats();if(!seats[player.side]||seats[player.side].clientKey!==player.clientKey)return;
      seats[player.side].ready=!!data.ready;player.ready=!!data.ready;ws.serializeAttachment(player);this.sessions.set(ws,player);
      await this.ctx.storage.put("seats",seats);await this.rememberAction(actionId);await this.broadcastRoomState({ackActionId:actionId});await this.maybeStartGame(actionId);return;
    }
    if(["throw","select_player","select_ball","set_launcher","decline"].includes(data.type)){await this.applyGameAction(ws,player,data);return}
    if(data.type==="restart"){
      const actionId=String(data.actionId||"");await this.ctx.storage.delete("gameState");await this.ctx.storage.put("revision",0);await this.ctx.storage.put("processedActions",[]);
      const seats=await this.getSeats();if(seats.red)seats.red.ready=false;if(seats.blue)seats.blue.ready=false;await this.ctx.storage.put("seats",seats);
      for(const[socket,p]of this.sessions.entries()){p.ready=false;socket.serializeAttachment(p);this.sessions.set(socket,p)}
      await this.broadcast({type:"restart",ackActionId:actionId||null});await this.broadcastRoomState();return;
    }
    if(data.type==="leave"){
      const seats=await this.getSeats();if(player.side&&seats[player.side]?.clientKey===player.clientKey){seats[player.side]=null;await this.ctx.storage.put("seats",seats)}
      this.sessions.delete(ws);await this.broadcastRoomState();try{ws.close(1000,"leave")}catch{}await this.scheduleCleanupIfEmpty();return;
    }
  }
  async scheduleCleanupIfEmpty(){if(this.ctx.getWebSockets().length===0)await this.ctx.storage.setAlarm(Date.now()+EMPTY_ROOM_TTL_MS)}
  async webSocketClose(ws){this.sessions.delete(ws);await this.broadcastRoomState();await this.scheduleCleanupIfEmpty()}
  async webSocketError(ws){this.sessions.delete(ws);await this.broadcastRoomState();await this.scheduleCleanupIfEmpty()}
  async alarm(){if(this.ctx.getWebSockets().length===0){await this.ctx.storage.deleteAll();this.sessions.clear();return}await this.ctx.storage.deleteAlarm()}
}
import { DurableObject } from "cloudflare:workers";

const EMPTY_ROOM_TTL_MS = 30 * 60 * 1000;
const ROOM_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const C = { x: 0, y: 0, w: 288, h: 600 };
const BW = C.w / 6;
const BALL_R = C.w * 0.032;
const MIN_SPEED = 0.045;

const BALL_TYPES = [
  { id: "superHard", decel: .060, restitution: .58, damping: .95, mass: 1.14 },
  { id: "hard", decel: .071, restitution: .51, damping: .93, mass: 1.09 },
  { id: "medium", decel: .085, restitution: .43, damping: .89, mass: 1.03 },
  { id: "mediumSoft", decel: .098, restitution: .35, damping: .85, mass: .99 },
  { id: "soft", decel: .113, restitution: .27, damping: .80, mass: .95 },
  { id: "superSoft", decel: .130, restitution: .19, damping: .75, mass: .91 },
];
const BALL_TYPE_MAP = Object.fromEntries(BALL_TYPES.map((x) => [x.id, x]));
const STANDARD_KIT = BALL_TYPES.map((x) => x.id);

const FORMAT_CONFIGS = {
  individual: { id:"individual", redBoxes:[3], blueBoxes:[4], perPlayer:6, totalEnds:4, jackOrder:[3,4,3,4] },
  pairs: { id:"pairs", redBoxes:[2,4], blueBoxes:[3,5], perPlayer:3, totalEnds:4, jackOrder:[2,3,4,5] },
  teams: { id:"teams", redBoxes:[1,3,5], blueBoxes:[2,4,6], perPlayer:2, totalEnds:6, jackOrder:[1,2,3,4,5,6] },
};

function cors(headers={}) {
  return {
    "Access-Control-Allow-Origin":"*",
    "Access-Control-Allow-Methods":"GET,OPTIONS",
    "Access-Control-Allow-Headers":"Content-Type",
    ...headers
  };
}
function json(data,status=200){
  return new Response(JSON.stringify(data),{
    status,
    headers:cors({"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"})
  });
}
function clone(v){return v==null?v:JSON.parse(JSON.stringify(v))}
function clamp(v,a,b){return Math.max(a,Math.min(b,Number(v)))}
function opponent(side){return side==="red"?"blue":"red"}
function cfg(s){return FORMAT_CONFIGS[s.matchFormat]||FORMAT_CONFIGS.individual}
function sideBoxes(s,side){return side==="red"?cfg(s).redBoxes:cfg(s).blueBoxes}
function sideForBox(s,box){return cfg(s).redBoxes.includes(Number(box))?"red":"blue"}
function totalSideBalls(s){return cfg(s).perPlayer*cfg(s).redBoxes.length}
function jackBoxForEnd(s,n){const a=cfg(s).jackOrder;return a[(Math.max(1,n)-1)%a.length]}
function nextJackBoxAfter(s,box){const a=cfg(s).jackOrder,i=a.indexOf(Number(box));return a[(i>=0?i+1:0)%a.length]}
function currentSide(s){
  if(s.phase==="red"||s.phase==="jackRed")return"red";
  if(s.phase==="blue"||s.phase==="jackBlue")return"blue";
  return null;
}
function sidePhase(side,kind="colour"){return kind==="jack"?(side==="red"?"jackRed":"jackBlue"):side}
function ballsLeft(s,side){return side==="red"?s.redLeft:s.blueLeft}
function setBallsLeft(s,side,n){if(side==="red")s.redLeft=n;else s.blueLeft=n}
function mx(m){return C.w*(m/6)}
function my(m){return C.h*(m/12.5)}
function throwingY(){return my(10)}
function crossPoint(){return{x:mx(3),y:my(5)}}
function vYAtX(x){
  const leftY=my(7),vertexY=my(8.5),mid=C.w/2;
  if(x<=mid){const t=clamp(x/(C.w/2),0,1);return leftY+(vertexY-leftY)*t}
  const t=clamp((x-mid)/(C.w/2),0,1);return vertexY+(leftY-vertexY)*t;
}
function ballType(id){return BALL_TYPE_MAP[id]||BALL_TYPE_MAP.medium}
function physicsFor(b){return ballType(b.hardnessId||(b.kind==="jack"?"soft":"medium"))}
function dist(a,b){return Math.hypot(a.x-b.x,a.y-b.y,(a.z||0)-(b.z||0))}
function realismSoftnessFactor(id=null){
  const map={superHard:.45,hard:.58,medium:.72,mediumSoft:.87,soft:1.02,superSoft:1.18};
  return map[id||"soft"]??1.02;
}
function createRealismProfile(realistic,kind,id=null){
  if(!realistic)return null;
  const softness=realismSoftnessFactor(id||(kind==="jack"?"soft":"medium"));
  return{
    seed:Math.random()*Math.PI*2,phase:Math.random()*Math.PI*2,
    phaseSpeed:.08+softness*.05+Math.random()*.025,
    floorBias:(Math.random()-.5)*.0075*softness,
    wobble:.0034*softness+Math.random()*.0026*softness,
    forward:.0018*softness+Math.random()*.0014*softness,
    decelBias:1+(Math.random()-.5)*.18*softness,
    decelWave:.070*softness+Math.random()*.042*softness,
    releaseAngle:(Math.random()-.5)*(.016+.031*softness),
    releaseSpeed:1+((Math.random()-.5)*(.020+.038*softness)),
    slowThreshold:.62+Math.random()*.18,
    slipChance:.010*softness+Math.random()*.010*softness,
    slipStrength:.0038*softness+Math.random()*.0042*softness,
    holdFrames:0,holdDir:Math.random()<.5?-1:1
  };
}
function applyRealismToLaunch(realistic,vx,vy,kind,id){
  if(!realistic)return{vx,vy};
  const p=createRealismProfile(true,kind,id);
  const a=p.releaseAngle,c=Math.cos(a),sn=Math.sin(a),sp=p.releaseSpeed;
  return{vx:(vx*c-vy*sn)*sp,vy:(vx*sn+vy*c)*sp};
}
function defaultLauncherPositions(){
  return{1:{u:.5,v:.54},2:{u:.5,v:.54},3:{u:.5,v:.54},4:{u:.5,v:.54},5:{u:.5,v:.54},6:{u:.5,v:.54}};
}
function launcherPointForBox(s,box){
  const p=s.launcherPositions[box]||{u:.5,v:.54},top=throwingY(),bottom=my(12.5);
  return{x:BW*(box-1)+BW*p.u,y:top+(bottom-top)*p.v};
}
function defaultAllocationForSide(s,side){
  const boxes=sideBoxes(s,side),per=cfg(s).perPlayer,out={};
  boxes.forEach(b=>out[b]=[]);
  let n=0;
  for(const id of STANDARD_KIT){
    const b=boxes[Math.floor(n/per)%boxes.length];
    if(out[b].length<per)out[b].push(id);
    n++;
  }
  return out;
}
function resetBallInventory(s){
  s.ballAllocation={red:defaultAllocationForSide(s,"red"),blue:defaultAllocationForSide(s,"blue")};
  s.ballInventory={red:[],blue:[]};
  for(const side of["red","blue"]){
    for(const box of sideBoxes(s,side)){
      for(const id of(s.ballAllocation[side][box]||[]))s.ballInventory[side].push({id,used:false,ownerBox:Number(box)});
    }
  }
  s.selectedBall={red:"medium",blue:"medium"};
  s.activePlayerBox={red:sideBoxes(s,"red")[0],blue:sideBoxes(s,"blue")[0]};
  ensureActivePlayer(s,"red");ensureActivePlayer(s,"blue");
}
function unusedItemsForBox(s,side,box){return s.ballInventory[side].filter(x=>!x.used&&x.ownerBox===Number(box))}
function remainingForBox(s,side,box){return unusedItemsForBox(s,side,box).length}
function availableBoxes(s,side){return sideBoxes(s,side).filter(b=>remainingForBox(s,side,b)>0)}
function ensureActivePlayer(s,side){
  const locked=s.firstColourLockedBox[side];
  if(locked&&remainingForBox(s,side,locked)>0){s.activePlayerBox[side]=locked;return locked}
  if(remainingForBox(s,side,s.activePlayerBox[side])>0)return s.activePlayerBox[side];
  s.activePlayerBox[side]=availableBoxes(s,side)[0]??sideBoxes(s,side)[0];
  return s.activePlayerBox[side];
}
function availableBallIds(s,side){const box=ensureActivePlayer(s,side);return unusedItemsForBox(s,side,box).map(x=>x.id)}
function isBallAvailable(s,side,id){const box=ensureActivePlayer(s,side);return unusedItemsForBox(s,side,box).some(x=>x.id===id)}
function ensureSelectedBall(s,side){
  ensureActivePlayer(s,side);
  if(isBallAvailable(s,side,s.selectedBall[side]))return s.selectedBall[side];
  const pref=["medium","mediumSoft","soft","hard","superSoft","superHard"];
  s.selectedBall[side]=pref.find(id=>isBallAvailable(s,side,id))||availableBallIds(s,side)[0]||"medium";
  return s.selectedBall[side];
}
function consumeBall(s,side,id){
  const box=ensureActivePlayer(s,side);
  const item=s.ballInventory[side].find(x=>x.id===id&&!x.used&&x.ownerBox===box);
  if(!item)return false;item.used=true;return true;
}
function createInitialState(config){
  const format=FORMAT_CONFIGS[config.matchFormat]?config.matchFormat:"individual";
  const s={
    version:20,revision:0,matchFormat:format,
    fieldOrientation:config.fieldOrientation==="horizontal"?"horizontal":"vertical",
    realisticMode:!!config.realisticMode,totalEnds:FORMAT_CONFIGS[format].totalEnds,endNo:1,
    redScore:0,blueScore:0,redLeft:0,blueLeft:0,phase:"jackRed",currentJackBox:3,
    activePlayerBox:{red:3,blue:4},firstColourLockedBox:{red:null,blue:null},
    lastColourSide:null,jackNeedsCross:false,tieBreak:false,tieFirst:null,
    equidistantSequence:false,equidistantNextSide:null,selectedBall:{red:"medium",blue:"medium"},
    jackHardness:{red:"soft",blue:"soft"},currentJackHardness:"soft",
    kitConfig:{red:[...STANDARD_KIT],blue:[...STANDARD_KIT]},
    ballAllocation:{red:{},blue:{}},ballInventory:{red:[],blue:[]},
    launcherPositions:defaultLauncherPositions(),jack:null,balls:[],matchStarted:true,modal:null
  };
  s.redLeft=totalSideBalls(s);s.blueLeft=totalSideBalls(s);resetBallInventory(s);
  s.currentJackBox=jackBoxForEnd(s,1);
  const js=sideForBox(s,s.currentJackBox);s.activePlayerBox[js]=s.currentJackBox;s.phase=sidePhase(js,"jack");
  return s;
}
function toSim(o){
  if(!o)return null;
  return{
    kind:o.kind,side:o.side,x:(Number(o.u)||0)*C.w,y:(Number(o.v)||0)*C.h,z:(Number(o.z)||0)*C.w,
    vx:0,vy:0,vz:0,r:BALL_R,hitCd:0,entered:!!o.entered,
    hardnessId:o.hardnessId||(o.kind==="jack"?"soft":"medium"),
    realism:o.realism?clone(o.realism):null,_shot:false
  };
}
function fromSim(o){
  if(!o)return null;
  return{
    kind:o.kind,side:o.side,u:o.x/C.w,v:o.y/C.h,z:(o.z||0)/C.w,
    hardnessId:o.hardnessId||(o.kind==="jack"?"soft":"medium"),entered:!!o.entered,
    realism:o.realism?clone(o.realism):null
  };
}
function captureAnimationFrame(jack,balls){
  return{
    jack:jack?fromSim(jack):null,
    balls:(balls||[]).map(fromSim)
  };
}
function downsampleAnimationFrames(frames,maxFrames=72){
  if(frames.length<=maxFrames)return frames;
  const out=[];
  for(let i=0;i<maxFrames;i++){
    const idx=Math.round(i*(frames.length-1)/(maxFrames-1));
    const frame=frames[idx];
    if(!out.length||frame!==out[out.length-1])out.push(frame);
  }
  return out;
}

function speedFromPower(power){
  const min=4.3,max=Math.sqrt(2*BALL_TYPE_MAP.medium.decel*C.h*.96)*1.12;
  return min+(max-min)*clamp(power,.08,1);
}
function isInsideBoundary(b){return b.x-b.r>C.x&&b.x+b.r<C.w&&b.y-b.r>C.y&&b.y+b.r<C.h}
function isJackValidSim(b){return !!b&&isInsideBoundary(b)&&b.y+b.r<vYAtX(b.x)}
function applyGravityAndFloor(b){
  if((b.z||0)>0||(b.vz||0)!==0){
    b.vz=(b.vz||0)-.070;b.z=(b.z||0)+b.vz;
    if(b.z<0){b.z=0;if(Math.abs(b.vz)<.15)b.vz=0;else b.vz*=-.14}
  }
}
function softCompressionFactor(b){
  const id=b.hardnessId||(b.kind==="jack"?"soft":"medium");
  return({superHard:.992,hard:.982,medium:.968,mediumSoft:.950,soft:.932,superSoft:.914})[id]??.968;
}
function supportLiftFor(top,support){
  const sumR=top.r+support.r,compression=(softCompressionFactor(top)+softCompressionFactor(support))/2,effective=sumR*compression;
  const dx=top.x-support.x,dy=top.y-support.y,h=Math.hypot(dx,dy);
  if(h>=effective)return null;return(support.z||0)+Math.sqrt(Math.max(0,effective*effective-h*h));
}
function climbFactor(b){const p=physicsFor(b);return Math.max(.72,Math.min(1.28,1.18-(p.restitution-.19)*.75))}
function resolveMultiSupportStacking(objs){
  for(const top of objs){
    const speed=Math.hypot(top.vx||0,top.vy||0),candidates=[];
    for(const s of objs){
      if(s===top)continue;if((s.z||0)>(top.z||0)+top.r*.55)continue;
      const dx=s.x-top.x,dy=s.y-top.y,h=Math.hypot(dx,dy),range=(top.r+s.r)*1.03;
      if(h<range){const lift=supportLiftFor(top,s);if(lift!==null)candidates.push({s,dx,dy,h,lift})}
    }
    if(candidates.length<2)continue;
    let bestPair=null,bestQuality=-Infinity;
    for(let i=0;i<candidates.length;i++)for(let j=i+1;j<candidates.length;j++){
      const a=candidates[i],b=candidates[j],la=Math.max(.001,a.h),lb=Math.max(.001,b.h);
      const dot=(a.dx*b.dx+a.dy*b.dy)/(la*lb),spread=(1-dot)/2;if(spread<.34)continue;
      const gap=Math.hypot(a.s.x-b.s.x,a.s.y-b.s.y),maxGap=(a.s.r+b.s.r)*1.32;if(gap>maxGap)continue;
      const target=Math.max(a.lift,b.lift),quality=spread*2.2-Math.abs(a.lift-b.lift)/(top.r*2)-gap/(maxGap*8);
      if(quality>bestQuality){bestQuality=quality;bestPair={target}}
    }
    if(!bestPair)continue;
    const cf=climbFactor(top),relativeLift=Math.max(0,bestPair.target-(top.z||0));
    if(speed>.55){
      const threshold=.62/cf;
      if(speed>threshold){
        const energy=Math.min(1.8,speed/5.2),desired=Math.min(bestPair.target,(top.z||0)+relativeLift*(.48+.38*Math.min(1,energy)));
        top.z=Math.max(top.z||0,desired);
        if(speed>4){top.vz=Math.max(top.vz||0,Math.min(1.70,(speed-2)*.17*cf));const keep=.88+Math.min(.08,speed*.008);top.vx*=keep;top.vy*=keep}
        else{top.vz=Math.max(top.vz||0,.12*cf);top.vx*=.78;top.vy*=.78}
      }
    }
    if((top.z||0)>top.r*.28&&speed<1.25){
      const target=bestPair.target*.965;
      if(top.z<target)top.z+=(target-top.z)*.42;else if(top.z>target+top.r*.18)top.z+=(target-top.z)*.12;
      if(Math.abs(top.vz||0)<.24)top.vz=0;top.vx*=.90;top.vy*=.90;
    }
  }
}
function resolve3DBallContact(a,b){
  const pa=physicsFor(a),pb=physicsFor(b),dx=b.x-a.x,dy=b.y-a.y,dz=(b.z||0)-(a.z||0),horiz=Math.hypot(dx,dy);
  const d3=Math.sqrt(dx*dx+dy*dy+dz*dz),min=a.r+b.r;if(d3<=0||d3>=min)return false;
  const nx=dx/(horiz||1),ny=dy/(horiz||1),ma=pa.mass,mb=pb.mass,total=ma+mb,overlap=min-d3;
  const verticalShare=Math.min(.92,Math.abs(dz)/(min*.74)),elevated=Math.min(1,Math.max(a.z||0,b.z||0)/(min*.72));
  const push=overlap*(1-verticalShare*.78)*(1-elevated*.58);
  a.x-=nx*push*(mb/total);a.y-=ny*push*(mb/total);b.x+=nx*push*(ma/total);b.y+=ny*push*(ma/total);
  const rvx=b.vx-a.vx,rvy=b.vy-a.vy,along=rvx*nx+rvy*ny;
  if(along<0){
    const rel=Math.abs(along),e=(pa.restitution+pb.restitution)/2,compact=horiz<min*.94,threshold=.55+e*.45;
    if(compact&&rel>threshold){
      const mover=Math.hypot(a.vx,a.vy)>=Math.hypot(b.vx,b.vy)?a:b,support=mover===a?b:a,cf=climbFactor(mover);
      const lift=supportLiftFor(mover,support),maxZ=(mover.r+support.r)*.92;
      if(lift!==null){const gain=Math.min(1,rel/4.5);mover.z=Math.max(mover.z||0,Math.min(maxZ,(mover.z||0)+(lift-(mover.z||0))*(.30+.42*gain)))}
      if(rel>3.2)mover.vz=Math.max(mover.vz||0,Math.min(1.55,(rel-1.7)*.16*cf));else mover.vz=Math.max(mover.vz||0,Math.min(.58,rel*.10*cf));
    }
    const imp=-(1+e)*along/(1/ma+1/mb);
    a.vx-=imp*nx/ma;a.vy-=imp*ny/ma;b.vx+=imp*nx/mb;b.vy+=imp*ny/mb;
    const damp=Math.sqrt(pa.damping*pb.damping);a.vx*=damp;a.vy*=damp;b.vx*=damp;b.vy*=damp;
  }
  const top=(a.z||0)>=(b.z||0)?a:b,bottom=top===a?b:a,h=Math.hypot(top.x-bottom.x,top.y-bottom.y);
  if(h<min*.78&&(top.z||0)>0){const allowed=Math.sqrt(Math.max(0,min*min-h*h)),target=(bottom.z||0)+allowed*.72;if(top.z<target){top.z=Math.min(target,top.z+overlap*.32);top.vz=Math.max(0,top.vz||0)}}
  return true;
}
function simulateThrow(s,shot){
  let jack=toSim(s.jack),balls=(s.balls||[]).map(toSim);
  const animationFrames=[];
  const events=[];
  let jackKnockedOut=false;
  const pos=launcherPointForBox(s,shot.box),a=shot.angle*Math.PI/180,speed=speedFromPower(shot.power);
  const launch=applyRealismToLaunch(s.realisticMode,Math.sin(a)*speed,-Math.cos(a)*speed,shot.kind==="jack"?"jack":shot.side,shot.hardnessId);
  const moving={
    kind:shot.kind==="jack"?"jack":shot.side,side:shot.side,x:pos.x,y:pos.y,z:0,vx:launch.vx,vy:launch.vy,vz:0,
    r:BALL_R,hitCd:0,entered:false,hardnessId:shot.hardnessId,
    realism:createRealismProfile(s.realisticMode,shot.kind==="jack"?"jack":shot.side,shot.hardnessId),_shot:true
  };
  if(moving.realism)moving.realism.startSpeed=Math.hypot(moving.vx,moving.vy);
  if(shot.kind==="jack")jack=moving;else balls.push(moving);
  let jackFouled=false,settle=0;

  animationFrames.push(captureAnimationFrame(jack,balls));

  for(let step=0;step<1500;step++){
    const objs=jack?[jack,...balls]:[...balls];
    for(const b of objs){
      b.x+=b.vx;b.y+=b.vy;applyGravityAndFloor(b);if(b.y-b.r<throwingY())b.entered=true;
      const sp=Math.hypot(b.vx,b.vy);
      if(sp>0){
        const pp=physicsFor(b);
        if(s.realisticMode&&b.realism&&(b.z||0)===0){
          if(!b.realism.startSpeed||sp>b.realism.startSpeed)b.realism.startSpeed=sp;
          const ux=b.vx/sp,uy=b.vy/sp,px=-uy,py=ux,start=Math.max(.001,b.realism.startSpeed||sp);
          const ratio=clamp(sp/start,0,1),inst=Math.pow(1-ratio,1.65);
          const low=sp<=b.realism.slowThreshold?1+((b.realism.slowThreshold-sp)/Math.max(.08,b.realism.slowThreshold))*1.35:1;
          const drift=.05+inst*1.45*low;b.realism.phase+=b.realism.phaseSpeed*(.8+inst*.9);
          const side=(b.realism.floorBias+Math.sin(b.realism.phase+b.realism.seed)*b.realism.wobble)*drift;
          b.vx+=px*side;b.vy+=py*side;
          if(b.realism.holdFrames>0){const burst=b.realism.slipStrength*inst*low*b.realism.holdDir;b.vx+=px*burst;b.vy+=py*burst;b.realism.holdFrames--}
          else if(Math.random()<b.realism.slipChance*inst*low){b.realism.holdDir=Math.random()<.5?-1:1;b.realism.holdFrames=1+Math.floor(Math.random()*3)}
          const fwd=1+Math.sin(b.realism.phase*.67+b.realism.seed)*b.realism.forward*inst*low;b.vx*=fwd;b.vy*=fwd;
        }
        const base=pp.decel*(b.realism?.decelBias??1),wave=s.realisticMode&&b.realism?(1+Math.sin((b.realism.phase||0)*.53+b.realism.seed)*(b.realism.decelWave||0)):1;
        const decel=Math.max(pp.decel*.55,base*wave),ns=Math.max(0,sp-decel),k=ns/sp;b.vx*=k;b.vy*=k;
      }
      if(Math.hypot(b.vx,b.vy)<MIN_SPEED){b.vx=0;b.vy=0}if(b.hitCd>0)b.hitCd--;
    }
    const objs2=jack?[jack,...balls]:[...balls];resolveMultiSupportStacking(objs2);
    for(let i=0;i<objs2.length;i++)for(let j=i+1;j<objs2.length;j++)resolve3DBallContact(objs2[i],objs2[j]);
    resolveMultiSupportStacking(objs2);

    for(const b of [...(jack?[jack]:[]),...balls]){
      const out=b.x-b.r<=0||b.x+b.r>=C.w||b.y-b.r<=0||b.y+b.r>=C.h;if(!out)continue;
      b.vx=b.vy=0;
      if(b.kind==="jack"){
        if(b._shot&&shot.kind==="jack"){
          jackFouled=true;
          events.push({type:"jack_out",text:"Джек — аут"});
          jack=null;
        }else{
          jack=null;
          jackKnockedOut=true;
          s.jackNeedsCross=true;
          events.push({type:"jack_out",text:"Джек выбит за пределы площадки"});
        }
      }else{
        events.push({
          type:"ball_out",
          side:b.side,
          text:`${b.side==="red"?"Красный":"Синий"} мяч — аут`
        });
        const idx=balls.indexOf(b);if(idx>=0)balls.splice(idx,1);
      }
    }

    if(step%4===0)animationFrames.push(captureAnimationFrame(jack,balls));

    const all=jack?[jack,...balls]:[...balls];
    const any=all.some(b=>Math.hypot(b.vx,b.vy)>.06||Math.abs(b.vz||0)>.05);
    if(!any)settle++;else settle=0;if(settle>13)break;
  }

  const shotBall=shot.kind==="jack"?(jack&&jack._shot?jack:null):(balls.find(b=>b._shot)||null);
  if(shotBall&&!shotBall.entered){
    if(shot.kind==="jack"){
      jackFouled=true;
      events.push({type:"jack_not_entered",text:"Джек не вошёл в игровую зону"});
      jack=null;
    }else{
      events.push({
        type:"ball_not_entered",
        side:shot.side,
        text:`${shot.side==="red"?"Красный":"Синий"} мяч не вошёл в игровую зону`
      });
      const idx=balls.indexOf(shotBall);if(idx>=0)balls.splice(idx,1);
    }
  }

  for(const b of balls)delete b._shot;if(jack)delete jack._shot;
  s.jack=fromSim(jack);s.balls=balls.map(fromSim);

  animationFrames.push(captureAnimationFrame(jack,balls));

  return{
    jackFouled,
    jackKnockedOut,
    events,
    animation:{
      frameMs:27,
      frames:downsampleAnimationFrames(animationFrames,72)
    }
  };
}
function jackCrossPlacementPoint(s){
  const p=crossPoint(),balls=(s.balls||[]).map(toSim),blockers=balls.filter(b=>Math.hypot(b.x-p.x,b.y-p.y)<BALL_R+b.r);
  if(!blockers.length)return p;
  const maxY=throwingY()-BALL_R-1;
  for(let y=p.y;y<=maxY;y+=.5){if(balls.every(b=>Math.hypot(p.x-b.x,y-b.y)>=BALL_R+b.r-.05))return{x:p.x,y}}
  return{x:p.x,y:Math.min(maxY,p.y+BALL_R*2)};
}
function placeJackOnCross(s){
  const p=jackCrossPlacementPoint(s);
  s.jack={kind:"jack",side:"neutral",u:p.x/C.w,v:p.y/C.h,z:0,hardnessId:s.currentJackHardness||"soft",entered:true,realism:createRealismProfile(s.realisticMode,"jack",s.currentJackHardness||"soft")};
  s.jackNeedsCross=false;
}
function scoreCurrentEnd(s){
  const eps=.55,j=toSim(s.jack);if(!j)return{red:0,blue:0};
  const reds=s.balls.filter(b=>b.kind==="red").map(b=>dist(toSim(b),j)).sort((a,b)=>a-b);
  const blues=s.balls.filter(b=>b.kind==="blue").map(b=>dist(toSim(b),j)).sort((a,b)=>a-b);
  const r0=reds[0]??Infinity,b0=blues[0]??Infinity;if(!isFinite(r0)&&!isFinite(b0))return{red:0,blue:0};
  if(Math.abs(r0-b0)<=eps)return{red:reds.filter(d=>Math.abs(d-r0)<=eps).length,blue:blues.filter(d=>Math.abs(d-b0)<=eps).length};
  if(r0<b0)return{red:reds.filter(d=>d<b0-eps).length,blue:0};
  return{red:0,blue:blues.filter(d=>d<r0-eps).length};
}
function sideToPlay(s){
  if(s.redLeft<=0&&s.blueLeft<=0){s.equidistantSequence=false;s.equidistantNextSide=null;return null}
  const j=toSim(s.jack),reds=s.balls.filter(b=>b.kind==="red").map(toSim),blues=s.balls.filter(b=>b.kind==="blue").map(toSim);
  if(!reds.length&&s.redLeft>0){s.equidistantSequence=false;s.equidistantNextSide=null;return"red"}
  if(!blues.length&&s.blueLeft>0){s.equidistantSequence=false;s.equidistantNextSide=null;return"blue"}
  if(s.redLeft<=0){s.equidistantSequence=false;s.equidistantNextSide=null;return"blue"}
  if(s.blueLeft<=0){s.equidistantSequence=false;s.equidistantNextSide=null;return"red"}
  const eps=.55,rd=Math.min(...reds.map(b=>dist(b,j))),bd=Math.min(...blues.map(b=>dist(b,j)));
  if(Math.abs(rd-bd)<=eps){
    const rc=reds.filter(b=>Math.abs(dist(b,j)-rd)<=eps).length,bc=blues.filter(b=>Math.abs(dist(b,j)-bd)<=eps).length;
    if(rc===bc){
      if(!s.equidistantSequence){s.equidistantSequence=true;s.equidistantNextSide=s.lastColourSide||"red"}
      else s.equidistantNextSide=opponent(s.equidistantNextSide||s.lastColourSide||"red");
      return s.equidistantNextSide;
    }
    s.equidistantSequence=false;s.equidistantNextSide=null;return rc<bc?"red":"blue";
  }
  s.equidistantSequence=false;s.equidistantNextSide=null;return rd<bd?"blue":"red";
}
function startRegulationEnd(s){
  s.balls=[];s.jack=null;s.redLeft=totalSideBalls(s);s.blueLeft=totalSideBalls(s);s.lastColourSide=null;s.jackNeedsCross=false;
  s.tieBreak=false;s.tieFirst=null;s.equidistantSequence=false;s.equidistantNextSide=null;s.firstColourLockedBox={red:null,blue:null};s.modal=null;
  resetBallInventory(s);s.currentJackBox=jackBoxForEnd(s,s.endNo);const js=sideForBox(s,s.currentJackBox);s.activePlayerBox[js]=s.currentJackBox;s.phase=sidePhase(js,"jack");
}
function startTieBreak(s,first){
  s.balls=[];s.redLeft=totalSideBalls(s);s.blueLeft=totalSideBalls(s);s.lastColourSide=null;s.jackNeedsCross=false;s.tieBreak=true;s.tieFirst=first;
  s.equidistantSequence=false;s.equidistantNextSide=null;s.firstColourLockedBox={red:null,blue:null};s.modal=null;resetBallInventory(s);
  s.currentJackHardness=s.jackHardness[first]||"soft";const p=crossPoint();
  s.jack={kind:"jack",side:"neutral",u:p.x/C.w,v:p.y/C.h,z:0,hardnessId:s.currentJackHardness,entered:true,realism:createRealismProfile(s.realisticMode,"jack",s.currentJackHardness)};
  s.phase=first;
}
function finishMatch(s,winner,tb){
  s.phase="finished";s.modal={title:`${winner==="red"?"Красные":"Синие"} победили! 🏆`,text:tb?`Основной матч ${s.redScore}:${s.blueScore}. Победитель определён в тай-брейке.`:`Финальный счёт ${s.redScore}:${s.blueScore}.`};
}
function finishEnd(s,events=[]){
  const endedEnd=s.endNo;
  const pts=scoreCurrentEnd(s);

  if(s.tieBreak){
    if(pts.red===pts.blue){
      startTieBreak(s,s.tieFirst==="red"?"blue":"red");
      events.push({
        type:"tiebreak",
        text:"Тай-брейк завершился вничью · ещё один дополнительный энд"
      });
    }else{
      finishMatch(s,pts.red>pts.blue?"red":"blue",true);
    }
    return;
  }

  s.redScore+=pts.red;
  s.blueScore+=pts.blue;

  let matchFinished=false;
  let nextEnd=endedEnd;

  if(s.endNo>=s.totalEnds){
    if(s.redScore===s.blueScore){
      startTieBreak(s,Math.random()<.5?"red":"blue");
      events.push({
        type:"tiebreak",
        text:`Основной матч ${s.redScore}:${s.blueScore} · начинается тай-брейк`
      });
    }else{
      finishMatch(s,s.redScore>s.blueScore?"red":"blue",false);
      matchFinished=true;
    }
  }else{
    s.endNo++;
    nextEnd=s.endNo;
    startRegulationEnd(s);
  }

  events.push({
    type:"end",
    endedEnd,
    redPoints:pts.red,
    bluePoints:pts.blue,
    redScore:s.redScore,
    blueScore:s.blueScore,
    nextEnd,
    matchFinished
  });
}
function resolveJackThrow(s,side,fouled,events=[]){
  const j=toSim(s.jack);
  if(fouled||!j||!isJackValidSim(j)){
    s.jack=null;
    s.currentJackBox=nextJackBoxAfter(s,s.currentJackBox);
    const next=sideForBox(s,s.currentJackBox);
    s.activePlayerBox[next]=s.currentJackBox;
    s.phase=sidePhase(next,"jack");

    if(!events.some(ev=>ev.type==="jack_out"||ev.type==="jack_not_entered")){
      events.push({
        type:"invalid_jack",
        nextBox:s.currentJackBox,
        text:`Недействительный джек · следующий бокс ${s.currentJackBox}`
      });
    }
    return;
  }
  s.firstColourLockedBox[side]=s.currentJackBox;
  s.activePlayerBox[side]=s.currentJackBox;
  s.phase=side;
  ensureSelectedBall(s,side);
}
function resolveColourThrow(s,events=[]){
  const j=toSim(s.jack);
  if(s.jackNeedsCross||!j||!isJackValidSim(j)){
    placeJackOnCross(s);
    if(!events.some(ev=>ev.type==="jack_cross")){
      events.push({type:"jack_cross",text:"Джек установлен на крест"});
    }
  }

  if(s.redLeft<=0&&s.blueLeft<=0){
    finishEnd(s,events);
    return;
  }

  const next=sideToPlay(s);
  if(!next){
    finishEnd(s,events);
    return;
  }

  s.phase=next;
  ensureActivePlayer(s,next);
  ensureSelectedBall(s,next);
}
function applyThrow(s,side,data){
  if(currentSide(s)!==side)throw new Error("Сейчас ход другого игрока");
  if(s.phase==="finished")throw new Error("Матч уже завершён");
  const kind=s.phase==="jackRed"||s.phase==="jackBlue"?"jack":"colour";
  const angle=clamp(data.angle,-58,58),power=clamp(data.power,.08,1),box=kind==="jack"?s.currentJackBox:ensureActivePlayer(s,side);
  let hardness;
  if(kind==="jack"){hardness=s.jackHardness[side]||"soft";s.currentJackHardness=hardness}
  else{
    hardness=ensureSelectedBall(s,side);if(!isBallAvailable(s,side,hardness))throw new Error("Выбранный мяч уже использован");
    if(!consumeBall(s,side,hardness))throw new Error("Не удалось списать мяч");
    setBallsLeft(s,side,ballsLeft(s,side)-1);s.lastColourSide=side;if(s.firstColourLockedBox[side])s.firstColourLockedBox[side]=null;
  }
  const result=simulateThrow(s,{side,kind,box,hardnessId:hardness,angle,power});
  const events=result.events||[];

  if(kind==="jack"){
    resolveJackThrow(s,side,result.jackFouled,events);
  }else{
    resolveColourThrow(s,events);
  }

  return{
    state:s,
    animation:result.animation,
    events
  };
}
function applySelectPlayer(s,side,data){
  if(currentSide(s)!==side||s.phase!==side)throw new Error("Сейчас нельзя менять спортсмена");
  const box=Number(data.box);if(!sideBoxes(s,side).includes(box))throw new Error("Этот бокс не принадлежит вашей стороне");
  if(s.firstColourLockedBox[side]&&s.firstColourLockedBox[side]!==box)throw new Error("Первый мяч после джека бросает тот же бокс");
  if(remainingForBox(s,side,box)<=0)throw new Error("У этого бокса не осталось мячей");
  s.activePlayerBox[side]=box;ensureSelectedBall(s,side);return s;
}
function applySelectBall(s,side,data){
  if(currentSide(s)!==side||s.phase!==side)throw new Error("Сейчас нельзя выбирать мяч");
  const id=String(data.hardnessId||"");if(!BALL_TYPE_MAP[id])throw new Error("Неизвестный тип мяча");
  if(!isBallAvailable(s,side,id))throw new Error("Такого мяча не осталось у активного бокса");
  s.selectedBall[side]=id;return s;
}
function applyLauncher(s,side,data){
  if(currentSide(s)!==side)throw new Error("Сейчас ход другого игрока");
  const expected=s.phase==="jackRed"||s.phase==="jackBlue"?s.currentJackBox:ensureActivePlayer(s,side),box=Number(data.box);
  if(box!==expected)throw new Error("Можно двигаться только в активном боксе");
  const mu=BALL_R/BW,mv=BALL_R/(my(12.5)-throwingY());
  s.launcherPositions[box]={u:clamp(data.u,mu,1-mu),v:clamp(data.v,mv,1-mv)};return s;
}
function applyDecline(s,side,events=[]){
  if(currentSide(s)!==side||s.phase!==side)throw new Error("Сейчас нельзя отказаться от мячей");
  if(ballsLeft(s,side)<=0)throw new Error("Мячей уже не осталось");
  for(const item of s.ballInventory[side])item.used=true;
  setBallsLeft(s,side,0);

  const other=opponent(side);
  if(ballsLeft(s,other)>0){
    s.phase=other;
    ensureActivePlayer(s,other);
    ensureSelectedBall(s,other);
  }else{
    finishEnd(s,events);
  }
  return s;
}
function makeRoomCode(){let out="";for(let i=0;i<5;i++)out+=ROOM_CHARS[Math.floor(Math.random()*ROOM_CHARS.length)];return out}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(request.method==="OPTIONS")return new Response(null,{status:204,headers:cors()});
    if(url.pathname==="/"||url.pathname==="/health")return new Response("Boccia SERVER GAME — OK",{headers:cors({"Content-Type":"text/plain; charset=utf-8"})});

    if(url.pathname==="/create-room"){
      if(!env.BOCCIA_ROOMS)return json({error:"BOCCIA_ROOMS binding missing"},500);
      const clientKey=String(url.searchParams.get("clientKey")||"").slice(0,160);if(!clientKey)return json({error:"clientKey required"},400);
      const config={
        matchFormat:FORMAT_CONFIGS[url.searchParams.get("format")]?url.searchParams.get("format"):"individual",
        fieldOrientation:url.searchParams.get("orientation")==="horizontal"?"horizontal":"vertical",
        realisticMode:url.searchParams.get("realism")==="1"
      };
      for(let attempt=0;attempt<12;attempt++){
        const code=makeRoomCode(),id=env.BOCCIA_ROOMS.idFromName(code),stub=env.BOCCIA_ROOMS.get(id);
        const init=await stub.fetch(new Request("https://room.internal/init",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code,clientKey,config})}));
        if(init.status===201)return json({code,config},201);
        if(init.status!==409)return json({error:"Could not create room"},500);
      }
      return json({error:"Could not allocate room code"},503);
    }

    if(url.pathname.startsWith("/room-check/")){
      const code=url.pathname.split("/")[2]?.toUpperCase().replace(/[^A-Z0-9]/g,"");
      if(!code||code.length<4||code.length>8)return json({exists:false},404);
      const stub=env.BOCCIA_ROOMS.get(env.BOCCIA_ROOMS.idFromName(code)),r=await stub.fetch("https://room.internal/exists");
      return r.status===200?json({exists:true}):json({exists:false},404);
    }

    if(url.pathname.startsWith("/room/")){
      const code=url.pathname.split("/")[2]?.toUpperCase().replace(/[^A-Z0-9]/g,"");
      if(!code||code.length<4||code.length>8)return new Response("Invalid room code",{status:400});
      if((request.headers.get("Upgrade")||"").toLowerCase()!=="websocket")return new Response("WebSocket required",{status:426});
      return env.BOCCIA_ROOMS.get(env.BOCCIA_ROOMS.idFromName(code)).fetch(request);
    }
    return new Response("Not found",{status:404,headers:cors()});
  }
};

export class BocciaRoom extends DurableObject {
  constructor(ctx,env){
    super(ctx,env);this.sessions=new Map();
    for(const ws of this.ctx.getWebSockets()){const p=ws.deserializeAttachment();if(p)this.sessions.set(ws,p)}
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping","pong"));
  }
  async fetch(request){
    const url=new URL(request.url);
    if(url.pathname==="/init"&&request.method==="POST"){
      if(await this.ctx.storage.get("createdAt"))return new Response("exists",{status:409});
      const body=await request.json(),config={
        matchFormat:FORMAT_CONFIGS[body?.config?.matchFormat]?body.config.matchFormat:"individual",
        fieldOrientation:body?.config?.fieldOrientation==="horizontal"?"horizontal":"vertical",
        realisticMode:!!body?.config?.realisticMode
      };
      await this.ctx.storage.put("createdAt",Date.now());await this.ctx.storage.put("roomCode",String(body.code||""));
      await this.ctx.storage.put("config",config);await this.ctx.storage.put("revision",0);
      await this.ctx.storage.put("seats",{red:{clientKey:String(body.clientKey||"").slice(0,160),ready:false},blue:null});
      await this.ctx.storage.put("processedActions",[]);await this.ctx.storage.setAlarm(Date.now()+EMPTY_ROOM_TTL_MS);
      return new Response("created",{status:201});
    }
    if(url.pathname==="/exists")return new Response(await this.ctx.storage.get("createdAt")?"yes":"no",{status:await this.ctx.storage.get("createdAt")?200:404});
    if(!await this.ctx.storage.get("createdAt"))return new Response("Room not found",{status:404});
    if((request.headers.get("Upgrade")||"").toLowerCase()!=="websocket")return new Response("WebSocket required",{status:426});
    await this.ctx.storage.deleteAlarm();
    const pair=new WebSocketPair(),[client,server]=Object.values(pair);this.ctx.acceptWebSocket(server);
    const player={id:crypto.randomUUID(),clientKey:null,side:null,ready:false};server.serializeAttachment(player);this.sessions.set(server,player);
    return new Response(null,{status:101,webSocket:client});
  }
  async getSeats(){return(await this.ctx.storage.get("seats"))||{red:null,blue:null}}
  async getState(){return(await this.ctx.storage.get("gameState"))||null}
  async getRevision(){return Number((await this.ctx.storage.get("revision"))||0)}
  async getConfig(){return(await this.ctx.storage.get("config"))||{matchFormat:"individual",fieldOrientation:"vertical",realisticMode:false}}
  async playerList(){
    const seats=await this.getSeats(),result=[];
    for(const side of["red","blue"]){
      const seat=seats[side];if(!seat)continue;let connected=false,id=null;
      for(const p of this.sessions.values())if(p.clientKey&&p.clientKey===seat.clientKey){connected=true;id=p.id;break}
      result.push({id,side,ready:!!seat.ready,connected});
    }
    return result;
  }
  async roomStatePayload(extra={}){return{type:"room_state",players:await this.playerList(),config:await this.getConfig(),...extra}}
  async snapshotPayload(extra={}){return{type:"snapshot",revision:await this.getRevision(),state:await this.getState(),players:await this.playerList(),config:await this.getConfig(),...extra}}
  async broadcast(data){const msg=JSON.stringify(data);for(const ws of this.ctx.getWebSockets())try{ws.send(msg)}catch{}}
  async broadcastRoomState(extra={}){await this.broadcast(await this.roomStatePayload(extra))}
  async sendSnapshot(ws,extra={}){try{ws.send(JSON.stringify(await this.snapshotPayload(extra)))}catch{}}
  async processed(actionId){if(!actionId)return false;const ids=(await this.ctx.storage.get("processedActions"))||[];return ids.includes(String(actionId))}
  async rememberAction(actionId){
    if(!actionId)return;const ids=(await this.ctx.storage.get("processedActions"))||[],id=String(actionId);
    if(!ids.includes(id))ids.push(id);while(ids.length>80)ids.shift();await this.ctx.storage.put("processedActions",ids);
  }
  async maybeStartGame(triggerActionId=null){
    if(await this.getState())return;
    const seats=await this.getSeats();if(!seats.red?.ready||!seats.blue?.ready)return;
    const ps=await this.playerList();if(!ps.find(p=>p.side==="red")?.connected||!ps.find(p=>p.side==="blue")?.connected)return;
    const initial=createInitialState(await this.getConfig());initial.revision=1;
    await this.ctx.storage.put("revision",1);await this.ctx.storage.put("gameState",initial);
    await this.broadcast(await this.snapshotPayload({ackActionId:triggerActionId}));
  }
  async applyGameAction(ws,player,data){
    const actionId=String(data.actionId||"");if(!actionId)return;
    if(await this.processed(actionId)){await this.sendSnapshot(ws,{ackActionId:actionId});return}
    const state=await this.getState();
    if(!state){ws.send(JSON.stringify({type:"action_error",message:"Матч ещё не запущен",ackActionId:actionId,revision:await this.getRevision(),state:null}));return}
    let next=clone(state);
    let animation=null;
    let events=[];

    try{
      if(data.type==="throw"){
        const result=applyThrow(next,player.side,data);
        next=result.state;
        animation=result.animation||null;
        events=result.events||[];
      }
      else if(data.type==="select_player")next=applySelectPlayer(next,player.side,data);
      else if(data.type==="select_ball")next=applySelectBall(next,player.side,data);
      else if(data.type==="set_launcher")next=applyLauncher(next,player.side,data);
      else if(data.type==="decline")next=applyDecline(next,player.side,events);
      else throw new Error("Неизвестное действие");
    }catch(err){
      await this.rememberAction(actionId);
      ws.send(JSON.stringify({type:"action_error",message:err?.message||"Действие отклонено",ackActionId:actionId,revision:await this.getRevision(),state}));
      return;
    }
    const revision=(await this.getRevision())+1;next.revision=revision;
    await this.ctx.storage.put("revision",revision);await this.ctx.storage.put("gameState",next);await this.rememberAction(actionId);
    await this.broadcast(await this.snapshotPayload({
      ackActionId:actionId,
      action:data.type,
      actor:player.side,
      animation,
      events
    }));
  }
  async webSocketMessage(ws,message){
    let data;try{data=JSON.parse(message)}catch{return}
    let player=this.sessions.get(ws)||ws.deserializeAttachment()||{id:crypto.randomUUID(),clientKey:null,side:null,ready:false};

    if(data.type==="join"){
      const clientKey=String(data.clientKey||"").slice(0,160);if(!clientKey)return;
      const seats=await this.getSeats();let side=null;
      if(seats.red?.clientKey===clientKey)side="red";else if(seats.blue?.clientKey===clientKey)side="blue";
      else if(!seats.red){side="red";seats.red={clientKey,ready:false}}else if(!seats.blue){side="blue";seats.blue={clientKey,ready:false}}
      else{ws.send(JSON.stringify({type:"room_full"}));return}
      for(const[otherWs,other]of this.sessions.entries())if(otherWs!==ws&&other.clientKey&&other.clientKey===clientKey){this.sessions.delete(otherWs);try{otherWs.close(1012,"reconnected")}catch{}}
      player={id:crypto.randomUUID(),clientKey,side,ready:!!seats[side]?.ready};seats[side]={clientKey,ready:player.ready};
      await this.ctx.storage.put("seats",seats);ws.serializeAttachment(player);this.sessions.set(ws,player);await this.ctx.storage.deleteAlarm();
      ws.send(JSON.stringify({type:"joined",playerId:player.id,side:player.side,ready:player.ready,revision:await this.getRevision(),state:await this.getState(),players:await this.playerList(),config:await this.getConfig()}));
      await this.broadcastRoomState();return;
    }
    if(!player.side)return;
    if(data.type==="sync"){await this.sendSnapshot(ws);return}
    if(data.type==="ready"){
      const actionId=String(data.actionId||"");if(!actionId)return;
      if(await this.processed(actionId)){ws.send(JSON.stringify(await this.roomStatePayload({ackActionId:actionId})));await this.maybeStartGame(actionId);return}
      if(await this.getState()){await this.rememberAction(actionId);await this.sendSnapshot(ws,{ackActionId:actionId});return}
      const seats=await this.getSeats();if(!seats[player.side]||seats[player.side].clientKey!==player.clientKey)return;
      seats[player.side].ready=!!data.ready;player.ready=!!data.ready;ws.serializeAttachment(player);this.sessions.set(ws,player);
      await this.ctx.storage.put("seats",seats);await this.rememberAction(actionId);await this.broadcastRoomState({ackActionId:actionId});await this.maybeStartGame(actionId);return;
    }
    if(["throw","select_player","select_ball","set_launcher","decline"].includes(data.type)){await this.applyGameAction(ws,player,data);return}
    if(data.type==="restart"){
      const actionId=String(data.actionId||"");await this.ctx.storage.delete("gameState");await this.ctx.storage.put("revision",0);await this.ctx.storage.put("processedActions",[]);
      const seats=await this.getSeats();if(seats.red)seats.red.ready=false;if(seats.blue)seats.blue.ready=false;await this.ctx.storage.put("seats",seats);
      for(const[socket,p]of this.sessions.entries()){p.ready=false;socket.serializeAttachment(p);this.sessions.set(socket,p)}
      await this.broadcast({type:"restart",ackActionId:actionId||null});await this.broadcastRoomState();return;
    }
    if(data.type==="leave"){
      const seats=await this.getSeats();if(player.side&&seats[player.side]?.clientKey===player.clientKey){seats[player.side]=null;await this.ctx.storage.put("seats",seats)}
      this.sessions.delete(ws);await this.broadcastRoomState();try{ws.close(1000,"leave")}catch{}await this.scheduleCleanupIfEmpty();return;
    }
  }
  async scheduleCleanupIfEmpty(){if(this.ctx.getWebSockets().length===0)await this.ctx.storage.setAlarm(Date.now()+EMPTY_ROOM_TTL_MS)}
  async webSocketClose(ws){this.sessions.delete(ws);await this.broadcastRoomState();await this.scheduleCleanupIfEmpty()}
  async webSocketError(ws){this.sessions.delete(ws);await this.broadcastRoomState();await this.scheduleCleanupIfEmpty()}
  async alarm(){if(this.ctx.getWebSockets().length===0){await this.ctx.storage.deleteAll();this.sessions.clear();return}await this.ctx.storage.deleteAlarm()}
}
