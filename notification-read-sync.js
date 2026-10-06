/* Confirm notification reads only after the corresponding content has loaded. */
(() => {
 const prefix='heremay.notificationRead.v1.';
 const service='https://script.google.com/macros/s/AKfycbwhJsU-5QiZ3uDd9UCnECd16jpHG_LoweHRIC7TrSf_AH-bDLPUFVeAGB2urQo25zzoVg/exec';
 const read=(key,fallback)=>{try{return JSON.parse(localStorage.getItem(key))||fallback}catch(_){return fallback}};
 const save=(key,value)=>localStorage.setItem(key,JSON.stringify(value));
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
  const key=userKey(user),entries=read(key,{}),entry=entries[kind+':'+id];
  if(!entry||entry.confirmed||Date.now()-entry.stagedAt>3600000)return;
  const reads=read(entry.storageKey+'.reads',[]),ids=new Set(entry.ids);
  save(entry.storageKey+'.reads',[...new Set([...reads,...entry.ids])]);
  const cache=read(entry.storageKey+'.items',null);
  if(cache?.items){cache.items.forEach(x=>{if(ids.has(x.id))x.isRead=true});save(entry.storageKey+'.items',cache)}
  entry.confirmed=true;save(key,entries);flush(user);
 }
 window.HeremayNotificationReads={target,stage,confirm};
})();
