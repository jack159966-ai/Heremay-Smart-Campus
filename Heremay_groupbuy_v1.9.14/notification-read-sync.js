/* Confirm notification reads only after the corresponding content has loaded. */
(() => {
 const prefix='heremay.notificationRead.v1.';
 const service='https://script.google.com/macros/s/AKfycbwhJsU-5QiZ3uDd9UCnECd16jpHG_LoweHRIC7TrSf_AH-bDLPUFVeAGB2urQo25zzoVg/exec';
 const read=(key,fallback)=>{try{return JSON.parse(localStorage.getItem(key))||fallback}catch(_){return fallback}};
 const save=(key,value)=>{try{localStorage.setItem(key,JSON.stringify(value))}catch(_){}};
 const userKey=user=>prefix+JSON.stringify([String(user.employeeId||user.userId||''),String(user.name||user.userName||'')]);
 function target(item){
  let url;try{url=new URL(item.link||'',location.href)}catch(_){return ''}
  if(!item.link)return '';
  if(url.origin!==location.origin)return '';
  const file=url.pathname.split('/').pop().toLowerCase(),p=url.searchParams;
  if(file==='discussion.html'){const id=p.get('roomId')||item.roomId;return id?'discussion:'+id:''}
  if(file==='groupbuy.html'){const id=p.get('campaignId')||p.get('id')||item.campaignId;return id?'groupbuy:'+id:''}
  if(file==='private_message.html'){const id=p.get('peerId')||item.peerId;return id?'private:'+id:''}
  return '';
 }
 function sameUser(a,b){
  const aid=String(a.employeeId||a.userId||'').trim(),bid=String(b.employeeId||b.userId||'').trim();
  if(aid&&bid)return aid===bid;
  const an=String(a.name||a.userName||'').trim(),bn=String(b.name||b.userName||'').trim();
  return !!an&&an===bn;
 }
 function cacheKeys(user){
  const keys=[];
  for(let i=0;i<localStorage.length;i++){
   const key=localStorage.key(i);
   if(!key?.startsWith('heremay.messageCenter.v154.')||!key.endsWith('.items'))continue;
   try{const identity=JSON.parse(key.slice('heremay.messageCenter.v154.'.length,-6));if(sameUser(user,identity))keys.push({key:key.slice(0,-6),identity})}catch(_){}
  }
  return keys;
 }
 function apply(user,storageKey,items){
  const confirmed=read(storageKey+'.confirmedReads',{}),pending=new Set(read(storageKey+'.reads',[]));
  items.forEach(item=>{if(pending.has(item.id)||Date.now()-Number(confirmed[item.id]||0)<30*86400000)item.isRead=true});
  return items;
 }
 function stage(user,storageKey,items,item){
  const group=target(item);if(!group)return false;
  const key=userKey(user),entries=read(key,{});
  entries[group]={identity:user,storageKey,ids:items.filter(x=>!x.isRead&&target(x)===group).map(x=>x.id),stagedAt:Date.now()};
  save(key,entries);return true;
 }
 let running=false;
 async function flush(user){
  if(running)return;running=true;
  try{
   const entries=read(userKey(user),{});
   for(const entry of Object.values(entries)){
    if(!entry.confirmed)continue;
    const key=entry.storageKey+'.reads';
    for(const id of read(key,[])){
     await new Promise((resolve,reject)=>{
      const cb='hm_read_'+Date.now()+'_'+Math.random().toString(36).slice(2),script=document.createElement('script');
      const clean=()=>{clearTimeout(timer);delete window[cb];script.remove()};
      const timer=setTimeout(()=>{clean();reject(new Error('Read synchronization timed out'))},15000);
      window[cb]=data=>{clean();data?.ok?resolve():reject(new Error('Read synchronization failed'))};
      script.onerror=()=>{clean();reject(new Error('Read synchronization failed'))};
      script.src=service+'?'+new URLSearchParams({...entry.identity,action:'markRead',notificationId:id,callback:cb,_:Date.now()});document.head.appendChild(script);
     });
     save(key,read(key,[]).filter(x=>x!==id));
    }
   }
  }catch(_){/* Durable queue is retried by the message center. */}finally{running=false}
 }
 function confirm(user,kind,id){
  const group=kind+':'+id;
  const candidates=cacheKeys(user);
  // Also accept staged entries whose identity gained an employee ID on the content page.
  const stageKeys=[];
  for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i);if(key?.startsWith(prefix))stageKeys.push(key)}
  for(const key of stageKeys){
   const entries=read(key,{}),entry=entries[group];
   if(!entry||!sameUser(user,entry.identity)||Date.now()-entry.stagedAt>3600000)continue;
   candidates.push({key:entry.storageKey,identity:entry.identity,ids:entry.ids||[]});
  }
  const entries=read(userKey(user),{});
  for(const candidate of candidates){
   const storageKey=candidate.key,cache=read(storageKey+'.items',null);
   const ids=new Set([...(candidate.ids||[]),...(cache?.items||[]).filter(x=>!x.isRead&&target(x)===group).map(x=>x.id)]);
   if(!ids.size)continue;
   const confirmed=read(storageKey+'.confirmedReads',{});
   for(const nid of ids)confirmed[nid]=Date.now();
   for(const nid of Object.keys(confirmed))if(Date.now()-confirmed[nid]>30*86400000)delete confirmed[nid];
   save(storageKey+'.confirmedReads',confirmed);
   save(storageKey+'.reads',[...new Set([...read(storageKey+'.reads',[]),...ids])]);
   if(cache?.items){apply(user,storageKey,cache.items);save(storageKey+'.items',cache)}
   entries[group+'|'+storageKey]={identity:candidate.identity,storageKey,ids:[...ids],confirmed:true,stagedAt:Date.now()};
  }
  save(userKey(user),entries);flush(user);
 }
 window.HeremayNotificationReads={target,stage,confirm,apply,flush};
})();
