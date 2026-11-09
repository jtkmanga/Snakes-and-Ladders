import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const file=p=>fileURLToPath(new URL(p,import.meta.url));
const game=readFileSync(file('./staging-game-v87.mjs'),'utf8');
const html=readFileSync(file('./game-index-v87.html'),'utf8');
const css=readFileSync(file('./game-style-v87.css'),'utf8');

test('browser JS parses and checkout controls are unchanged',()=>{
 const run=spawnSync(process.execPath,['--check',file('./staging-game-v87.mjs')],{encoding:'utf8'});
 assert.equal(run.status,0,run.stderr);
 assert.ok(html.includes('game.js?v=avatar-names-v87'));
 assert.ok(html.includes('style.css?v=avatar-names-v87'));
 assert.ok(html.includes('id="vip-buy"'));
 assert.ok(!html.includes('id="payment-restore"'));
 assert.ok(!html.includes('menu-admin-link'));
});

test('names are safe text, nested inside moving tokens and updated without HTML injection',()=>{
 const start=game.indexOf('function renderTokens(){'),end=game.indexOf('function renderPlayers(){',start);
 assert.ok(start>=0&&end>start);
 const code=game.slice(start,end);
 assert.ok(code.includes("const nameplate=document.createElement('span');nameplate.className='token-name'"));
 assert.ok(code.includes("const playerName=String(p.name||'ผู้เล่น')"));
 assert.ok(code.includes('nameplate.textContent=playerName'));
 assert.ok(code.includes('nameplate.title=playerName'));
 assert.ok(code.includes('el.append(emoji,nameplate)'));
 assert.ok(code.includes("el.querySelector('.token-emoji').textContent=labelForAvatar(p.avatar)"));
 assert.ok(!code.includes('innerHTML='));
 assert.ok(!code.includes('el.textContent='));
 assert.ok(code.includes('animateToken(el,i,action,generation)'));
 assert.ok(code.includes('nameRank*17'));
});

test('nameplates do not intercept touch input and handle top/left/right edges',()=>{
 const start=game.indexOf('function placeToken('),end=game.indexOf('function sleep(',start);
 const code=game.slice(start,end);
 assert.ok(code.includes("el.classList.toggle('name-below',center.y<10)"));
 assert.ok(code.includes("el.classList.toggle('name-edge-left',center.x<15)"));
 assert.ok(code.includes("el.classList.toggle('name-edge-right',center.x>85)"));
 for(const className of ['.token .token-name{','.token.active .token-name','.token.name-below .token-name','.token.name-edge-left .token-name','.token.name-edge-right .token-name'])
  assert.ok(css.includes(className));
 assert.ok(css.includes('pointer-events:none'));
 assert.ok(css.includes('max-width:min(72px,22vw)'));
});

test('name updates preserve the same token DOM node and never interpret player HTML',()=>{
 const start=game.indexOf('function renderTokens(){'),end=game.indexOf('function renderPlayers(){',start);
 const code=game.slice(start,end);
 class Element{
  constructor(tag='span'){
   this.tag=tag;this.children=[];this.dataset={};this.style={properties:{},setProperty(k,v){this.properties[k]=v;}};
   this.classes=new Set();this.classList={toggle:(name,on)=>on?this.classes.add(name):this.classes.delete(name)};this.isConnected=true;
  }
  append(...children){this.children.push(...children);}
  appendChild(child){this.children.push(child);return child;}
  querySelector(selector){
   const match=/^\[data-seat="(\d+)"\]$/.exec(selector);
   if(match)return this.children.find(e=>e.dataset.seat===match[1])||null;
   return this.children.find(c=>c.className===selector.slice(1))||null;
  }
  querySelectorAll(selector){return selector==='.token'?this.children:[];}
  remove(){}
 }
 const layer=new Element('div'),document={createElement:tag=>new Element(tag)};
 const state={roomId:'test-room',status:'playing',current:0,players:[
  {id:'alice',name:'Alice <img src=x onerror=alert(1)>',avatar:0,pos:10},
  {id:'bob',name:'บ๊อบ',avatar:1,pos:10}
 ],lastAction:null};
 const render=new Function('document','$','game','labelForAvatar','placeToken','animateToken','animatingSeats','animationGeneration','lastAnimationKey',code+'\nreturn renderTokens();');
 const call=()=>render(document,()=>layer,state,i=>['🐱','🐰'][i],()=>{},()=>{},new Set(),0,null);
 call();
 assert.equal(layer.children.length,2);
 const first=layer.children[0];
 assert.equal(first.querySelector('.token-name').textContent,state.players[0].name);
 assert.equal(first.querySelector('.token-emoji').textContent,'🐱');
 assert.equal(layer.children[1].style.properties['--name-offset'],'17px');
 state.players[0].name='ชื่อใหม่';
 call();
 assert.strictEqual(layer.children[0],first);
 assert.equal(first.querySelector('.token-name').textContent,'ชื่อใหม่');
});
