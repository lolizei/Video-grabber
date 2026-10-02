const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const stored={},listeners={};let resources=[],scanError=false,created,metadata;
const event=name=>({addListener(fn){(listeners[name]??=[]).push(fn)}});
const chrome={
  storage:{session:{async get(key){return {[key]:stored[key]}},async set(values){Object.assign(stored,structuredClone(values))},async remove(key){delete stored[key]}}},
  action:{async setBadgeText(){},setBadgeBackgroundColor(){}},
  tabs:{async get(){return {id:5,url:'https://www.youtube.com/watch?v=test'}},async create(options){created=options;return {id:8}},onUpdated:event('updated'),onRemoved:event('removed')},
  webRequest:{onHeadersReceived:event('headers')},runtime:{getURL:path=>'chrome-extension://test/'+path,onMessage:event('message')},
  scripting:{async executeScript(options){
    if(scanError)throw new Error('Cannot access page');
    if(options.world==='MAIN'){
      const page=vm.createContext({URL,location:{href:'https://www.youtube.com/watch?v=test',pathname:'/watch'},
        window:{ytInitialPlayerResponse:metadata},document:{getElementById(){return null}}});
      return [{result:vm.runInContext('('+options.func.toString()+')()',page)}];
    }
    return [{result:{urls:resources,blobs:1,players:1}}];
  }}
};
const context=vm.createContext({chrome,URL,console,atob,crypto:require('node:crypto').webcrypto,importScripts(){}});
const run=file=>vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),context);
run('background.js');run('shared/youtube.js');run('background/youtube.js');
const request=msg=>new Promise(resolve=>{for(const fn of listeners.message)fn(msg,{},resolve)});
const direct='https://r1.googlevideo.com/videoplayback?itag=137&mime=video%2Fmp4&clen=4&range=0-3';
(async()=>{
  // Before Refresh no listener has captured the track. Recover only the page's existing request history.
  assert.equal(Object.keys(await vm.runInContext('getList(5)',context)).length,0);
  resources=[direct,'https://r1.googlevideo.com/videoplayback?itag=140&mime=audio%2Fmp4&clen=4'];
  let reply=await request({cmd:'youtube.tracks',tabId:5});
  assert(reply.ok);assert.equal(reply.result.items.length,2);assert.equal(reply.result.debug.resourceHits,2);
  assert(reply.result.items.every(item=>!item.url.includes('range=')));
  reply=await request({cmd:'youtube.start',tabId:5,output:'mp4',quality:'1080p'});
  assert(reply.ok);assert.equal(reply.result.workerTab,8);assert.equal(created.active,false);
  reply=await request({cmd:'youtube.unknown'});assert.equal(reply.ok,false);assert.match(reply.error,/Unknown/);
  // Clearing retains buffered tracks for Refresh, without replaying network requests.
  await request({cmd:'clear',tabId:5});resources=[];
  assert.equal((await request({cmd:'youtube.tracks',tabId:5})).result.items.length,2);
  await vm.runInContext('clearTab(5)',context);
  resources=[direct+'&ump=1',direct+'&sabr=1'];
  reply=await request({cmd:'youtube.tracks',tabId:5});
  assert.equal(reply.result.items.length,0);assert.equal(reply.result.debug.unsupportedResources,2);
  // POST/UMP observed by webRequest is diagnosed, never classified/replayed as a normal track.
  for(const listener of listeners.headers)listener({tabId:5,url:direct,method:'POST',statusCode:200,responseHeaders:[{name:'content-type',value:'application/vnd.yt-ump'}]});
  await vm.runInContext('YouTubeDownloads.status()',context);
  reply=await request({cmd:'youtube.tracks',tabId:5});assert.equal(reply.result.debug.unsupportedHits,1);
  // Zero network history: read only the current video's already-present direct player URLs.
  resources=[];
  metadata={videoDetails:{videoId:'test'},streamingData:{adaptiveFormats:[
    {url:direct,mimeType:'video/mp4',contentLength:'4',qualityLabel:'1080p'},
    {url:direct.replace('137','140').replace('video%2Fmp4','audio%2Fmp4'),mimeType:'audio/mp4',contentLength:'4'},
    {signatureCipher:'url=secret&s=cipher'},
    {url:direct.replace('137','399'),drmFamilies:['widevine']},
    {url:'https://untrusted.test/videoplayback?itag=18'},
    {url:direct+'&ump=1'}]}};
  reply=await request({cmd:'youtube.tracks',tabId:5});
  assert.equal(reply.result.items.length,2);assert.equal(reply.result.debug.metadataHits,2);assert.equal(reply.result.debug.metadataSkipped,2);
  await vm.runInContext('clearTab(5)',context);
  metadata.videoDetails.videoId='previous';
  reply=await request({cmd:'youtube.tracks',tabId:5});assert.equal(reply.result.items.length,0);assert.equal(reply.result.debug.metadataHits,0);
  metadata.videoDetails.videoId='test';metadata.streamingData.licenseInfos=[{}];
  reply=await request({cmd:'youtube.tracks',tabId:5});assert.equal(reply.result.items.length,0);assert.match(reply.result.debug.metadataError,/Protected/);
  metadata.streamingData={serverAbrStreamingUrl:'https://r1.googlevideo.com/videoplayback?sabr=1'};
  reply=await request({cmd:'youtube.tracks',tabId:5});assert.equal(reply.result.items.length,0);assert.equal(reply.result.debug.unsupportedMetadata,true);
  scanError=true;reply=await request({cmd:'youtube.tracks',tabId:5});assert.match(reply.result.debug.error,/Cannot access/);
  console.log('Passed: request-history/zero-history direct metadata recovery; cipher/DRM/stale-video entries skipped; UMP/SABR diagnosed without replay; page errors visible.');
})().catch(error=>{console.error(error);process.exitCode=1});
