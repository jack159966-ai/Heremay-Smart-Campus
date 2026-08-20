import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
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
const RP_NAME = process.env.RP_NAME || '和美智慧校園';
const RP_ID = process.env.RP_ID || 'jack159966-ai.github.io';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://jack159966-ai.github.io')
  .split(',').map(v => v.trim()).filter(Boolean);
const LOGIN_SHEET_ID = process.env.LOGIN_SHEET_ID || '1qF7NhSzpg5MAskTEXSWPt1Z__jGfbEdF8Gr5AUBmFYQ';
const LOGIN_SHEET_TAB = process.env.LOGIN_SHEET_TAB || '員工登入資料';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
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

function roleFromHome(home, category) {
  const h = clean(home);
  if (h === '管理首頁') return 'admin';
  if (h === '中階主管首頁') return 'leader';
  if (h === '教保首頁') return 'teacher';
  if (h === '庶務首頁') return 'support';
  const c = clean(category);
  if (c === '管理層') return 'admin';
  if (c === '庶務人員') return 'support';
  if (c === '教保人員') return 'teacher';
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

app.get('/health', (_req,res) => res.json({ ok:true, service:'heremay-passkey' }));

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

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(400).json({ ok:false, message:'請求無法處理' });
});

app.listen(PORT, () => console.log(`Heremay Passkey service listening on ${PORT}`));
