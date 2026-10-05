import { createHash, timingSafeEqual } from 'node:crypto';

export function validSubscription(s) {
  try {
    const u = new URL(s?.endpoint);
    const host = u.hostname;
    return u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443') &&
      (host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com' ||
       host.endsWith('.push.apple.com') || host.endsWith('.notify.windows.com')) &&
      s.endpoint.length < 2048 && /^[A-Za-z0-9_-]{80,100}$/.test(s.keys?.p256dh || '') &&
      /^[A-Za-z0-9_-]{20,30}$/.test(s.keys?.auth || '');
  } catch { return false; }
}

export function bindingFor(e) {
  const norm = v => String(v || '').trim().toLowerCase();
  const labels = { admin:'主管', leader:'主管', teacher:'教保人員', support:'庶務人員', parttime:'兼任人員' };
  return {
    employeeId:e.employeeNo, name:e.name,
    identities:[...new Set([e.employeeNo, e.account].map(norm).filter(Boolean))],
    groups:[...new Set([e.department, e.category, e.role, labels[e.role], ...(e.role==='support'?['庶務部']:[])].map(norm).filter(Boolean))],
  };
}

export function installPushRelay(app, { db, lookupEmployee, listEmployees }) {
  const secret = String(process.env.PUSH_RELAY_KEY || '');
  const hash = v => createHash('sha256').update(v).digest('hex');
  const subscriptions = db.collection('campusPushSubscriptions');
  const outbox = db.collection('campusNotificationOutbox');
  function relayOnly(req, res, next) {
    const token = String(req.body?.relayKey || '');
    if (secret.length < 32 || !timingSafeEqual(Buffer.from(hash(token),'hex'), Buffer.from(hash(secret),'hex'))) {
      return res.status(401).json({ok:false, message:'通知服務驗證失敗'});
    }
    next();
  }
  app.get('/api/push/public-key', (_req,res) => {
    const publicKey = String(process.env.PUSH_VAPID_PUBLIC_KEY || '');
    if (!publicKey) return res.status(503).json({ok:false,message:'通知服務尚未完成設定'});
    res.set('Cache-Control','no-store').json({ok:true,publicKey});
  });
  app.post('/api/push/subscriptions', async (req,res) => {
    try {
      const account = String(req.body?.account || '').trim();
      const password = String(req.body?.password || '');
      const s = req.body?.subscription;
      if (!account || !password || !validSubscription(s)) return res.status(400).json({ok:false,message:'訂閱資料不完整'});
      // Persistent limit also applies when Cloud Run creates another instance.
      const rateRef = db.collection('pushEnrollmentAttempts').doc(hash(account.toLowerCase()));
      const allowed = await db.runTransaction(async tx => {
        const snap = await tx.get(rateRef), old = snap.data() || {}, now = Date.now();
        const count = now - Number(old.startedAt || 0) < 60000 ? Number(old.count || 0) : 0;
        if (count >= 5) return false;
        tx.set(rateRef,{count:count+1,startedAt:count ? old.startedAt : now});
        return true;
      });
      if (!allowed) return res.status(429).json({ok:false,message:'請稍候一分鐘再試'});
      const e = await lookupEmployee(account);
      if (!e?.canLogin || !e.role || !password || e.password !== password) return res.status(401).json({ok:false,message:'帳號或密碼錯誤'});
      const ref = subscriptions.doc(hash(s.endpoint));
      await db.runTransaction(async tx => {
        const old = (await tx.get(ref)).data();
        tx.set(ref, { subscription:{endpoint:s.endpoint,keys:{p256dh:s.keys.p256dh,auth:s.keys.auth}},
          ...bindingFor(e), boundAt:old?.employeeId === e.employeeNo ? old.boundAt : Date.now(), updatedAt:Date.now() });
      });
      res.json({ok:true,employeeId:e.employeeNo,name:e.name});
    } catch (error) { console.error('Push enrollment error',error); res.status(500).json({ok:false,message:'無法啟用通知'}); }
  });
  app.post('/api/push/relay/pull', relayOnly, async (_req,res) => {
    try {
      const [roster, subs, pending] = await Promise.all([listEmployees(),subscriptions.get(),outbox.where('delivered','==',false).limit(50).get()]);
      const employees = new Map(roster.map(e=>[e.employeeNo,e]));
      const items = subs.docs.flatMap(doc => {
        const x=doc.data(), e=employees.get(x.employeeId);
        return e && validSubscription(x.subscription) ? [{...x,...bindingFor(e)}] : [];
      });
      res.set('Cache-Control','no-store').json({ok:true,subscriptions:items,events:pending.docs.map(d=>({id:d.id,...d.data()}))});
    } catch (error) { console.error('Relay pull error',error); res.status(500).json({ok:false,message:'無法讀取通知待送資料'}); }
  });
  app.post('/api/push/relay/ack', relayOnly, async (req,res) => {
    try {
      const ids = [...new Set((Array.isArray(req.body.ids)?req.body.ids:[]).filter(x=>typeof x==='string' && /^[a-zA-Z0-9-]{1,150}$/.test(x)))].slice(0,50);
      const batch=db.batch();
      ids.forEach(id=>batch.update(outbox.doc(id),{delivered:true,deliveredAt:Date.now()}));
      await batch.commit(); res.json({ok:true});
    } catch (error) { res.status(500).json({ok:false,message:'無法確認通知同步'}); }
  });
  return {outbox};
}
