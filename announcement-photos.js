/* 和美公布欄照片 v1.0.0 */
(function(){
 'use strict';
 const cache=new Map(), pending=new Map();
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 function attachments(notice){let a=notice.attachments??notice.附件連結??[];try{if(typeof a==='string')a=JSON.parse(a)}catch(e){a=[]}return Array.isArray(a)?a.filter(x=>x&&typeof x==='object'&&['announcement-photo','announcement-file'].includes(x.kind)&&/^[\w-]+$/.test(x.fileId||'')):[]}
 function request(noticeId,fileId){
  const key=noticeId+':'+fileId;if(cache.has(key))return Promise.resolve(cache.get(key));if(pending.has(key))return pending.get(key);
  const promise=new Promise((resolve,reject)=>{
   const cb='hm_photo_'+Date.now()+'_'+Math.random().toString(36).slice(2),s=document.createElement('script');
   const timer=setTimeout(()=>finish(new Error('照片讀取逾時')),60000);
   function finish(err,data){clearTimeout(timer);delete window[cb];s.remove();if(err)reject(err);else resolve(data)}
   window[cb]=r=>{if(!r?.ok||!/^data:[a-z0-9.+\/-]+;base64,[A-Za-z0-9+/=]+$/i.test(r.dataUrl||''))return finish(new Error(r?.message||'照片暫時無法顯示'));if(r.dataUrl.startsWith('data:image/'))cache.set(key,r.dataUrl);while(cache.size>24)cache.delete(cache.keys().next().value);finish(null,r.dataUrl)};
   s.onerror=()=>finish(new Error('照片連線失敗'));
   s.src=SERVICE_URL+'?'+new URLSearchParams({action:'getAnnouncementAttachment',noticeId,fileId,callback:cb}).toString();document.head.append(s);
  }).finally(()=>pending.delete(key));pending.set(key,promise);return promise;
 }
 function photos(notice){return attachments(notice).filter(x=>x.kind==='announcement-photo')}
 function render(notice){const all=attachments(notice);if(!all.length)return '';return '<div class="hm-notice-photos">'+all.map(p=>p.kind==='announcement-photo'?`<button type="button" class="hm-notice-photo" data-notice="${esc(notice.id)}" data-photo="${esc(p.fileId)}" aria-label="放大公告照片"><span>點選查看照片</span><img alt="${esc(p.name||'公告照片')}" hidden></button>`:`<button type="button" class="hm-notice-file" data-notice="${esc(notice.id)}" data-file="${esc(p.fileId)}" data-name="${esc(p.name)}"><strong>📎 ${esc(p.name)}</strong><small>${Math.max(1,Math.round((p.size||0)/1024))} KB · 點選下載附件</small></button>`).join('')+'</div>'}
 function download(dataUrl,name){const parts=dataUrl.split(','),mime=parts[0].slice(5,-7),bytes=Uint8Array.from(atob(parts[1]),c=>c.charCodeAt(0));const url=URL.createObjectURL(new Blob([bytes],{type:mime}));const a=document.createElement('a');a.href=url;a.download=name||'公告附件';a.target='_blank';a.rel='noopener';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),120000)}
 async function loadFile(button){if(button.disabled)return;const label=button.querySelector('small'),original=label.textContent;button.disabled=true;label.textContent='附件載入中…';try{download(await request(button.dataset.notice,button.dataset.file),button.dataset.name);label.textContent=original}catch(e){label.textContent='附件未載入，點此重試'}finally{button.disabled=false}}
 async function load(button,open){
  let img=button.querySelector('img'),label=button.querySelector('span');
  try{label.textContent='照片載入中…';const url=await request(button.dataset.notice,button.dataset.photo);if(!button.isConnected)return;img.src=url;img.hidden=false;label.hidden=true;if(open)view(url,img.alt)}catch(e){label.hidden=false;label.textContent='照片未載入，點此重試';}
 }
 let dialog;
 function view(url,alt){if(!dialog){dialog=document.createElement('dialog');dialog.className='hm-photo-dialog';dialog.innerHTML='<button type="button" autofocus>關閉 ✕</button><img alt="公告照片">';dialog.querySelector('button').onclick=()=>dialog.close();dialog.addEventListener('click',e=>{if(e.target===dialog)dialog.close()});document.body.append(dialog)}dialog.querySelector('img').src=url;dialog.querySelector('img').alt=alt;dialog.showModal()}
 const observer='IntersectionObserver' in window?new IntersectionObserver(entries=>entries.forEach(e=>{if(e.isIntersecting){observer.unobserve(e.target);load(e.target,false)}}),{rootMargin:'100px'}):null;
 function hydrate(root=document){root.querySelectorAll('.hm-notice-file:not([data-ready])').forEach(button=>{button.dataset.ready='1';button.onclick=()=>loadFile(button)});root.querySelectorAll('.hm-notice-photo:not([data-ready])').forEach(button=>{button.dataset.ready='1';button.onclick=()=>load(button,true);if(observer)observer.observe(button);else load(button,false)})}
 const css=document.createElement('style');css.textContent='.hm-notice-file{max-width:100%;width:100%;text-align:left;border:1px solid #cdddeb;border-radius:12px;background:#f4f9ff;color:#254f65;padding:12px;cursor:pointer;overflow-wrap:anywhere;font:inherit}.hm-notice-file small{display:block;margin-top:5px;color:#536c80}.hm-notice-file:disabled{opacity:.6}.hm-notice-photos{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0;max-width:100%}.hm-notice-photo{width:clamp(86px,27vw,160px);height:130px;border:1px solid #cdddeb;border-radius:12px;background:#eef7ff;color:#355d7d;overflow:hidden;padding:0;cursor:pointer;font:inherit;font-size:14px}.hm-notice-photo img{width:100%;height:100%;object-fit:cover}.hm-notice-photo span{padding:8px;display:block}.hm-notice-photo [hidden]{display:none}.hm-photo-dialog{min-width:min(360px,92vw);min-height:110px;box-sizing:border-box;border:0;border-radius:16px;padding:48px 12px 12px;background:#fff;max-width:96vw;max-height:94vh}.hm-photo-dialog::backdrop{background:#000b}.hm-photo-dialog>button{position:absolute;right:12px;top:8px;border:0;border-radius:10px;padding:9px 16px;background:#eaf3fb;color:#254f65;font:inherit;cursor:pointer}.hm-photo-dialog>img{display:block;margin:auto;max-width:88vw;max-height:78vh;object-fit:contain}.hm-photo-preview{display:flex;flex-wrap:wrap;gap:10px;margin-top:10px}.hm-photo-preview figure{width:125px;margin:0}.hm-photo-preview img{width:125px;height:105px;border-radius:12px;object-fit:cover}.hm-photo-preview button{width:100%;margin-top:4px;padding:7px;border:0;border-radius:9px;cursor:pointer;color:#a83333;background:#fff0f0}.hm-photo-hint{font-size:14px;color:#536c80;line-height:1.6;margin:6px 0}';document.head.append(css);
 window.HMNoticePhotos={photos,attachments,render,hydrate,request};
})();
