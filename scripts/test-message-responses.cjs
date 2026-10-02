const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
let listener,fail=false;
const event={addListener(){}};
const chrome={storage:{session:{async get(){if(fail)throw new Error('Storage unavailable');return {}},
  async set(){},async remove(){if(fail)throw new Error('Storage unavailable')}}},
  action:{async setBadgeText(){},setBadgeBackgroundColor(){}},
  tabs:{onUpdated:event,onRemoved:event},webRequest:{onHeadersReceived:event},
  runtime:{onMessage:{addListener(fn){listener=fn}}},downloads:{async download(){throw new Error('Download rejected')}}};
const context=vm.createContext({chrome,URL,atob,console,importScripts(){}});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../background.js'),'utf8'),context);
async function request(cmd,tabId){
  let timer;
  try{return await Promise.race([new Promise(resolve=>assert.equal(listener({cmd,tabId},{},resolve),true)),
    new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Listener did not reply')),500)})]);}
  finally{clearTimeout(timer)}
}
(async()=>{
  for(const cmd of ['unknown','scanner.dom','youtube.tracks'])assert.equal(listener({cmd},{},()=>assert.fail('Wrong listener replied')),undefined);
  assert.equal((await request('list',1)).length,0);
  fail=true;
  for(const cmd of ['list','clear']){
    const result=await request(cmd,2);assert.equal(result.ok,false);assert.equal(result.error,'Storage unavailable');
  }
  const download=await request('download',2);assert.equal(download.ok,false);assert.match(download.error,/Download rejected/);
  console.log('Passed: unknown commands do not open channels; list/clear/download failures always reply with errors.');
})().catch(error=>{console.error(error);process.exitCode=1});
