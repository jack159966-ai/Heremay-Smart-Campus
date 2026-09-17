import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { google } from 'googleapis';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';

const app = express();
app.use(helmet());
app.use(express.json({ limit: '1mb' }));

const PORT = Number(process.env.PORT || 8080);
const SERVICE_VERSION = '1.2.1';
const RP_NAME = process.env.RP_NAME || '和美智慧校園';
const RP_ID = process.env.RP_ID || 'jack159966-ai.github.io';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://jack159966-ai.github.io')
  .split(',').map(v => v.trim()).filter(Boolean);
const LOGIN_SHEET_ID = process.env.LOGIN_SHEET_ID || '1qF7NhSzpg5MAskTEXSWPt1Z__jGfbEdF8Gr5AUBmFYQ';
const LOGIN_SHEET_TAB = process.env.LOGIN_SHEET_TAB || '員工登入資料';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
// 通行憑證仍只有 5 分鐘；打卡區保持在前景時才可安全續期。
const SENSITIVE_TOKEN_TTL_MS = 5 * 60 * 1000;
const ADMIN_SENSITIVE_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
const SENSITIVE_PURPOSES = new Set(['attendance','attendance_admin','salary','salary_admin']);

app.use(cors({
  origin(origin, cb) {
    // 電腦版正式系統會直接從園方 GitHub 同步資料夾開啟，瀏覽器的 Origin 會是字串 "null"。
    // 仍需通過帳密及角色驗證，僅在此放行跨來源連線。
    if (!origin || origin === 'null') return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('Origin not allowed'));
  },
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));

const db = new Firestore();
const auth = new google.auth.GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});
const sheets = google.sheets({ version: 'v4', auth });

function clean(v) { return String(v ?? '').trim(); }
function yes(v) { return ['是','true','1','yes','y'].includes(clean(v).toLowerCase()) || clean(v)==='是'; }
function identityKey(employeeNo, name) {
  return `${clean(employeeNo).toLowerCase()}::${clean(name).toLowerCase()}`;
}
function conversationKey(a, b) { return [a, b].sort().join('||'); }

let employeeCache = { expiresAt:0, items:[] };

function roleFromHome(home, category) {
  const h = clean(home);
  if (h === '管理首頁') return 'admin';
  if (h === '中階主管首頁') return 'leader';
  if (h === '教保首頁') return 'teacher';
  if (h === '庶務首頁') return 'support';
  if (h === '兼任首頁') return 'parttime';
  const c = clean(category);
  if (c === '管理層') return 'admin';
  if (c === '庶務人員') return 'support';
  if (c === '教保人員') return 'teacher';
  if (c === '外聘教師' || c === '外聘兼任教師' || c === '兼職人員' || c === '臨時人員') return 'parttime';
  return '';
}

async function lookupEmployee(account) {
  const result = await sheets.spreadsheets.values.get({
    spreadsheetId: LOGIN_SHEET_ID,
    range: `'${LOGIN_SHEET_TAB.replaceAll("'", "''")}'!A1:M200`,
    valueRenderOption: 'FORMATTED_VALUE',
  });
  const rows = result.data.values || [];
  if (rows.length < 2) return null;
  const headers = rows[0].map(clean);
  const idx = Object.fromEntries(headers.map((h,i)=>[h,i]));
  const key = clean(account).toLowerCase();
  const row = rows.slice(1).find(r => {
    const empNo = clean(r[idx['員工編號']]).toLowerCase();
    const login = clean(r[idx['登入帳號']]).toLowerCase();
    return key === empNo || key === login;
  });
  if (!row) return null;
  const get = h => clean(row[idx[h]]);
  const employee = {
    employeeNo: get('員工編號'),
    name: get('姓名'),
    account: get('登入帳號'),
    title: get('職稱'),
    category: get('身分類別'),
    department: get('編組'),
    homeType: get('首頁類型'),
    canLogin: yes(get('是否可登入')),
    password: get('臨時密碼'),
    announcementAdmin: yes(get('公告管理')),
    scheduleAdmin: yes(get('排班管理')),
    classCode: get('班別'),
    rank: get('職級'),
  };
  employee.role = roleFromHome(employee.homeType, employee.category);
  return employee;
}

async function listEmployees() {
  if (employeeCache.expiresAt > Date.now() && employeeCache.items.length) return employeeCache.items;
  const result = await sheets.spreadsheets.values.get({
    spreadsheetId: LOGIN_SHEET_ID,
    range: `'${LOGIN_SHEET_TAB.replaceAll("'", "''")}'!A1:M500`,
    valueRenderOption: 'FORMATTED_VALUE',
  });
  const rows = result.data.values || [];
  if (rows.length < 2) return [];
  const headers = rows[0].map(clean);
  const idx = Object.fromEntries(headers.map((h,i)=>[h,i]));
  const get = (row, h) => clean(row[idx[h]]);
  const items = rows.slice(1).map(row => {
    const employee = {
      employeeNo:get(row,'員工編號'), name:get(row,'姓名'), account:get(row,'登入帳號'),
      title:get(row,'職稱'), category:get(row,'身分類別'), department:get(row,'編組'),
      homeType:get(row,'首頁類型'), canLogin:yes(get(row,'是否可登入')),
      announcementAdmin:yes(get(row,'公告管理')), scheduleAdmin:yes(get(row,'排班管理')),
      classCode:get(row,'班別'), rank:get(row,'職級'),
    };
    employee.role = roleFromHome(employee.homeType, employee.category);
    return employee;
  }).filter(e => e.employeeNo && e.name && e.canLogin && e.role);
  employeeCache = { expiresAt:Date.now() + 60_000, items };
  return items;
}

async function requireRosterIdentity(employeeNo, name) {
  const key = identityKey(employeeNo, name);
  const employee = (await listEmployees()).find(e => identityKey(e.employeeNo, e.name) === key);
  if (!employee) throw new Error('找不到登入者資料，請重新登入');
  return employee;
}

function privateIdentity(employeeNo, name) {
  const employee = { employeeNo:clean(employeeNo), name:clean(name) };
  if (!employee.employeeNo || !employee.name) throw new Error('登入身分不完整，請重新登入');
  return employee;
}

function privateMessageJson(doc) {
  const x = doc.data ? doc.data() : doc;
  return {
    id:doc.id || x.id, createdAt:Number(x.createdAt || 0),
    senderId:clean(x.senderId), senderName:clean(x.senderName),
    receiverId:clean(x.receiverId), receiverName:clean(x.receiverName),
    messageType:clean(x.messageType || 'text'), message:clean(x.message),
    readAt:Number(x.readAt || 0), recalled:Boolean(x.recalled),
  };
}

function publicEmployee(e) {
  return {
    employeeNo: e.employeeNo,
    name: e.name,
    account: e.account,
    title: e.title,
    category: e.category,
    department: e.department,
    homeType: e.homeType,
    announcementAdmin: e.announcementAdmin,
    scheduleAdmin: e.scheduleAdmin,
    classCode: e.classCode,
    rank: e.rank,
  };
}

function userDocId(employee) {
  return employee.employeeNo || employee.account;
}

async function saveChallenge(userId, type, challenge) {
  await db.collection('passkeyChallenges').doc(`${type}_${userId}`).set({
    challenge,
    type,
    createdAt: Date.now(),
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
  });
}

async function loadChallenge(userId, type) {
  const ref = db.collection('passkeyChallenges').doc(`${type}_${userId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('驗證要求已失效，請重新操作');
  const data = snap.data();
  if (!data || data.type !== type || Number(data.expiresAt || 0) < Date.now()) {
    await ref.delete().catch(()=>{});
    throw new Error('驗證要求已逾時，請重新操作');
  }
  return { ref, ...data };
}

async function listPasskeys(userId) {
  const snap = await db.collection('passkeys').where('userId','==',userId).get();
  return snap.docs.map(doc => ({ docId: doc.id, ...doc.data() }));
}

function normalizeSensitivePurpose(value) {
  const purpose = clean(value);
  if (!SENSITIVE_PURPOSES.has(purpose)) throw new Error('不支援的敏感操作');
  return purpose;
}

function assertSensitivePurposeAllowed(employee, purpose) {
  if (purpose === 'attendance_admin' || purpose === 'salary_admin') {
    if (!['admin', 'leader'].includes(clean(employee?.role))) {
      throw new Error('此帳號沒有主管操作權限');
    }
  }
}

function sensitiveTokenHash(token) {
  return createHash('sha256').update(clean(token)).digest('hex');
}

async function issueSensitiveToken(employee, purpose) {
  purpose = normalizeSensitivePurpose(purpose);
  assertSensitivePurposeAllowed(employee, purpose);
  const token = randomBytes(32).toString('base64url');
  const ttlMs = purpose.endsWith('_admin') ? ADMIN_SENSITIVE_TOKEN_TTL_MS : SENSITIVE_TOKEN_TTL_MS;
  const expiresAt = Date.now() + ttlMs;
  await db.collection('sensitiveTokens').doc(sensitiveTokenHash(token)).set({
    userId: userDocId(employee),
    employeeNo: employee.employeeNo,
    account: employee.account,
    role: employee.role,
    purpose,
    createdAt: Date.now(),
    expiresAt,
  });
  return { token, expiresAt, expiresInSeconds: Math.floor(ttlMs / 1000) };
}

function accountMatchesToken(account, tokenData) {
  const wanted = clean(account).toLowerCase();
  return !!wanted && [tokenData.userId, tokenData.employeeNo, tokenData.account]
    .map(v => clean(v).toLowerCase()).filter(Boolean).includes(wanted);
}

app.get('/health', (_req,res) => res.json({ ok:true, service:'heremay-passkey', version:SERVICE_VERSION }));

app.post('/auth/passkey/register/options', async (req,res) => {
  try {
    const account = clean(req.body?.account);
    const password = clean(req.body?.password);
    if (!account || !password) return res.status(400).json({ ok:false, message:'請輸入帳號與密碼' });
    const employee = await lookupEmployee(account);
    if (!employee || !employee.canLogin || !employee.role) return res.status(401).json({ ok:false, message:'帳號不可登入' });
    if (employee.password !== password) return res.status(401).json({ ok:false, message:'帳號或密碼錯誤' });

    const userId = userDocId(employee);
    const passkeys = await listPasskeys(userId);
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userID: new TextEncoder().encode(userId),
      userName: employee.account || employee.employeeNo,
      userDisplayName: employee.name,
      attestationType: 'none',
      supportedAlgorithmIDs: [-7, -257],
      excludeCredentials: passkeys.map(p => ({ id:p.credentialId, transports:p.transports || [] })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'required',
      },
    });
    await saveChallenge(userId, 'register', options.challenge);
    res.json({ ok:true, publicKey:options });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok:false, message:'無法建立快速登入設定' });
  }
});

app.post('/auth/passkey/register/verify', async (req,res) => {
  try {
    const account = clean(req.body?.account);
    const response = req.body?.credential;
    if (!account || !response) return res.status(400).json({ ok:false, message:'資料不完整' });
    const employee = await lookupEmployee(account);
    if (!employee || !employee.canLogin || !employee.role) return res.status(401).json({ ok:false, message:'帳號不可登入' });
    const userId = userDocId(employee);
    const challenge = await loadChallenge(userId, 'register');
    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: ALLOWED_ORIGINS,
      expectedRPID: RP_ID,
      requireUserVerification: true,
    });
    if (!verification.verified || !verification.registrationInfo) {
      return res.status(401).json({ ok:false, message:'快速登入驗證失敗' });
    }
    const info = verification.registrationInfo;
    const cred = info.credential;
    await db.collection('passkeys').doc(cred.id).set({
      userId,
      employeeNo: employee.employeeNo,
      account: employee.account,
      credentialId: cred.id,
      publicKey: Buffer.from(cred.publicKey).toString('base64url'),
      counter: Number(cred.counter || 0),
      transports: response?.response?.transports || [],
      deviceType: info.credentialDeviceType || '',
      backedUp: Boolean(info.credentialBackedUp),
      createdAt: Date.now(),
      lastUsedAt: null,
    }, { merge:true });
    await challenge.ref.delete();
    res.json({ ok:true, role:employee.role, employee:publicEmployee(employee) });
  } catch (err) {
    console.error(err);
    res.status(400).json({ ok:false, message:err?.message || '快速登入設定失敗' });
  }
});

app.post('/auth/passkey/login/options', async (req,res) => {
  try {
    const account = clean(req.body?.account);
    const employee = await lookupEmployee(account);
    if (!employee || !employee.canLogin || !employee.role) return res.status(401).json({ ok:false, message:'帳號不可登入' });
    const userId = userDocId(employee);
    const passkeys = await listPasskeys(userId);
    if (!passkeys.length) return res.status(404).json({ ok:false, message:'此帳號尚未設定快速登入' });
    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      userVerification: 'required',
      allowCredentials: passkeys.map(p => ({ id:p.credentialId, transports:p.transports || [] })),
    });
    await saveChallenge(userId, 'login', options.challenge);
    res.json({ ok:true, publicKey:options });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok:false, message:'無法啟動快速登入' });
  }
});

app.post('/auth/passkey/login/verify', async (req,res) => {
  try {
    const account = clean(req.body?.account);
    const response = req.body?.credential;
    if (!account || !response?.id) return res.status(400).json({ ok:false, message:'資料不完整' });
    const employee = await lookupEmployee(account);
    if (!employee || !employee.canLogin || !employee.role) return res.status(401).json({ ok:false, message:'帳號不可登入' });
    const userId = userDocId(employee);
    const challenge = await loadChallenge(userId, 'login');
    const snap = await db.collection('passkeys').doc(response.id).get();
    if (!snap.exists) return res.status(401).json({ ok:false, message:'找不到已登錄的快速登入憑證' });
    const stored = snap.data();
    if (stored.userId !== userId) return res.status(401).json({ ok:false, message:'快速登入憑證不屬於此帳號' });

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: ALLOWED_ORIGINS,
      expectedRPID: RP_ID,
      requireUserVerification: true,
      credential: {
        id: stored.credentialId,
        publicKey: Uint8Array.from(Buffer.from(stored.publicKey, 'base64url')),
        counter: Number(stored.counter || 0),
        transports: stored.transports || [],
      },
    });
    if (!verification.verified) return res.status(401).json({ ok:false, message:'快速登入驗證失敗' });

    await snap.ref.set({
      counter: Number(verification.authenticationInfo?.newCounter ?? stored.counter ?? 0),
      lastUsedAt: Date.now(),
    }, { merge:true });
    await challenge.ref.delete();
    res.json({ ok:true, role:employee.role, employee:publicEmployee(employee) });
  } catch (err) {
    console.error(err);
    res.status(400).json({ ok:false, message:err?.message || '快速登入失敗' });
  }
});

app.post('/auth/step-up/password', async (req,res) => {
  try {
    const account = clean(req.body?.account);
    const password = clean(req.body?.password);
    const purpose = normalizeSensitivePurpose(req.body?.purpose);
    if (!account || !/^\d{6}$/.test(password)) return res.status(400).json({ ok:false, message:'請輸入本人 6 位數密碼' });
    const employee = await lookupEmployee(account);
    if (!employee || !employee.canLogin || !employee.role) return res.status(401).json({ ok:false, message:'帳號不可登入' });
    if (employee.password !== password) return res.status(401).json({ ok:false, message:'密碼錯誤' });
    const grant = await issueSensitiveToken(employee, purpose);
    res.json({ ok:true, ...grant, role:employee.role, employee:publicEmployee(employee) });
  } catch (err) {
    console.error(err);
    res.status(400).json({ ok:false, message:err?.message || '無法完成二次驗證' });
  }
});

app.post('/auth/step-up/passkey/options', async (req,res) => {
  try {
    const account = clean(req.body?.account);
    const purpose = normalizeSensitivePurpose(req.body?.purpose);
    const employee = await lookupEmployee(account);
    if (!employee || !employee.canLogin || !employee.role) return res.status(401).json({ ok:false, message:'帳號不可登入' });
    const userId = userDocId(employee);
    const passkeys = await listPasskeys(userId);
    if (!passkeys.length) return res.status(404).json({ ok:false, message:'此帳號尚未設定快速登入，請改用密碼' });
    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      userVerification: 'required',
      allowCredentials: passkeys.map(p => ({ id:p.credentialId, transports:p.transports || [] })),
    });
    await saveChallenge(userId, `stepup_${purpose}`, options.challenge);
    res.json({ ok:true, publicKey:options });
  } catch (err) {
    console.error(err);
    res.status(400).json({ ok:false, message:err?.message || '無法啟動快速驗證' });
  }
});

app.post('/auth/step-up/passkey/verify', async (req,res) => {
  try {
    const account = clean(req.body?.account);
    const purpose = normalizeSensitivePurpose(req.body?.purpose);
    const response = req.body?.credential;
    if (!account || !response?.id) return res.status(400).json({ ok:false, message:'資料不完整' });
    const employee = await lookupEmployee(account);
    if (!employee || !employee.canLogin || !employee.role) return res.status(401).json({ ok:false, message:'帳號不可登入' });
    const userId = userDocId(employee);
    const challenge = await loadChallenge(userId, `stepup_${purpose}`);
    const snap = await db.collection('passkeys').doc(response.id).get();
    if (!snap.exists) return res.status(401).json({ ok:false, message:'找不到已登錄的快速登入憑證' });
    const stored = snap.data();
    if (stored.userId !== userId) return res.status(401).json({ ok:false, message:'快速登入憑證不屬於此帳號' });
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: ALLOWED_ORIGINS,
      expectedRPID: RP_ID,
      requireUserVerification: true,
      credential: {
        id: stored.credentialId,
        publicKey: Uint8Array.from(Buffer.from(stored.publicKey, 'base64url')),
        counter: Number(stored.counter || 0),
        transports: stored.transports || [],
      },
    });
    if (!verification.verified) return res.status(401).json({ ok:false, message:'快速驗證失敗' });
    await snap.ref.set({
      counter: Number(verification.authenticationInfo?.newCounter ?? stored.counter ?? 0),
      lastUsedAt: Date.now(),
    }, { merge:true });
    await challenge.ref.delete();
    const grant = await issueSensitiveToken(employee, purpose);
    res.json({ ok:true, ...grant, role:employee.role, employee:publicEmployee(employee) });
  } catch (err) {
    console.error(err);
    res.status(400).json({ ok:false, message:err?.message || '快速驗證失敗' });
  }
});

app.post('/auth/step-up/validate', async (req,res) => {
  try {
    const token = clean(req.body?.token);
    const account = clean(req.body?.account);
    const purpose = normalizeSensitivePurpose(req.body?.purpose);
    if (!token || !account) return res.status(401).json({ ok:false, message:'缺少敏感操作憑證' });
    const ref = db.collection('sensitiveTokens').doc(sensitiveTokenHash(token));
    const snap = await ref.get();
    if (!snap.exists) return res.status(401).json({ ok:false, message:'驗證憑證無效，請重新驗證' });
    const grant = snap.data() || {};
    if (Number(grant.expiresAt || 0) < Date.now()) {
      await ref.delete().catch(()=>{});
      return res.status(401).json({ ok:false, message:'打卡區驗證已失效，請重新驗證' });
    }
    if (grant.purpose !== purpose || !accountMatchesToken(account, grant)) {
      return res.status(403).json({ ok:false, message:'驗證帳號或用途不符' });
    }
    res.json({
      ok:true,
      employeeNo:grant.employeeNo || '',
      account:grant.account || '',
      role:grant.role || '',
      purpose:grant.purpose,
      expiresAt:Number(grant.expiresAt || 0),
    });
  } catch (err) {
    console.error(err);
    res.status(400).json({ ok:false, message:err?.message || '憑證檢查失敗' });
  }
});

app.post('/auth/step-up/refresh', async (req,res) => {
  try {
    const token = clean(req.body?.token);
    const account = clean(req.body?.account);
    const purpose = normalizeSensitivePurpose(req.body?.purpose);
    if (!token || !account) return res.status(401).json({ ok:false, message:'缺少打卡區憑證' });
    const ref = db.collection('sensitiveTokens').doc(sensitiveTokenHash(token));
    const snap = await ref.get();
    if (!snap.exists) return res.status(401).json({ ok:false, message:'打卡區憑證已失效' });
    const grant = snap.data() || {};
    if (Number(grant.expiresAt || 0) < Date.now()) {
      await ref.delete().catch(()=>{});
      return res.status(401).json({ ok:false, message:'打卡區憑證已失效' });
    }
    if (grant.purpose !== purpose || !accountMatchesToken(account, grant)) {
      return res.status(403).json({ ok:false, message:'驗證帳號或用途不符' });
    }
    const ttlMs = purpose.endsWith('_admin') ? ADMIN_SENSITIVE_TOKEN_TTL_MS : SENSITIVE_TOKEN_TTL_MS;
    const expiresAt = Date.now() + ttlMs;
    await ref.set({ expiresAt, lastRefreshedAt:Date.now() }, { merge:true });
    res.json({ ok:true, token, expiresAt, expiresInSeconds:Math.floor(ttlMs / 1000) });
  } catch (err) {
    console.error(err);
    res.status(400).json({ ok:false, message:err?.message || '無法續用打卡區驗證' });
  }
});

// 私訊改由 Cloud Run + Firestore 處理，避免 Apps Script 在 iPhone 上無法回傳結果。
app.get('/api/private/contacts', async (req,res) => {
  try {
    const me = privateIdentity(req.query.employeeId, req.query.name);
    const myKey = identityKey(me.employeeNo, me.name);
    const items = (await listEmployees())
      .filter(e => identityKey(e.employeeNo, e.name) !== myKey)
      .map(e => ({
        employeeId:e.employeeNo, name:e.name, title:e.title,
        department:e.department, classCode:e.classCode, role:e.role,
      }))
      .sort((a,b) => `${a.department}|${a.name}`.localeCompare(`${b.department}|${b.name}`, 'zh-Hant'));
    res.json({ ok:true, items });
  } catch (err) {
    console.error(err);
    res.status(400).json({ ok:false, message:err?.message || '無法讀取聯絡人' });
  }
});

app.get('/api/private/threads', async (req,res) => {
  try {
    const me = privateIdentity(req.query.employeeId, req.query.name);
    const myKey = identityKey(me.employeeNo, me.name);
    const snap = await db.collection('privateMessages')
      .where('participantKeys','array-contains',myKey).limit(1000).get();
    const grouped = new Map();
    snap.docs.forEach(doc => {
      const x = privateMessageJson(doc);
      if (x.recalled) return;
      const mine = identityKey(x.senderId, x.senderName) === myKey;
      const peerId = mine ? x.receiverId : x.senderId;
      const peerName = mine ? x.receiverName : x.senderName;
      const peerKey = identityKey(peerId, peerName);
      const old = grouped.get(peerKey) || { peerId, peerName, lastMessage:'', lastAt:0, unread:0 };
      if (x.createdAt >= old.lastAt) {
        old.lastAt = x.createdAt;
        old.lastMessage = x.message || '訊息';
      }
      if (!mine && !x.readAt) old.unread += 1;
      grouped.set(peerKey, old);
    });
    const items = [...grouped.values()].sort((a,b)=>b.lastAt-a.lastAt);
    res.json({ ok:true, items });
  } catch (err) {
    console.error(err);
    res.status(400).json({ ok:false, message:err?.message || '無法讀取對話' });
  }
});

app.get('/api/private/messages', async (req,res) => {
  try {
    const me = privateIdentity(req.query.employeeId, req.query.name);
    const peer = privateIdentity(req.query.peerId, req.query.peerName);
    const myKey = identityKey(me.employeeNo, me.name);
    const peerKey = identityKey(peer.employeeNo, peer.name);
    const snap = await db.collection('privateMessages')
      .where('conversationKey','==',conversationKey(myKey, peerKey)).limit(500).get();
    const items = snap.docs.map(privateMessageJson)
      .filter(x=>!x.recalled).sort((a,b)=>a.createdAt-b.createdAt);
    res.json({ ok:true, items });
  } catch (err) {
    console.error(err);
    res.status(400).json({ ok:false, message:err?.message || '無法讀取訊息' });
  }
});

app.post('/api/private/messages', async (req,res) => {
  try {
    const me = privateIdentity(req.body?.senderId, req.body?.senderName);
    const peer = privateIdentity(req.body?.receiverId, req.body?.receiverName);
    const message = clean(req.body?.message);
    if (!message) return res.status(400).json({ ok:false, message:'請輸入訊息' });
    if (message.length > 1000) return res.status(400).json({ ok:false, message:'訊息不可超過 1000 字' });
    const senderKey = identityKey(me.employeeNo, me.name);
    const receiverKey = identityKey(peer.employeeNo, peer.name);
    if (senderKey === receiverKey) return res.status(400).json({ ok:false, message:'不能傳送給自己' });
    const id = randomUUID();
    const data = {
      id, createdAt:Date.now(), senderId:me.employeeNo, senderName:me.name,
      receiverId:peer.employeeNo, receiverName:peer.name,
      senderKey, receiverKey, participantKeys:[senderKey, receiverKey],
      conversationKey:conversationKey(senderKey, receiverKey),
      messageType:req.body?.quickReply ? 'quick' : 'text', message,
      readAt:0, recalled:false,
    };
    await db.collection('privateMessages').doc(id).create(data);
    res.status(201).json({ ok:true, item:privateMessageJson(data) });
  } catch (err) {
    console.error(err);
    res.status(400).json({ ok:false, message:err?.message || '訊息傳送失敗' });
  }
});

app.post('/api/private/read', async (req,res) => {
  try {
    const me = privateIdentity(req.body?.employeeId, req.body?.name);
    const peer = privateIdentity(req.body?.peerId, req.body?.peerName);
    const myKey = identityKey(me.employeeNo, me.name);
    const peerKey = identityKey(peer.employeeNo, peer.name);
    const snap = await db.collection('privateMessages')
      .where('conversationKey','==',conversationKey(myKey, peerKey)).limit(500).get();
    const unread = snap.docs.filter(doc => {
      const x = doc.data() || {};
      return clean(x.receiverKey) === myKey && !Number(x.readAt || 0) && !x.recalled;
    });
    if (unread.length) {
      const batch = db.batch();
      const readAt = Date.now();
      unread.forEach(doc => batch.set(doc.ref, { readAt }, { merge:true }));
      await batch.commit();
    }
    res.json({ ok:true, updated:unread.length });
  } catch (err) {
    console.error(err);
    res.status(400).json({ ok:false, message:err?.message || '無法更新已讀狀態' });
  }
});

app.get('/api/private/unread', async (req,res) => {
  try {
    const me = privateIdentity(req.query.employeeId, req.query.name);
    const myKey = identityKey(me.employeeNo, me.name);
    const snap = await db.collection('privateMessages')
      .where('participantKeys','array-contains',myKey).limit(1000).get();
    const count = snap.docs.reduce((n,doc) => {
      const x = doc.data() || {};
      return n + (clean(x.receiverKey) === myKey && !Number(x.readAt || 0) && !x.recalled ? 1 : 0);
    }, 0);
    res.json({ ok:true, count });
  } catch (err) {
    console.error(err);
    res.status(400).json({ ok:false, message:err?.message || '無法讀取未讀數量' });
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(400).json({ ok:false, message:'請求無法處理' });
});

app.listen(PORT, () => console.log(`Heremay Passkey service listening on ${PORT}`));
