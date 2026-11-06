import { DurableObject } from 'cloudflare:workers';
import { getAuthorizedUser, requireSameOrigin } from './security.js';
import { PRODUCTS, paymentConfigured, verifySlip, transferFingerprint } from './payments.js';
export { PaymentLedger, Inventory } from './ledger.js';
import { AVATARS, LUCKY_PRIZES, VIP_LIMIT, VIP_DURATION_MS, createGame, executeRoll, advance, randomInt, TURN_MS } from '../public/rules.js';

const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
const clampName=name=>String(name||'ผู้เล่น').trim().replace(/[<>\x00-\x1f]/g,'').slice(0,18)||'ผู้เล่น';
const validId=id=>typeof id==='string'&&/^[a-zA-Z0-9_:-]{1,128}$/.test(id);
const validRoom=id=>typeof id==='string'&&/^room-[a-f0-9-]{36}$/.test(id);
const publicOrder=o=>({id:o.id,sku:o.sku,amount:o.amount,status:o.status,createdAt:o.created_at,expiresAt:o.expires_at,fulfilledAt:o.fulfilled_at||null});
async function fulfillOrder(order,user,env){
  if(!order||order.uid!==user.id||!['verified','fulfilled'].includes(order.status))return json({error:'ยังไม่ได้ตรวจสอบการจ่ายเงิน'},409);
  if(order.status==='fulfilled')return json({ok:true,order:publicOrder(order)});
  try{
    const receipt=order.tx_hash;
    const result=order.sku==='vip'
      ? await env.VIP.get(env.VIP.idFromName('vip-memberships-v1')).activateAfterVerifiedPayment({userId:user.id,orderId:order.id,transactionId:receipt})
      : await env.ITEMS.get(env.ITEMS.idFromName('inventory-v1')).grant({uid:user.id,sku:order.sku,transactionId:receipt});
    if(!result.ok)return json({error:result.reason||'รอเจ้าหน้าที่ตรวจสอบสิทธิ์',status:'verified_not_fulfilled'},409);
    await env.PAYMENTS.get(env.PAYMENTS.idFromName('payment-ledger-v1')).markFulfilled({id:order.id,uid:user.id});
    return json({ok:true,expiresAt:result.expiresAt,order:publicOrder(await env.PAYMENTS.get(env.PAYMENTS.idFromName('payment-ledger-v1')).get(order.id,user.id))});
  }catch(e){console.error('fulfillment failed',String(e?.message||e).slice(0,80));return json({error:'ชำระเงินตรวจผ่านแล้ว แต่การเปิดสิทธิ์ยังไม่สำเร็จ โปรดติดต่อผู้ดูแลพร้อมเลขคำสั่งซื้อ',status:'verified_not_fulfilled'},503);}
}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(url.pathname==='/api/health')return json({ok:true,mode:'staging',game:'snakes-and-ladders',authConfigured:Boolean(env.FIREBASE_PROJECT_ID&&env.FIREBASE_API_KEY),paymentsEnabled:paymentConfigured(env)});
    if(url.pathname==='/api/config')return json({
      firebase:env.FIREBASE_PROJECT_ID&&env.FIREBASE_API_KEY&&env.FIREBASE_AUTH_DOMAIN&&env.FIREBASE_APP_ID?{
        apiKey:env.FIREBASE_API_KEY,authDomain:env.FIREBASE_AUTH_DOMAIN,projectId:env.FIREBASE_PROJECT_ID,appId:env.FIREBASE_APP_ID
      }:null,
      paymentsEnabled:paymentConfigured(env),
      merchant:paymentConfigured(env)?{name:env.MERCHANT_DISPLAY_NAME||null,account:env.MERCHANT_PUBLIC_ACCOUNT||null}:null
    });
    // All mutations require a verified Firebase Google ID token and same-origin request.
    const protectedAPI=url.pathname==='/api/me'||url.pathname==='/api/profile'||url.pathname==='/api/match'||url.pathname==='/api/orders'||url.pathname.startsWith('/api/orders/');
    let user=null;
    if(protectedAPI){
      if(!requireSameOrigin(request))return json({error:'Origin not allowed'},403);
      user=await getAuthorizedUser(request,env);
      if(!user)return json({error:'กรุณาเข้าสู่ระบบด้วย Google'},401);
    }
    const vip=()=>env.VIP.get(env.VIP.idFromName('vip-memberships-v1'));
    const items=()=>env.ITEMS.get(env.ITEMS.idFromName('inventory-v1'));
    const ledger=()=>env.PAYMENTS.get(env.PAYMENTS.idFromName('payment-ledger-v1'));
    if(url.pathname==='/api/me'&&request.method==='GET')return json({
      id:user.id,email:user.email,
      vip:await vip().hasAccess(user.id),
      items:await items().getItems(user.id),
      nickname:(await items().getProfile(user.id)).name
    });
    if(url.pathname==='/api/profile'&&request.method==='POST'){
      if(Number(request.headers.get('Content-Length')||0)>1000)return json({error:'ข้อมูลชื่อใหญ่เกินไป'},413);
      let body;try{body=await request.json();}catch{return json({error:'รูปแบบข้อมูลไม่ถูกต้อง'},400);}
      const result=await items().setProfile({uid:user.id,name:body?.name});
      if(!result.ok)return json({error:'ชื่อผู้เล่นต้องมี 1–18 ตัวอักษร และไม่มีสัญลักษณ์ต้องห้าม'},400);
      // Update old leaderboard labels without modifying earned points.
      await Promise.allSettled(['free','vip'].map(server=>
        env.SCORES.get(env.SCORES.idFromName(`scores-${server}-v1`))
          .rename({id:user.id,name:result.profile.name})
      ));
      return json({ok:true,nickname:result.profile.name});
    }
    if(url.pathname==='/api/orders'&&request.method==='POST'){
      if(!paymentConfigured(env))return json({error:'ยังไม่เปิดรับชำระเงินจริง'},503);
      let body;try{body=await request.json();}catch{return json({error:'Bad JSON'},400);}
      if(!PRODUCTS[body?.sku])return json({error:'ไม่มีสินค้านี้'},400);
      const id=`order-${crypto.randomUUID()}`;
      const created=await ledger().create({id,uid:user.id,sku:body.sku});
      if(!created.ok)return json({error:created.reason},429);
      const order=created.order;
      if(order.sku==='vip'){
        const reserved=await vip().reserveForCheckout({userId:user.id,orderId:order.id});
        if(!reserved.ok)return json({error:reserved.reason},409);
      }
      return json({order:publicOrder(order)},201);
    }
    const orderMatch=url.pathname.match(/^\/api\/orders\/(order-[a-f0-9-]{36})(?:\/(verify|reconcile))?$/);
    if(orderMatch){
      const [,id,action]=orderMatch;
      const current=await ledger().get(id,user.id);
      if(!current)return json({error:'ไม่พบคำสั่งซื้อ'},404);
      if(!action&&request.method==='GET')return json({order:publicOrder(current)});
      if(action==='reconcile'&&request.method==='POST'){
        return await fulfillOrder(current,user,env);
      }
      if(action==='verify'&&request.method==='POST'){
        if(!paymentConfigured(env))return json({error:'ยังไม่เปิดรับชำระเงินจริง'},503);
        if(Number(request.headers.get('Content-Length')||0)>4_300_000)return json({error:'ไฟล์ใหญ่เกินไป'},413);
        const lock=await ledger().takeVerification({id,uid:user.id});
        if(!lock.ok)return json({error:lock.reason},409);
        if(lock.alreadyPaid)return await fulfillOrder(lock.order,user,env);
        try{
          const form=await request.formData();
          const verification=await verifySlip(form.get('slip'),{
            amount:current.amount,createdAt:current.created_at,expiresAt:current.expires_at
          },env);
          const hash=await transferFingerprint(verification);
          const confirmed=await ledger().recordVerified({id,uid:user.id,hash});
          if(!confirmed.ok)return json({error:confirmed.reason},409);
          return await fulfillOrder(await ledger().get(id,user.id),user,env);
        }catch(e){
          console.warn('slip verification failed',String(e?.message||'error').slice(0,80));
          return json({error:String(e?.message||'ตรวจสลิปไม่สำเร็จ')},422);
        }finally{await ledger().unlock({id,uid:user.id});}
      }
    }
    if(url.pathname==='/api/match'&&request.method==='POST'){
      let body;try{body=await request.json();}catch{return json({error:'รูปแบบข้อมูลไม่ถูกต้อง'},400);}
      const server=body?.server==='vip'?'vip':body?.server==='free'?'free':null;
      if(!server)return json({error:'เลือกเซิร์ฟเวอร์ให้ถูกต้อง'},400);
      if(server==='vip'&&!await vip().hasAccess(user.id))return json({error:'ต้องมีสมาชิก VIP ที่ยังไม่หมดอายุ'},403);
      const inventory=await items().getItems(user.id);
      const savedName=(await items().getProfile(user.id)).name;
      if(!savedName)return json({error:'กรุณาบันทึกชื่อผู้เล่นก่อนจับคู่'},409);
      const profile={id:user.id,name:savedName,avatar:Number.isInteger(body.avatar)&&body.avatar>=0&&body.avatar<AVATARS.length?body.avatar:0,
        server,shield:inventory.shield>Date.now()?1:0,rewardX2:inventory.win2>Date.now()};
      try{
        const lobby=env.LOBBY.get(env.LOBBY.idFromName(`lobby-${server}-v1`));
        return json(await lobby.assign(profile));
      }catch(e){console.error('match',e);return json({error:'ขัดข้องชั่วคราว กรุณาลองใหม่'},503);}
    }
    if(url.pathname==='/api/vip/capacity' && request.method==='GET'){
      try{return json(await env.VIP.get(env.VIP.idFromName('vip-memberships-v1')).getStatus());}
      catch(e){console.error('vip capacity',e);return json({error:'VIP capacity unavailable'},503);}
    }
    if(url.pathname==='/api/leaderboard'){
      try{const board=url.searchParams.get('server')==='vip'?'vip':'free';
        return json({leaders:await env.SCORES.get(env.SCORES.idFromName(`scores-${board}-v1`)).getLeaders()});}
      catch(e){console.error('leaders',e);return json({leaders:[]},503);}
    }
    if(url.pathname==='/ws'){
      const room=url.searchParams.get('room');
      if(!validRoom(room))return json({error:'ห้องไม่ถูกต้อง'},400);
      if(!requireSameOrigin(request))return json({error:'Origin not allowed'},403);
      const stub=env.ROOM.get(env.ROOM.idFromName(room));
      return stub.fetch(request);
    }
    if(request.method==='GET'||request.method==='HEAD')return env.ASSETS.fetch(request);
    return json({error:'Not found'},404);
  }
};

// One lobby per server. Duplicate matchmaking retries rejoin the existing room,
// instead of reserving multiple seats for one Google UID.
export class Lobby extends DurableObject {
  async assign(profile){
    return this.ctx.blockConcurrencyWhile(async()=>{
      const now=Date.now();
      const key=`member:${profile.id}`;
      const previous=this.ctx.storage.kv.get(key);
      if(previous&&now-previous.at<60*60_000){
        const stub=this.env.ROOM.get(this.env.ROOM.idFromName(previous.roomId));
        const renewed=await stub.reissueTicket({userId:profile.id});
        if(renewed.ok)return {room:previous.roomId,ticket:renewed.ticket,playerId:profile.id,seat:renewed.seat,rejoined:true};
      }
      let waiting=this.ctx.storage.kv.get('waiting');
      if(!waiting||waiting.count>=3||now-waiting.created>90_000){
        waiting={roomId:`room-${crypto.randomUUID()}`,count:0,created:now};
      }
      const ticket=crypto.randomUUID();
      const room=this.env.ROOM.get(this.env.ROOM.idFromName(waiting.roomId));
      let accepted=await room.reserve({profile,ticket,roomId:waiting.roomId});
      if(!accepted.ok){
        waiting={roomId:`room-${crypto.randomUUID()}`,count:0,created:now};
        accepted=await this.env.ROOM.get(this.env.ROOM.idFromName(waiting.roomId)).reserve({profile,ticket,roomId:waiting.roomId});
        if(!accepted.ok)throw Error('Room reservation failed');
      }
      waiting.count++;
      this.ctx.storage.kv.put('waiting',waiting);
      this.ctx.storage.kv.put(key,{roomId:waiting.roomId,at:now});
      return {room:waiting.roomId,ticket,playerId:profile.id,seat:waiting.count};
    });
  }
}

export class GameRoom extends DurableObject {
  load(){return this.ctx.storage.kv.get('game');}
  save(game){this.ctx.storage.kv.put('game',game);}
  async reserve({profile,ticket,roomId}){
    let game=this.load()||createGame(roomId);
    const now=Date.now();
    if(game.players.length===0){game.server=profile.server;game.waitExpiresAt=now+120_000;}
    if(game.status!=='waiting'||now>=(game.waitExpiresAt||0)||game.players.length>=3||game.players.some(p=>p.id===profile.id)||game.server!==profile.server)return {ok:false};
    game.players.push({id:profile.id,name:profile.name,avatar:profile.avatar,pos:0,shield:profile.shield||0,rewardX2:profile.rewardX2===true,stars:0,ticket,issuedAt:now});
    this.save(game);
    if(game.players.length===1)await this.ctx.storage.setAlarm(game.waitExpiresAt);
    return {ok:true};
  }
  // Rejoin is allowed only for a UID already reserved in this specific room.
  // Refreshing the short-lived bearer ticket revokes the previous ticket.
  async reissueTicket({userId}){
    let game=this.load();
    // Catch up skipped turns even if this room had no connected sockets.
    if(game?.status==='playing'&&Date.now()>=game.turnEndsAt){
      await this.timeout(game);
      game=this.load();
    }
    if(!game||!['waiting','playing'].includes(game.status)||
       (game.status==='waiting'&&Date.now()>=(game.waitExpiresAt||0)))return {ok:false};
    const seat=game.players.findIndex(p=>p.id===userId);
    if(seat<0)return {ok:false};
    const ticket=crypto.randomUUID();
    game.players[seat].ticket=ticket;
    game.players[seat].issuedAt=Date.now();
    this.save(game);
    return {ok:true,ticket,seat:seat+1};
  }
  activeIds(){
    return [...new Set(this.ctx.getWebSockets().map(ws=>ws.deserializeAttachment()?.pid).filter(Boolean))];
  }
  safeState(game){
    // Never include reservation tickets in a broadcast.
    const {players,...rest}=game;
    return {...rest,players:players.map(({ticket,issuedAt,...p})=>p)};
  }
  broadcast(game){
    const message=JSON.stringify({type:'state',state:this.safeState(game),connected:this.activeIds(),serverTime:Date.now()});
    for(const ws of this.ctx.getWebSockets())try{ws.send(message);}catch{}
  }
  // Three consecutive turns without a valid roll (about 60 seconds).
  maxNoRollTurns(){return 3;}
  async scheduleTurnAlarm(game,retryPrize=false){
    if(game.status!=='playing')return;
    const remaining=Math.max(1,this.maxNoRollTurns()-(game.noRollTurns||0));
    // When everyone disconnects, hibernate until the final no-roll deadline.
    // The exact skipped turns are settled when a player reconnects or the alarm fires.
    const wake=this.activeIds().length?game.turnEndsAt:
      game.turnEndsAt+(remaining-1)*TURN_MS;
    await this.ctx.storage.setAlarm(retryPrize?Math.min(wake,Date.now()+15_000):wake);
  }
  async closeForNoRolls(game){
    game.status='abandoned';
    game.closeReason='no_rolls_3_turns';
    game.closedAt=Date.now();
    game.lastRoll=0;game.lastMove=0;
    game.log=['🚪 ปิดห้องอัตโนมัติ: ไม่มีผู้เล่นทอยลูกเต๋าติดต่อกันครบ 3 เทิร์น',...game.log].slice(0,5);
    this.save(game);this.broadcast(game);
    for(const ws of this.ctx.getWebSockets()){
      try{ws.close(4003,'Room closed: no rolls for 3 turns');}catch{}
    }
    // Keep retrying an earned Lucky Box award if the scoreboard was temporarily unavailable.
    if(game.boxUsed&&!game.prizeCredited)await this.ctx.storage.setAlarm(Date.now()+15_000);
  }
  async fetch(request){
    if(request.headers.get('Upgrade')?.toLowerCase()!=='websocket')return json({error:'WebSocket required'},426);
    const ticket=new URL(request.url).searchParams.get('ticket');
    let game=this.load();
    if(game?.status==='playing'&&Date.now()>=game.turnEndsAt){
      await this.timeout(game);
      game=this.load();
    }
    const player=game?.players.find(p=>p.ticket===ticket&&Date.now()-p.issuedAt<120_000);
    if(!player||!ticket||game.status==='abandoned')return json({error:'ไม่มีสิทธิ์เข้าห้อง'},403);
    for(const ws of this.ctx.getWebSockets()){
      if(ws.deserializeAttachment()?.pid===player.id){try{ws.close(4001,'Reconnected');}catch{}}
    }
    const pair=new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({pid:player.id});
    if(game.status==='playing'){
      // Reconnecting cannot reset the no-roll counter or extend the current turn.
      await this.scheduleTurnAlarm(game);
    }
    if(game.status==='waiting'&&game.players.length===3&&this.activeIds().length===3){
      game.status='playing';game.current=0;game.noRollTurns=0;game.turnEndsAt=Date.now()+TURN_MS;
      game.log=['เริ่มเกม! ผู้เล่นแต่ละคนมีเวลา 20 วินาที',...game.log].slice(0,5);
      this.save(game);
      await this.ctx.storage.setAlarm(game.turnEndsAt);
    }
    this.broadcast(game);
    return new Response(null,{status:101,webSocket:pair[0]});
  }
  async webSocketMessage(ws,message){
    if(typeof message!=='string'||message.length>256)return;
    let msg;try{msg=JSON.parse(message);}catch{return;}
    if(msg?.type!=='roll')return;
    const game=this.load();if(!game||game.status!=='playing')return;
    // Never accept a late roll. Settle every timed-out turn first.
    if(Date.now()>=game.turnEndsAt){await this.timeout(game);return;}
    const pid=ws.deserializeAttachment()?.pid;
    if(game.players[game.current]?.id!==pid)return;
    const dice=randomInt(6)+1;
    game.noRollTurns=0;
    executeRoll(game,game.current,dice);
    if(game.status==='playing')advance(game);
    this.save(game);
    this.broadcast(game);
    // Both rewards are idempotent on the Scores Durable Object using room-scoped keys.
    const prizeRetry=await this.creditPrize(game);
    if(game.status==='finished')await this.creditWinner(this.load());
    const latest=this.load();
    if(latest.status==='playing')await this.scheduleTurnAlarm(latest,prizeRetry);
    else if(prizeRetry)await this.ctx.storage.setAlarm(Date.now()+15_000);
  }
  async timeout(game){
    if(game.status!=='playing'||Date.now()<game.turnEndsAt)return;
    const now=Date.now();
    // Fast-forward missed turns based on their original deadlines (not "now").
    // This is also safe for rooms with zero open WebSockets.
    let expired=0;
    while(game.status==='playing'&&now>=game.turnEndsAt&&expired<this.maxNoRollTurns()){
      const name=game.players[game.current]?.name||'ผู้เล่น';
      game.noRollTurns=(game.noRollTurns||0)+1;
      expired++;
      if(game.noRollTurns>=this.maxNoRollTurns()){
        await this.closeForNoRolls(game);
        break;
      }
      game.log=[`⌛ ${name} หมดเวลา — ข้ามตาโดยไม่ทอย (${game.noRollTurns}/3)`,...game.log].slice(0,5);
      game.lastRoll=0;game.lastMove=0;
      game.current=(game.current+1)%3;
      game.turnEndsAt+=TURN_MS;
    }
    if(game.status==='playing'){
      this.save(game);this.broadcast(game);
      await this.scheduleTurnAlarm(game,game.boxUsed&&!game.prizeCredited);
    }
  }
  async creditPrize(game){
    if(!game?.boxUsed||game.prizeCredited||!game.boxWinnerId||!game.boxReward)return false;
    const awarded=game.players.find(p=>p.id===game.boxWinnerId);
    if(!awarded)return false;
    try{
      // A false response also means the same one-time award was already processed.
      await this.env.SCORES.get(this.env.SCORES.idFromName(`scores-${game.server||'free'}-v1`)).creditPrize({
        id:awarded.id,name:awarded.name,avatar:awarded.avatar,gameId:game.roomId,points:game.boxReward
      });
      const latest=this.load();
      if(latest?.roomId===game.roomId&&!latest.prizeCredited){latest.prizeCredited=true;this.save(latest);}
      return false;
    }catch(e){console.error('lucky box credit',e);return true;}
  }
  async creditWinner(game){
    if(!game.winnerId||game.credited)return;
    const winner=game.players.find(p=>p.id===game.winnerId);
    if(!winner)return;
    try{
      await this.env.SCORES.get(this.env.SCORES.idFromName(`scores-${game.server||'free'}-v1`)).credit({id:winner.id,name:winner.name,avatar:winner.avatar,gameId:game.roomId,points:game.winPoints||10});
      game.credited=true;this.save(game);
    }catch(e){console.error('credit',e);await this.ctx.storage.setAlarm(Date.now()+15_000);}
  }
  async alarm(){
    let game=this.load();if(!game)return;
    if(game.status==='waiting'){
      if(Date.now()>=(game.waitExpiresAt||0)){
        game.status='abandoned';
        game.closeReason='waiting_expired';
        game.log=['ห้องรอผู้เล่นไม่ครบภายในเวลาที่กำหนด กรุณาจับคู่ใหม่',...game.log].slice(0,5);
        this.save(game);this.broadcast(game);
        for(const ws of this.ctx.getWebSockets())try{ws.close(4003,'Waiting room expired');}catch{}
      }else await this.ctx.storage.setAlarm(game.waitExpiresAt);
      return;
    }
    const prizeRetry=await this.creditPrize(game);
    game=this.load();
    if(game.status==='playing'){
      if(Date.now()>=game.turnEndsAt)await this.timeout(game);
      else await this.scheduleTurnAlarm(game,prizeRetry);
    }else if(game.status==='finished'){
      if(!game.credited)await this.creditWinner(game);
      if(prizeRetry)await this.ctx.storage.setAlarm(Date.now()+15_000);
    }else if(game.status==='abandoned'&&prizeRetry){
      await this.ctx.storage.setAlarm(Date.now()+15_000);
    }
  }
  async webSocketClose(ws){
    const game=this.load();
    if(game?.status==='playing'&&this.activeIds().length===0){
      // Single wake-up at the 3-round no-roll deadline, not an endless 20s loop.
      await this.scheduleTurnAlarm(game,game.boxUsed&&!game.prizeCredited);
    }
    if(game)this.broadcast(game);
  }
  async webSocketError(ws){
    const game=this.load();if(game)this.broadcast(game);
  }
}

export class Scores extends DurableObject {
  async credit({id,name,avatar,gameId,points=10}){
    if(points!==10&&points!==20)return false;
    return this.award({id,name,avatar,gameId,points,kind:'win'});
  }
  async creditPrize({id,name,avatar,gameId,points}){
    if(!LUCKY_PRIZES.some(p=>p.points===points))return false;
    return this.award({id,name,avatar,gameId,points,kind:'box'});
  }
  award({id,name,avatar,gameId,points,kind}){
    if(!validId(id)||!validRoom(gameId)||!['win','box'].includes(kind)||!Number.isInteger(points))return false;
    const key=`award:${kind}:${gameId}`;
    if(this.ctx.storage.kv.get(key))return false;
    const old=this.ctx.storage.kv.get(`score:${id}`)||0;
    const score=old+points;
    this.ctx.storage.kv.put(key,id);
    this.ctx.storage.kv.put(`score:${id}`,score);
    const leaders=this.ctx.storage.kv.get('leaders')||[];
    const next=[...leaders.filter(p=>p.id!==id),{id,name:clampName(name),avatar,score}]
      .sort((a,b)=>b.score-a.score).slice(0,50);
    this.ctx.storage.kv.put('leaders',next);
    return true;
  }
  async getLeaders(){return this.ctx.storage.kv.get('leaders')||[];}
  async rename({id,name}){
    if(!validId(id)||typeof name!=='string'||!name.trim())return false;
    const leaders=this.ctx.storage.kv.get('leaders')||[];
    const next=leaders.map(p=>p.id===id?{...p,name:clampName(name)}:p);
    if(next.some((p,i)=>p.name!==leaders[i].name)){
      this.ctx.storage.kv.put('leaders',next);return true;
    }
    return false;
  }
}

// One globally named Durable Object for a hard cap of 100 ACTIVE VIP subscribers.
// There is intentionally NO public checkout/activation endpoint in this prototype.
// Only a future authenticated checkout Worker, *after* verifying payment on the
// provider's server-to-server API, may call reserveForCheckout/activateAfterVerifiedPayment.
// Never take paid/verified data from the browser.
export class VipMemberships extends DurableObject {
  state(){return this.ctx.storage.kv.get('vip:registry')||{members:{},holds:{},receipts:{}};}
  save(v){this.ctx.storage.kv.put('vip:registry',v);}
  clean(v,now){
    for(const [id,m] of Object.entries(v.members))if(m.expiresAt<=now)delete v.members[id];
    for(const [id,h] of Object.entries(v.holds))if(h.expiresAt<=now)delete v.holds[id];
    return v;
  }
  statusData(v){
    const active=Object.keys(v.members).length;
    const reserved=Object.keys(v.holds).filter(id=>!v.members[id]).length;
    return {limit:VIP_LIMIT,active,reserved,available:Math.max(0,VIP_LIMIT-active-reserved),full:active+reserved>=VIP_LIMIT};
  }
  async getStatus(){
    const now=Date.now();const v=this.clean(this.state(),now);this.save(v);
    return this.statusData(v);
  }
  // Internal only: requires authenticated userId and unique provider orderId.
  async reserveForCheckout({userId,orderId}){
    if(typeof userId!=='string'||!userId||typeof orderId!=='string'||!orderId)return {ok:false,reason:'invalid_order'};
    const now=Date.now(),v=this.clean(this.state(),now);
    const hold=v.holds[userId];
    if(hold){return hold.orderId===orderId?{ok:true,expiresAt:hold.expiresAt}:{ok:false,reason:'existing_hold'};}
    // Renewing a currently active membership never consumes a second slot.
    if(!v.members[userId]&&this.statusData(v).full)return {ok:false,reason:'vip_full'};
    const expiresAt=now+15*60_000;
    v.holds[userId]={orderId,expiresAt};this.save(v);
    return {ok:true,expiresAt};
  }
  // Internal only: caller must have validated settled transaction with payment provider.
  async activateAfterVerifiedPayment({userId,orderId,transactionId}){
    if(typeof userId!=='string'||!userId||typeof orderId!=='string'||!orderId||typeof transactionId!=='string'||!transactionId)return {ok:false,reason:'invalid_payment'};
    const now=Date.now(),v=this.clean(this.state(),now);
    if(v.receipts[transactionId])return v.receipts[transactionId].userId===userId&&v.receipts[transactionId].orderId===orderId
      ? {ok:true,alreadyApplied:true,expiresAt:v.receipts[transactionId].expiresAt}
      : {ok:false,reason:'duplicate_receipt'};
    const hold=v.holds[userId];
    if(!hold||hold.orderId!==orderId)return {ok:false,reason:'missing_or_expired_hold'};
    if(!v.members[userId]&&Object.keys(v.members).length>=VIP_LIMIT)return {ok:false,reason:'vip_full'};
    const expiresAt=Math.max(now,v.members[userId]?.expiresAt||now)+VIP_DURATION_MS;
    v.members[userId]={expiresAt};delete v.holds[userId];
    v.receipts[transactionId]={userId,orderId,expiresAt};
    this.save(v);return {ok:true,expiresAt};
  }
  async hasAccess(userId){const v=this.clean(this.state(),Date.now());this.save(v);return Boolean(v.members[userId]);}
}
