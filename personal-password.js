(() => {
  const endpoint = 'https://script.google.com/macros/s/AKfycbzbZ6r6c8XjHuKad0U5TIJXr8i141fCBwNJcVsKnoGa1-NXG_JOzapeRF5cVlnGI4F7/exec';
  let busy = false;
  window.savePasswordDemo = async function () {
    if (busy) return;
    const oldInput = document.getElementById('oldPassword');
    const newInput = document.getElementById('newPassword');
    const confirmInput = document.getElementById('confirmPassword');
    const notify = message => window.showToast(message);
    let employee;
    try { employee = JSON.parse(localStorage.getItem('heremay.currentEmployee') || '{}'); } catch (_) { employee = {}; }
    const account = String(employee.account || localStorage.getItem('heremay.lastFaceAccount') || '').trim();
    if (!account) return notify('無法確認登入帳號，請重新登入');
    if (!oldInput.value || !newInput.value || !confirmInput.value) return notify('請完整輸入目前密碼與新密碼');
    if (!/^\d{6}$/.test(newInput.value)) return notify('新密碼必須是 6 位數字');
    if (newInput.value !== confirmInput.value) return notify('兩次輸入的新密碼不一致');
    if (oldInput.value === newInput.value) return notify('新密碼不能與目前密碼相同');
    busy = true;
    const button = document.querySelector('#personalModal [onclick="savePasswordDemo()"]');
    if (button) { button.disabled = true; button.textContent = '正在儲存…'; }
    try {
      const result = await new Promise((resolve, reject) => {
        const requestId = 'password_' + Date.now() + '_' + Math.random().toString(36).slice(2);
        const frame = document.createElement('iframe');
        frame.name = requestId; frame.hidden = true;
        const form = document.createElement('form');
        form.method = 'POST'; form.action = endpoint; form.target = requestId; form.hidden = true;
        const fields = {action:'changePassword',account,oldPassword:oldInput.value,newPassword:newInput.value,requestId};
        Object.entries(fields).forEach(([name,value]) => {
          const input = document.createElement('input'); input.type = 'hidden'; input.name = name; input.value = value; form.appendChild(input);
        });
        const cleanup = () => { clearTimeout(timer); window.removeEventListener('message', receive); form.remove(); frame.remove(); };
        const receive = event => {
          if (!/^https:\/\/(?:script.google.com|[a-z0-9-]+\.googleusercontent.com)$/.test(event.origin)) return;
          const data = event.data || {};
          if (data.type !== 'HEREMAY_PASSWORD_RESULT' || data.payload?.requestId !== requestId) return;
          cleanup(); resolve(data.payload);
        };
        const timer = setTimeout(() => { cleanup(); reject(new Error('尚未收到修改結果，請稍後用新密碼登入確認；若無法登入再用原密碼')); }, 30000);
        window.addEventListener('message', receive);
        document.body.append(frame,form); form.submit();
      });
      if (!result.ok) { notify(result.message || '修改密碼失敗'); return; }
      oldInput.value = ''; newInput.value = ''; confirmInput.value = '';
      window.hidePersonalSettings(); notify(result.message);
    } catch (error) { notify(error.message); }
    finally { busy = false; if (button) { button.disabled = false; button.textContent = '儲存新密碼'; } }
  };
})();
