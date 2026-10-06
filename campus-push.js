/* 和美智慧校園：各角色共用同一個 Web Push 訂閱。 */
(() => {
  const API='https://heremay-passkey-backend-943533867342.asia-east1.run.app';
  const BINDING='heremay.pushBinding';
  let enabling=false;
  function employee(){try{return JSON.parse(localStorage.getItem('heremay.currentEmployee')||'{}')||{};}catch{return {};}}
  function employeeId(e){return String(e.employeeNo||e.employeeId||e.id||e['員工編號']||'');}
  function account(e){return String(e.account||employeeId(e)||localStorage.getItem('heremay.lastFaceAccount')||'');}
  function bytes(key){return Uint8Array.from(atob(key.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));}
  async function json(url,options={}) {
    const r=await fetch(API+url,{...options,cache:'no-store',signal:AbortSignal.timeout(15000)});
    const data=await r.json();if(!r.ok||!data.ok)throw new Error(data.message||'通知服務連線失敗');return data;
  }
  async function enable(button){
    if(enabling)return;enabling=true;if(button)button.disabled=true;
    try {
      if(!window.isSecureContext||!('serviceWorker' in navigator)||!('PushManager' in window)||!('Notification' in window))throw new Error('請從支援通知的瀏覽器或手機桌面的智慧校園開啟。');
      const e=employee(),login=account(e);if(!login)throw new Error('請先登入智慧校園。');
      // Request permission directly from the user's click, before network operations.
      if(Notification.permission!=='granted' && await Notification.requestPermission()!=='granted')throw new Error('請在裝置設定中允許智慧校園通知。');
      const password=window.prompt('首次開啟訊息推播，請輸入本人登入密碼以確認收件帳號：');
      if(!password)return;
      await navigator.serviceWorker.register('./sw.js');
      const registration=await navigator.serviceWorker.ready;
      const {publicKey}=await json('/api/push/public-key');
      let s=await registration.pushManager.getSubscription();
      if(s&&s.options.applicationServerKey&&String(new Uint8Array(s.options.applicationServerKey))!==String(bytes(publicKey))){await s.unsubscribe();s=null;}
      if(!s)s=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:bytes(publicKey)});
      const result=await json('/api/push/subscriptions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({account:login,password,subscription:s.toJSON()})});
      localStorage.setItem(BINDING,JSON.stringify({employeeId:result.employeeId,account:login}));
      if(button)button.textContent='✅ 訊息推播已開啟';
      alert('已開啟訊息推播。通知聲音與震動依手機、手錶的設定。');
    }catch(error){alert(error.message||'無法啟用通知');}
    finally{enabling=false;if(button)button.disabled=false;}
  }
  async function checkBinding(){
    let old;try{old=JSON.parse(localStorage.getItem(BINDING)||'null');}catch{}
    const e=employee();
    if(old && (!account(e) || (employeeId(e) ? old.employeeId!==employeeId(e) : old.account!==account(e)))){
      // Account changes must not keep receiving another employee's notifications.
      const r=await navigator.serviceWorker?.getRegistration('./');const s=await r?.pushManager.getSubscription();
      if(s)await s.unsubscribe();localStorage.removeItem(BINDING);
    }
  }
  function setup(){
    let button=document.getElementById('pushEnableButton');
    if(!button){
      const anchor=document.querySelector('[onclick*="openMessageCenter"]');
      if(!anchor){
        const container=document.querySelector('.welcome');
        if(container){
          const center=document.createElement('button');center.type='button';center.textContent='🔔 訊息中心';
          center.style.cssText='padding:12px;border:1px solid #80bca2;border-radius:14px;background:#eaf8ef;color:#216642;font-weight:900';
          center.onclick=()=>{const e=employee(),p=new URLSearchParams({employeeId:employeeId(e),account:account(e),name:String(e.name||e['姓名']||''),groups:String(e.department||e.group||'')});p.set('back',location.href);location.href='message_center.html?'+p;};
          container.insertAdjacentElement('afterend',center);
        }
      }
      button=document.createElement('button');button.id='pushEnableButton';button.type='button';
      button.style.cssText='margin:8px 0;padding:10px 14px;border:1px solid #80bca2;border-radius:14px;background:#eaf8ef;color:#216642;font-weight:900';
      const placement=anchor||document.querySelector('.welcome');if(!placement)return;placement.insertAdjacentElement('afterend',button);
    }
    button.textContent='🔔 開啟訊息推播';button.onclick=()=>enable(button);
    checkBinding().then(async()=>{
      const old=JSON.parse(localStorage.getItem(BINDING)||'null');
      const r=await navigator.serviceWorker?.getRegistration('./');
      if(old && await r?.pushManager.getSubscription())button.textContent='✅ 訊息推播已開啟';
    }).catch(()=>{});
  }
  window.CampusPush={enable,checkBinding};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',setup);else setup();
  window.addEventListener('storage',()=>checkBinding().catch(()=>{}));
  window.addEventListener('pagehide',()=>checkBinding().catch(()=>{}));
})();
