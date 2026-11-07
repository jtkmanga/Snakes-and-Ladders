import {SNAKES,LADDERS,AVATARS,TURN_MS,LUCKY_PRIZES,createGame,executeRoll,advance,randomInt,movementPath} from './rules.js';

const $=id=>document.getElementById(id);
let selectedAvatar=0, mode='demo',game=null,me=null,socket=null,clockOffset=0;
const memoryStore=new Map();
const store={getItem(k){try{return localStorage.getItem(k)??memoryStore.get(k)??null;}catch{return memoryStore.get(k)??null;}},setItem(k,v){memoryStore.set(k,String(v));try{localStorage.setItem(k,String(v));}catch{}}};
let demoTimers=[],demoScore=Number(store.getItem('paperRaceDemoScore')||0),waiting=false;
let backendReady=false,rollPending=false,toastTimer;
let lastAnimationKey=null,animationGeneration=0;const animatingSeats=new Set();
let selectedServer='free',view='auth',googleUser=null,authClient=null,publicConfig=null,serverMe=null;
let savedNickname='',nicknameLoading=false,nicknameSaving=false;
const ITEM_KEYS={dice:'snlTrialWinBonusExpires',shield:'snlTrialShieldExpires'};
const DAY_MS=86_400_000;
function itemExpiry(k){return Number(store.getItem(ITEM_KEYS[k])||0)}
function itemActive(k){return itemExpiry(k)>Date.now()}
function showScreen(name){view=name;document.querySelectorAll('.screen').forEach(el=>el.classList.toggle('active',el.id==='screen-'+name));if(name==='lobby'){updateLobby();renderLeaderboard();}window.scrollTo?.(0,0);}
function endCurrentMatch(){animationGeneration++;lastAnimationKey=null;animatingSeats.clear();$('board').dataset.roomKey='';if(socket){socket.close();socket=null;}clearDemoTimers();waiting=false;rollPending=false;game=null;mode='demo';}
function formatRemaining(ts){const h=Math.max(0,Math.ceil((ts-Date.now())/3600000));return h>1?`เหลือประมาณ ${h} ชั่วโมง`:'เหลือน้อยกว่า 1 ชั่วโมง';}
function updateShopUI(){for(const [k,id] of [['dice','dice-item-status'],['shield','shield-item-status']]){const paidExpiry=Number(serverMe?.items?.[k==='dice'?'win2':'shield']||0);$(id).textContent=paidExpiry>Date.now()?`✅ สิทธิ์ออนไลน์ใช้งานถึง ${new Date(paidExpiry).toLocaleString('th-TH')}`:itemActive(k)?`✅ ทดลองใช้งานอยู่ • ${formatRemaining(itemExpiry(k))}`:'ยังไม่มีไอเทม';const btn=$(k==='dice'?'trial-dice':'trial-shield');btn.disabled=itemActive(k);btn.textContent=itemActive(k)?'เปิดใช้งานอยู่ (ทดลอง)':'ทดลองใช้ฟรี 24 ชม.';}}
function updateLobby(){$('welcome-name').textContent=playerName();$('welcome-mascot').textContent=labelForAvatar(selectedAvatar);$('lobby-score').textContent=googleUser?'—':demoScore.toLocaleString('th-TH');$('lobby-server').textContent=selectedServer==='free'?'FREE':'VIP (ตัวอย่าง)';updateShopUI();}
function showModal(title,message,emoji='🍀'){$('modal-title').textContent=title;$('modal-text').textContent=message;$('modal-illustration').textContent=emoji;$('modal-backdrop').hidden=false;}
function closeModal(){$('modal-backdrop').hidden=true;}
function openMenu(){$('side-menu').hidden=false;$('menu-backdrop').hidden=false;}
function closeMenu(){$('side-menu').hidden=true;$('menu-backdrop').hidden=true;}
function chooseServer(server){selectedServer=server;for(const name of ['free','vip']){$('server-'+name).classList.toggle('selected',server===name);$('server-'+name).setAttribute('aria-pressed',String(server===name));}$('enter-btn').textContent=server==='free'?'เข้าสู่ Lobby ➜':'เข้าสู่ VIP Lobby ➜';}
function navigateTo(section){closeMenu();if(section==='rules'){showModal('วิธีเล่น','ห้องละ 3 คน ทอยลูกเต๋าครั้งละ 1–6 ภายใน 20 วินาที ไม่ทอยจะถูกข้ามตา • งูพาลง บันไดพาขึ้น • กล่องสุ่มมี 1 กล่อง/เกม • ถึงหรือเกิน 100 ชนะรับ +10 คะแนน (ใช้ไอเทมรางวัล ×2 ได้ +20) • ไอเทม ×2 ไม่เพิ่มระยะเดินและไม่คูณคะแนน Lucky Box' ,'📜');return;}if(section==='auth'){endCurrentMatch();showScreen('auth');return;}if(section==='lobby'||section==='shop'||section==='rank'){endCurrentMatch();showScreen('lobby');if(section==='shop')$('shop-section').scrollIntoView({behavior:'smooth',block:'start'});if(section==='rank')$('leaderboard').scrollIntoView({behavior:'smooth',block:'start'});}}
const DICE=['⚀','⚁','⚂','⚃','⚄','⚅'];
const humanId=(()=>{let id=store.getItem('paperRaceGuestId');if(!id){id=crypto.randomUUID?.()||`guest-${Date.now()}-${Math.random().toString(36).slice(2)}`;store.setItem('paperRaceGuestId',id);}return id;})();
const others=[1,2];
function escapeText(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function labelForAvatar(index){return AVATARS[index]?.emoji||'🐱';}
function playerName(){return (savedNickname||$('nickname').value.trim()||'ผู้เล่นของฉัน').slice(0,18);}
function updateNicknameControls(){
  const field=$('nickname'),button=$('nickname-action'),hint=$('nickname-hint');
  button.disabled=nicknameLoading||nicknameSaving;
  if(nicknameLoading){
    field.disabled=true;button.textContent='⏳ กำลังโหลด';
    hint.textContent='กำลังดึงชื่อผู้เล่นจากบัญชี Google…';return;
  }
  field.disabled=false;
  button.textContent=field.readOnly?'✏️ เปลี่ยนชื่อ':'💾 บันทึกชื่อ';
  hint.textContent=field.readOnly
    ?(googleUser?'✅ บันทึกกับบัญชี Google แล้ว ใช้ชื่อเดิมได้ทุกเครื่อง':'✅ จดจำชื่อในเบราว์เซอร์นี้แล้ว')
    :(googleUser?'ตั้งชื่อแล้วกดบันทึก ชื่อจะอยู่กับบัญชี Google ตลอด':'ตั้งชื่อแล้วกดบันทึก ชื่อจะจำไว้ในเบราว์เซอร์นี้');
}
function applySavedNickname(name){
  const clean=typeof name==='string'?name.trim():'';
  savedNickname=clean;
  $('nickname').value=clean;
  $('nickname').readOnly=Boolean(clean);
  nicknameLoading=false;updateNicknameControls();
  if(view==='lobby')updateLobby();
}
async function saveNickname(){
  if(nicknameSaving||nicknameLoading)return false;
  const name=$('nickname').value.trim().normalize('NFC');
  if(!name||name.length>18||/[<>\x00-\x1f\x7f]/.test(name)){
    showModal('ชื่อผู้เล่นไม่ถูกต้อง','โปรดตั้งชื่อยาว 1–18 ตัวอักษร โดยไม่ใช้สัญลักษณ์ < > หรืออักขระควบคุม','✏️');return false;
  }
  nicknameSaving=true;updateNicknameControls();
  try{
    let confirmed=name;
    if(googleUser){
      const uid=googleUser.uid;
      const response=await authorizedFetch('/api/profile',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});
      const result=await response.json();
      if(!response.ok)throw Error(result.error||'บันทึกชื่อไม่สำเร็จ');
      if(googleUser?.uid!==uid)throw Error('บัญชี Google เปลี่ยนไประหว่างบันทึกชื่อ');
      confirmed=result.nickname;
      if(serverMe)serverMe.nickname=confirmed;
    }else store.setItem('snlGuestNickname',confirmed);
    savedNickname=confirmed;$('nickname').value=confirmed;$('nickname').readOnly=true;
    if(view==='lobby')updateLobby();
    notice('✅ บันทึกชื่อ '+confirmed+' สำเร็จ');
    return true;
  }catch(e){
    showModal('บันทึกชื่อไม่สำเร็จ',e.message||'กรุณาลองอีกครั้ง','⚠️');return false;
  }finally{nicknameSaving=false;updateNicknameControls();}
}
function notice(message){clearTimeout(toastTimer);$('toast').textContent=message;$('toast').classList.add('show');toastTimer=setTimeout(()=>$('toast').classList.remove('show'),3500);}
function clearDemoTimers(){demoTimers.forEach(clearTimeout);demoTimers=[];}
function putDemoTimer(fn,ms){demoTimers.push(setTimeout(fn,ms));}
function posToXY(num){
  const n=Math.max(1,num),row=Math.floor((n-1)/10),idx=(n-1)%10;
  const col=row%2===0?idx:9-idx;
  return {x:(col+.5)*10,y:(9-row+.5)*10};
}
function renderBoard(){
  if(!game)return;
  const board=$('board');
  const cells=[];
  for(let row=9;row>=0;row--){
    const numbers=Array.from({length:10},(_,c)=>row*10+(row%2===0?c+1:10-c));
    for(const n of numbers){
      const special=n===100?'🏆':SNAKES[n]?'🐍':LADDERS[n]?'🪜':'';
      cells.push(`<div class="tile ${(n%2===0)?'mint':'white'} ${n===100?'finish':''} ${SNAKES[n]?'snake-mouth':''} ${LADDERS[n]?'ladder-foot':''}" data-tile="${n}"><span>${n}</span>${special?`<span class="special-icon">${special}</span>`:''}${!game.boxUsed&&game.boxAt===n?'<span class="chest-icon">🎁</span>':''}</div>`);
    }
  }
  const newRoom=board.dataset.roomKey!==String(game.roomId);
  if(newRoom){
    animationGeneration++;lastAnimationKey=null;animatingSeats.clear();
    board.dataset.roomKey=String(game.roomId);
    board.innerHTML=cells.join('')+'<svg class="effects" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true"></svg><div class="token-layer" id="token-layer"></div>';
    drawPaths();
  }else if(game.boxUsed){
    board.querySelector('.chest-icon')?.remove();
  }
  renderTokens();
  $('chest-label').textContent=game.boxUsed?`🎁 ออกแล้ว +${Number(game.boxReward||0).toLocaleString('th-TH')} คะแนน`:`🎁 กล่องอยู่ช่อง ${game.boxAt}`;
}
function svgEl(name,attrs={}){const node=document.createElementNS('http://www.w3.org/2000/svg',name);for(const [k,v] of Object.entries(attrs))node.setAttribute(k,v);return node;}
function drawPaths(){
  const svg=$('board').querySelector('svg');
  for(const [from,to] of Object.entries(SNAKES)){
    const a=posToXY(Number(from)),b=posToXY(to);let points=[];
    const dx=b.x-a.x,dy=b.y-a.y,l=Math.hypot(dx,dy),nx=-dy/l,ny=dx/l;
    for(let t=0;t<=1.001;t+=.035){const swing=Math.sin(t*Math.PI*5)*3.3*Math.sin(Math.PI*t);points.push([a.x+dx*t+nx*swing,a.y+dy*t+ny*swing]);}
    const data=points.map(([x,y],i)=>`${i?'L':'M'}${x*10} ${y*10}`).join(' ');
    svg.appendChild(svgEl('path',{d:data,fill:'none',stroke:'#fff0ce','stroke-width':35,'stroke-linecap':'round','stroke-linejoin':'round',opacity:'.95'}));
    svg.appendChild(svgEl('path',{d:data,fill:'none',stroke:'#75b7a0','stroke-width':25,'stroke-linecap':'round','stroke-linejoin':'round',opacity:'.95'}));
    svg.appendChild(svgEl('circle',{cx:a.x*10,cy:a.y*10,r:22,fill:'#61ab9e',stroke:'#f0e6cf','stroke-width':6}));
    svg.appendChild(svgEl('circle',{cx:a.x*10-7,cy:a.y*10-7,r:3.5,fill:'#334734'}));
    svg.appendChild(svgEl('circle',{cx:a.x*10+7,cy:a.y*10-7,r:3.5,fill:'#334734'}));
  }
  for(const [from,to] of Object.entries(LADDERS)){
    const a=posToXY(Number(from)),b=posToXY(to);
    const dx=b.x-a.x,dy=b.y-a.y,l=Math.hypot(dx,dy),nx=-dy/l*1.45,ny=dx/l*1.45;
    for(const sgn of [-1,1]){
      svg.appendChild(svgEl('line',{x1:(a.x+nx*sgn)*10,y1:(a.y+ny*sgn)*10,x2:(b.x+nx*sgn)*10,y2:(b.y+ny*sgn)*10,stroke:'#aa713b','stroke-width':17,'stroke-linecap':'round'}));
      svg.appendChild(svgEl('line',{x1:(a.x+nx*sgn)*10,y1:(a.y+ny*sgn)*10,x2:(b.x+nx*sgn)*10,y2:(b.y+ny*sgn)*10,stroke:'#f6cc78','stroke-width':11,'stroke-linecap':'round'}));
    }
    for(let t=.12;t<.94;t+=.125){const x=a.x+dx*t,y=a.y+dy*t;
      svg.appendChild(svgEl('line',{x1:(x+nx)*10,y1:(y+ny)*10,x2:(x-nx)*10,y2:(y-ny)*10,stroke:'#af7134','stroke-width':13,'stroke-linecap':'round'}));
      svg.appendChild(svgEl('line',{x1:(x+nx)*10,y1:(y+ny)*10,x2:(x-nx)*10,y2:(y-ny)*10,stroke:'#f6cd78','stroke-width':8,'stroke-linecap':'round'}));
    }
  }
}
function placeToken(el,pos,seat,instant=false){
  const center=posToXY(pos);const shift=(seat-1)*1.6;
  if(instant)el.style.transition='none';
  el.style.left=`${Math.max(2,Math.min(98,center.x+shift))}%`;
  el.style.top=`${center.y}%`;
  if(instant)el.getBoundingClientRect();
  if(instant)el.style.transition='';
}
function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
async function animateToken(el,seat,action,generation){
  animatingSeats.add(seat);
  const path=movementPath(action.from,action.landing,action.to);
  const reduce=window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || document.hidden;
  if(reduce){placeToken(el,action.to,seat,true);animatingSeats.delete(seat);return;}
  // Move along each numbered tile. The final snake/ladder leg glides as one smooth segment.
  for(let i=0;i<path.length;i++){
    if(animationGeneration!==generation||!el.isConnected)break;
    const leap=(i===path.length-1&&action.to!==action.landing);
    const ms=leap?620:175;
    el.style.setProperty('--token-step',ms+'ms');
    placeToken(el,path[i],seat);
    await sleep(ms+30);
  }
  if(animationGeneration===generation&&el.isConnected){
    placeToken(el,action.to,seat,true);
    el.dataset.pos=String(action.to);
  }
  animatingSeats.delete(seat);
}
function renderTokens(){
  if(!game)return;
  const layer=$('token-layer');if(!layer)return;
  const action=game.lastAction;
  const nextKey=action?`${game.roomId}:${action.seq}`:null;
  const change=nextKey!==lastAnimationKey;
  const shouldAnimate=Boolean(action&&change&&lastAnimationKey!==null);
  for(const [i,p] of game.players.entries()){
    let el=layer.querySelector(`[data-seat="${i}"]`);
    const existed=Boolean(el);
    if(!el){el=document.createElement('span');el.className='token';el.dataset.seat=String(i);layer.appendChild(el);}
    el.textContent=labelForAvatar(p.avatar);
    el.classList.toggle('active',game.status==='playing'&&game.current===i);
    el.title=`${p.name}: ช่อง ${p.pos}`;
    const isMover=shouldAnimate&&action.playerId===p.id&&existed;
    if(isMover){
      const generation=animationGeneration;
      // Never replace the element mid-animation or it will teleport.
      if(!animatingSeats.has(i))animateToken(el,i,action,generation);
    }else if(!animatingSeats.has(i)){
      placeToken(el,p.pos,i,true);el.dataset.pos=String(p.pos);
    }
  }
  for(const el of [...layer.querySelectorAll('.token')])if(Number(el.dataset.seat)>=game.players.length)el.remove();
  lastAnimationKey=nextKey||`${game.roomId}:initial`;
}
function renderPlayers(){
  $('players').innerHTML=game.players.map((p,i)=>{
    const active=game.status==='playing'&&game.current===i;
    const winner=game.winnerId===p.id;
    const connected=mode==='demo'||(game.connected||[]).includes(p.id);
    return `<div class="player-card ${active?'current':''} ${winner?'winner':''}"><div class="player-icon">${labelForAvatar(p.avatar)}<span class="online-dot" style="background:${connected?'#7bb77d':'#b8a5a2'}"></span></div><div class="player-data"><span class="player-name">${escapeText(p.name)} ${winner?'👑':''}</span><span class="player-position">ช่อง ${p.pos} ${p.shield?'🛡️':''} ${p.bonusPoints?`🎁+${p.bonusPoints.toLocaleString('th-TH')}`:''}</span></div></div>`;
  }).join('')+Array.from({length:3-game.players.length},()=>'<div class="player-card"><span class="player-icon">❔</span><div class="player-data"><span class="player-name">กำลังจับคู่…</span><span class="player-position">รอผู้เล่น</span></div></div>').join('');
}
function render(){
  if(!game)return;
  renderPlayers();renderBoard();
  const nowPlayer=game.players[game.current];
  const over=game.status==='finished',yourTurn=game.status==='playing'&&nowPlayer?.id===me;
  $('current-player').textContent=over?`🏆 ${game.players.find(p=>p.id===game.winnerId)?.name||'ผู้ชนะ'}`:game.status==='waiting'?'รอผู้เล่นครบ 3 คน':`${labelForAvatar(nowPlayer.avatar)} ${nowPlayer.name}`;
  $('roll-btn').disabled=!yourTurn||rollPending;
  $('roll-btn').textContent=over?'🏆 จบเกมแล้ว':yourTurn?'🎲 ทอยลูกเต๋า':'⏳ รอตาของคุณ';
  $('dice').textContent=game.lastRoll?DICE[game.lastRoll-1]:'🎲';
  $('roll-value').textContent=game.lastRoll?`ทอยได้ ${game.lastRoll} แต้ม • เดิน ${game.lastMove||game.lastRoll} ช่อง`:'ยังไม่ได้ทอย';
  const own=game.players.find(p=>p.id===me);
  const power=[own?.rewardX2?'🏆 รางวัลชนะ ×2 (+20 คะแนน)':null,own?.shield?`🛡️ กันงู ${own.shield} ครั้ง`:null].filter(Boolean).join(' • ');
  $('power-status').textContent=power?`🛍️ ไอเทม: ${power}`:'🛍️ ไอเทม: ไม่มี';
  $('events').innerHTML=game.log.map(t=>`<div class="event">${escapeText(t)}</div>`).join('');
  $('room-label').textContent=mode==='demo'?'🤖 ห้องทดลอง':`🌐 ${game.roomId?.slice(-8)||'ห้องออนไลน์'}`;
  $('turn-hint').textContent=over?'กดโหมดทดลองเพื่อเริ่มเกมใหม่ หรือจับคู่ห้องออนไลน์ใหม่':game.status==='waiting'?'ต้องมีผู้เล่นครบ 3 คนจึงจะเริ่มเกม':'ถ้าไม่ทอยภายใน 20 วินาที จะข้ามตาโดยไม่ทอยให้อัตโนมัติ';
  renderClock();
}
function renderClock(){
  if(!game)return;
  const remaining=game.status==='playing'?Math.max(0,game.turnEndsAt-(Date.now()+clockOffset)):TURN_MS;
  const sec=Math.ceil(remaining/1000);
  $('timer').textContent=game.status==='finished'?'✓':String(sec);
  $('time-fill').style.width=`${Math.min(100,remaining/TURN_MS*100)}%`;
  $('timer').parentElement.classList.toggle('urgent',game.status==='playing'&&sec<=5);
  if(mode==='demo'&&game.status==='playing'&&remaining===0){
    game.log=[`⌛ ${game.players[game.current].name} หมดเวลา — ข้ามตาโดยไม่ทอย`,...game.log].slice(0,5);
    game.lastRoll=0;game.lastMove=0;advance(game);render();scheduleBot();
  }
}
function scheduleBot(){
  if(mode!=='demo'||game.status!=='playing'||game.players[game.current].id===me)return;
  const turn=game.current;
  putDemoTimer(()=>{if(mode==='demo'&&game.status==='playing'&&game.current===turn){executeDemoRoll();}},750+randomInt(900));
}
function executeDemoRoll(){
  if(game.status!=='playing')return;
  const acting=game.players[game.current];
  const dice=randomInt(6)+1;
  const result=executeRoll(game,game.current,dice);
  if(result.reward!==null){
    if(acting.id===me){
      demoScore+=result.reward;
      store.setItem('paperRaceDemoScore',String(demoScore));updateLobby();
      showModal('🎁 เปิด Lucky Box สำเร็จ!',`คุณได้รับรางวัล +${result.reward.toLocaleString('th-TH')} คะแนน!\nคะแนนนี้เพิ่มในตารางอันดับทดลองแล้ว\n\nโอกาสของรางวัลแต่ละระดับดูได้ที่ตาราง Lucky Box`, '🎉');
    }else notice(`🎁 ${acting.name} เปิดกล่อง ได้ ${result.reward.toLocaleString('th-TH')} คะแนน`);
    renderLeaderboard();
  }
  $('dice').classList.add('shaking');setTimeout(()=>$('dice').classList.remove('shaking'),500);
  if(game.status==='finished'){
    if(game.winnerId===me){demoScore+=result.winPoints;store.setItem('paperRaceDemoScore',String(demoScore));updateLobby();}
    notice(`🏆 ${acting.name} ชนะเกม รับ ${result.winPoints} คะแนน!`);
    renderLeaderboard();
  }else advance(game);
  render();scheduleBot();
}
function startDemo(){
  if(socket){socket.close();socket=null;}
  clearDemoTimers();waiting=false;rollPending=false;clockOffset=0;
  animationGeneration++;lastAnimationKey=null;animatingSeats.clear();$('board').dataset.roomKey='';
  mode='demo';me=humanId;game=createGame('demo');
  const pool=[...Array(AVATARS.length).keys()].filter(i=>i!==selectedAvatar);
  const a=pool.splice(randomInt(pool.length),1)[0],b=pool.splice(randomInt(pool.length),1)[0];
  game.players=[{id:me,name:playerName(),avatar:selectedAvatar,pos:0,shield:itemActive('shield')?1:0,rewardX2:itemActive('dice'),stars:0},
    {id:'bot-one',name:'น้องโมจิ',avatar:a,pos:0,shield:0,stars:0},
    {id:'bot-two',name:'น้องปุย',avatar:b,pos:0,shield:0,stars:0}];
  game.status='playing';game.current=0;game.turnEndsAt=Date.now()+TURN_MS;
  game.log=['เริ่มเกมทดลอง! คุณแข่งกับบอทอีก 2 คน'];
  $('demo-btn').classList.add('active');$('online-btn').classList.remove('active');
  $('mode-status').textContent='🟢 เกมทดลองเริ่มแล้ว — คุณเป็นผู้เล่นคนแรก';$('score-mode').textContent='คะแนนทดลอง';
  showScreen('game');render();renderLeaderboard();
}
async function startOnline(){
  if(!googleUser){showModal('กรุณาเข้าสู่ระบบก่อน','เลือกปุ่มเข้าสู่ระบบด้วย Google เพื่อเล่นออนไลน์ ระบบทดลองกับบอทยังเล่นได้โดยไม่ต้องล็อกอิน','🔐');return;}
  if(nicknameLoading||!savedNickname){showModal('กรุณาตั้งชื่อผู้เล่น','กลับไปหน้าเข้าสู่เกม ตั้งชื่อ และกดบันทึกก่อนจับคู่ออนไลน์','✏️');return;}
  if(waiting)return;
  if(!backendReady){notice('โหมดออนไลน์ต้องเปิดผ่าน Cloudflare Worker ที่ Deploy แล้ว');return;}
  clearDemoTimers();if(socket)socket.close();socket=null;
  mode='online';waiting=true;rollPending=false;me=googleUser.uid;
  $('demo-btn').classList.remove('active');$('online-btn').classList.add('active');
  $('mode-status').textContent='🟡 กำลังหาห้องที่มีผู้เล่นไม่เกิน 3 คน…';
  try{
    const res=await authorizedFetch('/api/match',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:playerName(),avatar:selectedAvatar,server:selectedServer})});
    const data=await res.json();if(!res.ok)throw Error(data.error||'จับคู่ไม่สำเร็จ');
    $('mode-status').textContent=`🟢 จองช่องที่ ${data.seat}/3 สำเร็จ — กำลังรอคนเข้าห้อง`;
    socket=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/ws?room=${encodeURIComponent(data.room)}&ticket=${encodeURIComponent(data.ticket)}`);
    const roomSocket=socket;
    socket.onmessage=e=>{
      if(socket!==roomSocket)return;
      let m;try{m=JSON.parse(e.data);}catch{return;}
      if(m.type==='state'){
        game={...m.state,connected:m.connected};clockOffset=m.serverTime-Date.now();
        waiting=game.status==='waiting';rollPending=false;
        if(game.status==='abandoned'){
          const inactivity=game.closeReason==='no_rolls_3_turns';
          const message=inactivity
            ?'🚪 ห้องปิดอัตโนมัติ เพราะไม่มีผู้เล่นทอยลูกเต๋าติดต่อกันครบ 3 เทิร์น (ประมาณ 60 วินาที)'
            :'⌛ ห้องรอผู้เล่นไม่ครบภายในเวลาที่กำหนด';
          waiting=false;rollPending=false;
          showScreen('lobby');
          $('mode-status').textContent=message+' • กดจับคู่เพื่อเริ่มห้องใหม่';
          showModal('ห้องแข่งขันถูกปิดแล้ว',message+'\nคุณสามารถกดจับคู่ห้องใหม่ได้ทันที','🚪');
          if(roomSocket.readyState===WebSocket.OPEN)roomSocket.close(1000,'Room expired');
          return;
        }
        $('mode-status').textContent=game.status==='waiting'?`🟡 รออีก ${Math.max(0,3-(game.connected||[]).length)} คน เพื่อเริ่มเกม`:game.status==='finished'?'🏆 เกมจบแล้ว กดจับคู่อีกครั้งเพื่อเล่นใหม่':'🟢 เชื่อมต่อห้องออนไลน์สำเร็จ';
        // Enter the board only after GameRoom has confirmed all three players.
        if((game.status==='playing'||game.status==='finished')&&view!=='game')showScreen('game');
        render();renderLeaderboard();
      }else if(m.type==='error')notice(m.error);
    };
    socket.onclose=e=>{
      if(mode!=='online'||socket!==roomSocket)return;
      waiting=false;rollPending=false;
      if(game?.status==='abandoned'||e.code===4003){
        const message=game?.closeReason==='no_rolls_3_turns'
          ?'🚪 ห้องปิดแล้ว: ไม่มีผู้เล่นทอยครบ 3 เทิร์น'
          :'🚪 ห้องถูกปิดอัตโนมัติ กรุณาจับคู่ใหม่';
        $('mode-status').textContent=message;
        if(view==='game')showScreen('lobby');
        $('mode-status').textContent=message;
      }else{
        $('mode-status').textContent='🔴 การเชื่อมต่อหลุด — กดจับคู่อีกครั้ง';
        if(game)render();
      }
    };
    socket.onerror=()=>{if(mode==='online'&&socket===roomSocket)notice('เชื่อมต่อห้องไม่ได้ กรุณาลองใหม่');};
  }catch(err){waiting=false;$('mode-status').textContent=`🔴 ${err.message}`;notice(err.message);}
}
function renderLuckyTables(){
  const html=LUCKY_PRIZES.map(p=>`<div class="lucky-prize-row"><span>🪙 ${p.points.toLocaleString('th-TH')} คะแนน</span><strong>${p.chance}</strong></div>`).join('');
  for(const id of ['lucky-prizes-lobby','lucky-prizes-game'])if($(id))$(id).innerHTML=html;
}
function renderAvatarPicker(){
  $('avatars').innerHTML=AVATARS.map((a,i)=>`<button class="avatar-button ${selectedAvatar===i?'selected':''}" data-avatar="${i}" aria-pressed="${selectedAvatar===i}"><span class="avatar-emoji">${a.emoji}</span><span class="avatar-text">${a.name}</span></button>`).join('');
  $('avatars').querySelectorAll('button').forEach(btn=>btn.addEventListener('click',()=>{
    selectedAvatar=Number(btn.dataset.avatar);renderAvatarPicker();
    if(mode==='demo'&&game?.status==='playing'){
      game.players[0].avatar=selectedAvatar;renderPlayers();renderTokens();
    }
  }));
}
async function renderLeaderboard(){
  if(mode==='demo'&&!googleUser){
    $('score-mode').textContent='คะแนนทดลอง';
    $('score-disclaimer').textContent='คะแนนทดลองเก็บในเบราว์เซอร์นี้ ไม่รวมในตารางอันดับออนไลน์';
    $('lucky-footnote').textContent='โอกาสรวม 100% • รางวัล Lucky Box ในโหมดบอทเป็นคะแนนทดลองเท่านั้น';
    $('leaderboard').innerHTML=`<div class="score-row">🥇 ${labelForAvatar(selectedAvatar)} คุณ (ทดลอง) <b>${demoScore} คะแนน</b></div>`;
    return;
  }
  $('score-disclaimer').textContent='คะแนนแข่งขันออนไลน์บันทึกบนเซิร์ฟเวอร์ • คะแนนจากเกมทดลองกับบอทไม่รวมในอันดับนี้';
  $('lucky-footnote').textContent='โอกาสรวม 100% • Lucky Box ในห้องออนไลน์บันทึกคะแนนบนเซิร์ฟเวอร์ และไม่ถูกคูณด้วยไอเทม ×2';
  $('score-mode').textContent=`คะแนนออนไลน์ (${selectedServer.toUpperCase()})`;
  try{
    const result=await fetch('/api/leaderboard?server='+selectedServer);const {leaders=[]}=await result.json();
    $('leaderboard').innerHTML=leaders.length?leaders.slice(0,12).map((p,i)=>`<div class="score-row">${['🥇','🥈','🥉'][i]||'#'+(i+1)} ${labelForAvatar(p.avatar)} ${escapeText(p.name)} <b>${p.score} คะแนน</b></div>`).join(''):'<div class="event">ยังไม่มีผู้ชนะในระบบออนไลน์</div>';
  }catch{$('leaderboard').textContent='โหลดตารางอันดับไม่ได้';}
}
async function authorizedFetch(path,options={}){
  if(!authClient||!googleUser)throw Error('กรุณาล็อกอิน Google');
  const token=await authClient.idToken();
  const headers=new Headers(options.headers||{});headers.set('Authorization',`Bearer ${token}`);
  return fetch(path,{...options,headers,cache:'no-store'});
}
async function initializeOnlineServices(){
  const r=await fetch('/api/config',{cache:'no-store'});if(!r.ok)return;
  publicConfig=await r.json();
  if(!publicConfig.firebase){$('auth-status').textContent='🔒 ยังไม่ตั้งค่า Firebase สำหรับเกมใหม่นี้';return;}
  try{
    authClient=await import('./auth.js');
    await authClient.initialize(publicConfig.firebase,async u=>{
      googleUser=u;
      $('google-btn').textContent=u?`✅ ${u.email||'Google'} • ออกจากระบบ`:'G เข้าสู่ระบบด้วย Google';
      $('auth-status').textContent=u?'✅ เข้าสู่ระบบ Google สำเร็จ':'🔐 กรุณาเข้าสู่ระบบด้วย Google เพื่อเล่นออนไลน์';
      if(u){
        const uid=u.uid;
        nicknameLoading=true;$('nickname').readOnly=true;updateNicknameControls();
        try{
          const r=await authorizedFetch('/api/me');
          if(!r.ok)throw Error('โหลดข้อมูลโปรไฟล์ไม่สำเร็จ');
          const profile=await r.json();
          if(googleUser?.uid!==uid)return;
          serverMe=profile;applySavedNickname(profile.nickname);
        }catch{
          if(googleUser?.uid!==uid)return;
          serverMe=null;nicknameLoading=true;updateNicknameControls();
          $('auth-status').textContent='⚠️ โหลดชื่อบัญชีไม่สำเร็จ กรุณารีเฟรชเกม';
        }
      }else{
        serverMe=null;
        applySavedNickname(store.getItem('snlGuestNickname')||'');
      }
      if(view==='lobby'){updateLobby();renderLeaderboard();}
    });
  }catch(e){$('auth-status').textContent='⚠️ โหลด Google Login ไม่สำเร็จ กรุณาลองอีกครั้ง';console.warn('Firebase client initialization failed');}
  $('payment-availability').textContent=publicConfig.paymentsEnabled?'🧾 เปิดชำระเงินผ่านสลิป (ตรวจสอบจริง)':'🔒 ยังไม่เปิดรับชำระเงินจริง';
  for(const btn of document.querySelectorAll('[data-buy]'))btn.disabled=!publicConfig.paymentsEnabled;
}
async function buyProduct(sku){
  if(!publicConfig?.paymentsEnabled){showModal('ยังไม่เปิดรับชำระเงินจริง','ระบบต้องตั้งค่า Slip2Go และบัญชีรับเงินที่ตรวจสอบแล้วก่อน','🔒');return;}
  if(!googleUser){showModal('ต้องล็อกอินก่อนซื้อ','โปรดเข้าสู่ระบบด้วย Google แล้วกลับมาที่ร้านค้าอีกครั้ง','🔐');return;}
  const panel=$('payment-panel');panel.hidden=false;
  panel.dataset.order='';
  $('payment-reconcile').hidden=true;
  $('payment-progress').textContent='กำลังสร้างคำสั่งซื้อ…';
  try{
    const response=await authorizedFetch('/api/orders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sku})});
    const data=await response.json();if(!response.ok)throw Error(data.error||'สร้างคำสั่งซื้อไม่สำเร็จ');
    const o=data.order;
    $('payment-order').textContent=o.id;
    $('payment-amount').textContent=String(o.amount)+' บาท';
    $('payment-recipient').textContent=`${publicConfig.merchant?.name||'ยังไม่ระบุ'} • ${publicConfig.merchant?.account||'ยังไม่ระบุบัญชี'}`;
    $('payment-progress').textContent='โอนตามยอดที่แจ้งภายใน 15 นาที แล้วส่งรูปสลิปเพื่อตรวจสอบ';
    panel.dataset.order=o.id;
    $('payment-reconcile').hidden=false;
  }catch(e){$('payment-progress').textContent='❌ '+e.message;}
  panel.scrollIntoView({behavior:'smooth',block:'center'});
}
async function submitSlip(){
  const panel=$('payment-panel'),id=panel.dataset.order,file=$('payment-slip').files?.[0];
  if(!id||!file){$('payment-progress').textContent='กรุณาเลือกรูปสลิป';return;}
  if(!['image/png','image/jpeg'].includes(file.type)||file.size>4_000_000){$('payment-progress').textContent='ต้องเป็นภาพ JPG/PNG ขนาดไม่เกิน 4MB';return;}
  $('payment-submit').disabled=true;$('payment-progress').textContent='กำลังตรวจสอบสลิปกับ Slip2Go…';
  try{
    const form=new FormData();form.append('slip',file);
    const response=await authorizedFetch(`/api/orders/${encodeURIComponent(id)}/verify`,{method:'POST',body:form});
    const data=await response.json();
    if(!response.ok){
      if(data?.status==='verified_not_fulfilled'){
        $('payment-progress').textContent='⚠️ ตรวจสลิปผ่านแล้ว แต่ยังรอเปิดสิทธิ์ ห้ามโอนซ้ำ กดตรวจสถานะสิทธิ์ได้';
        $('payment-reconcile').hidden=false;
        return;
      }
      throw Error(data.error||'ตรวจสอบไม่สำเร็จ');
    }
    $('payment-progress').textContent='✅ ตรวจสลิปสำเร็จและเปิดสิทธิ์แล้ว';
    const meResponse=await authorizedFetch('/api/me');if(meResponse.ok)serverMe=await meResponse.json();
    updateShopUI();
  }catch(e){$('payment-progress').textContent='⚠️ '+e.message+' • หากธนาคารหักเงินจริงแล้ว อย่าโอนซ้ำ ให้ติดต่อผู้ดูแลพร้อมหมายเลขคำสั่งซื้อ';}
  finally{$('payment-submit').disabled=false;}
}
async function reconcilePayment(){
  const panel=$('payment-panel'),id=panel.dataset.order;
  if(!id||!googleUser){$('payment-progress').textContent='กรุณาเข้าสู่ระบบและสร้างคำสั่งซื้อก่อน';return;}
  $('payment-reconcile').disabled=true;
  try{
    $('payment-progress').textContent='กำลังตรวจสถานะสิทธิ์จากเซิร์ฟเวอร์ โดยไม่ตรวจสลิปซ้ำ…';
    const response=await authorizedFetch(`/api/orders/${encodeURIComponent(id)}/reconcile`,{method:'POST'});
    const data=await response.json();
    if(!response.ok){
      $('payment-progress').textContent=data?.status==='verified_not_fulfilled'
        ?'⚠️ ชำระเงินตรวจผ่านแล้ว แต่สิทธิ์ยังไม่เปิด ติดต่อผู้ดูแลพร้อมหมายเลขคำสั่งซื้อ ห้ามโอนซ้ำ'
        :'⚠️ '+(data.error||'ยังไม่สามารถยืนยันการเปิดสิทธิ์ได้')+' • หากโอนแล้วอย่าโอนซ้ำ';
      return;
    }
    $('payment-progress').textContent='✅ ตรวจสถานะสำเร็จ สิทธิ์ถูกเปิดแล้ว';
    const meResponse=await authorizedFetch('/api/me');
    if(meResponse.ok)serverMe=await meResponse.json();
    updateShopUI();
  }catch(e){
    $('payment-progress').textContent='⚠️ ตรวจสถานะไม่สำเร็จ '+(e.message||'')+' โปรดลองใหม่ อย่าโอนซ้ำ';
  }finally{$('payment-reconcile').disabled=false;}
}
async function detectServer(){
  if(location.protocol==='file:')return;
  try{const ctrl=new AbortController();const t=setTimeout(()=>ctrl.abort(),2500);const r=await fetch('/api/health',{cache:'no-store',signal:ctrl.signal});clearTimeout(t);backendReady=r.ok&&((await r.json()).ok===true);
    if(backendReady){await initializeOnlineServices();const cap=await fetch('/api/vip/capacity',{cache:'no-store'});if(cap.ok){const v=await cap.json();const el=$('vip-capacity');if(el)el.textContent=`สมาชิก ${v.active}/${v.limit} คน • คงเหลือ ${v.available} ที่`;}}}catch{backendReady=false;}
}
$('roll-btn').addEventListener('click',()=>{
  if(!game||game.status!=='playing'||game.players[game.current]?.id!==me)return;
  if(mode==='demo')executeDemoRoll();
  else if(socket?.readyState===WebSocket.OPEN&&!rollPending){rollPending=true;socket.send(JSON.stringify({type:'roll'}));$('roll-btn').disabled=true;}
});
$('demo-btn').addEventListener('click',()=>startDemo());
$('online-btn').addEventListener('click',()=>{if(mode==='online'&&waiting)return;startOnline();});
$('nickname-action').addEventListener('click',async()=>{
  if(nicknameLoading||nicknameSaving)return;
  if($('nickname').readOnly){
    $('nickname').readOnly=false;updateNicknameControls();$('nickname').focus();$('nickname').select();
  }else await saveNickname();
});
$('nickname').addEventListener('keydown',event=>{
  if(event.key==='Enter'&&!$('nickname').readOnly){event.preventDefault();saveNickname();}
});
setInterval(renderClock,180);
$('server-free').addEventListener('click',()=>chooseServer('free'));
$('server-vip').addEventListener('click',()=>chooseServer('vip'));
$('enter-btn').addEventListener('click',async()=>{
 if(nicknameLoading){showModal('กำลังโหลดชื่อ','กรุณาลองอีกครั้งหลังโหลดบัญชี Google เสร็จ','⏳');return;}
 if(!$('nickname').readOnly && !await saveNickname())return;
 if(!savedNickname){showModal('กรุณาตั้งชื่อผู้เล่น','ใส่ชื่อแล้วกดบันทึกก่อนเข้าเกม','✏️');return;}
 if(selectedServer==='vip'){
   if(!googleUser){showModal('VIP ต้องล็อกอิน','โปรดเข้าสู่ระบบด้วย Google ก่อนสมัคร VIP','👑');return;}
   try{const r=await authorizedFetch('/api/me');const p=await r.json();if(!r.ok)throw Error(p.error);serverMe=p;
      if(!p.vip){showModal('ยังไม่มีสิทธิ์ VIP','เข้าหน้า Lobby เพื่อดู VIP และกดสมัครได้ แต่ยังจับคู่ห้อง VIP ไม่ได้จนกว่าจะตรวจชำระเงินสำเร็จ','👑');}
   }catch(e){showModal('ตรวจสอบ VIP ไม่สำเร็จ',e.message,'⚠️');return;}
 }
 showScreen('lobby');
});
$('google-btn').addEventListener('click',async()=>{
 if(!authClient){showModal('Google Login ยังไม่พร้อม','ต้องเปิด Google Sign-in ที่ Firebase แล้วตั้งค่า FIREBASE_PROJECT_ID, FIREBASE_API_KEY, FIREBASE_AUTH_DOMAIN, FIREBASE_APP_ID ที่ Cloudflare ก่อน','🔐');return;}
 try{if(googleUser){await authClient.logOut();return;}await authClient.signIn();}
 catch(e){showModal('เข้าสู่ระบบไม่สำเร็จ',String(e.code||e.message),'⚠️');}
});
$('menu-btn').addEventListener('click',openMenu);
$('game-menu').addEventListener('click',openMenu);
$('close-menu').addEventListener('click',closeMenu);
$('menu-backdrop').addEventListener('click',closeMenu);
$('side-menu').querySelectorAll('[data-nav]').forEach(btn=>btn.addEventListener('click',()=>navigateTo(btn.dataset.nav)));
$('modal-x').addEventListener('click',closeModal);
$('modal-close').addEventListener('click',closeModal);
$('modal-backdrop').addEventListener('click',event=>{if(event.target===$('modal-backdrop'))closeModal();});
$('back-lobby').addEventListener('click',()=>navigateTo('lobby'));
$('replay-btn').addEventListener('click',startDemo);
for(const item of ['dice','shield'])$(item==='dice'?'trial-dice':'trial-shield').addEventListener('click',()=>{
 if(itemActive(item))return;
 store.setItem(ITEM_KEYS[item],String(Date.now()+DAY_MS));updateShopUI();
 showModal('ไอเทมทดลองเปิดใช้งานแล้ว',`${item==='dice'?'รางวัลชนะ ×2':'เกราะกันงู'} ใช้ทดลองได้ 24 ชั่วโมงในโหมดบอทเท่านั้น\n${item==='dice'?'ได้รับคะแนนชนะเกมเป็น 20 คะแนน จากปกติ 10 คะแนน (ไม่คูณคะแนน Lucky Box และไม่เพิ่มจำนวนช่องเดิน)':'เริ่มเกมใหม่แต่ละรอบจะป้องกันงูได้ 1 ครั้ง'}\nไม่มีการชำระเงินจริง`,'🎁');
});
for(const btn of document.querySelectorAll('[data-buy]'))btn.addEventListener('click',()=>buyProduct(btn.dataset.buy));
$('payment-submit').addEventListener('click',submitSlip);
$('payment-reconcile').addEventListener('click',reconcilePayment);
$('payment-close').addEventListener('click',()=>{$('payment-panel').hidden=true;});
renderAvatarPicker();renderLuckyTables();updateShopUI();applySavedNickname(store.getItem('snlGuestNickname')||'');chooseServer('free');showScreen('auth');detectServer();
