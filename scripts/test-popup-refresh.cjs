// Reproduce the polling race using the actual popup controller and delayed baseline results.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const elements = new Map();
const element = () => ({ hidden:false, textContent:'', children:[], dataset:{},
  classList:{toggle(){},add(){}}, setAttribute(){}, querySelectorAll(){return []},
  replaceChildren(){this.children=[]}, append(...children){this.children.push(...children)} });
const document = { hidden:false, querySelector(selector){
  if(!elements.has(selector))elements.set(selector,element());return elements.get(selector);
},createElement:element };
let poll, finish, refreshCount=0;
const context = { document, URL, console, CFG:{enableYouTube:true},
  chrome:{tabs:{async query(){return[{id:8,url:'https://example.test/page'}]}},
    runtime:{sendMessage(msg){
      if(msg.cmd==='scanner.refresh'){refreshCount++;return new Promise(resolve=>finish=resolve);}
      return Promise.resolve({ok:true,result:{items:[],jobs:[]}});
    }}}, window:{dispatchEvent(){},addEventListener(){}}, Event:class{}, setInterval(fn){poll=fn},navigator:{} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../ui/media-tab.js'),'utf8'),context);
document.querySelector('#media-tab').onclick();
(async()=>{
  await new Promise(resolve=>setImmediate(resolve));
  poll();poll(); // Ordinary polls must not invalidate a pending Refresh.
  const items=['audio','video'].map(type=>({url:'https://cdn.test/'+type,type,kind:type,filename:type==='audio'?'tone.mp3':'video.mp4',domain:'cdn.test',size:100}));
  finish({ok:true,result:{items,jobs:[],debug:{networkHits:0,domHits:2}}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(document.querySelector('#media-list').children.length,2);
  assert.equal(refreshCount,1);
  assert.match(document.querySelector('#media-summary').textContent,/2 items/);
  console.log('Passed: slow MP3/MP4 baseline Refresh survives repeated polling.');
})().catch(error=>{console.error(error);process.exitCode=1});
