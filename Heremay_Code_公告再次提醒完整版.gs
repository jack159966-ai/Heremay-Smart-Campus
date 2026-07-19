const SPREADSHEET_ID = '1qF7NhSzpg5MAskTEXSWPt1Z__jGfbEdF8Gr5AUBmFYQ';
const SHEET_NAME = '員工登入資料';
const ACK_SHEET_NAME = '公告確認紀錄';
const REMINDER_SHEET_NAME = '公告再次提醒紀錄';

function doGet() {
  return HtmlService
    .createHtmlOutput(`
      <!doctype html>
      <html lang="zh-Hant">
      <head><meta charset="UTF-8"></head>
      <body style="font-family:sans-serif;padding:24px">
        和美智慧校園登入、公告確認與再次提醒服務正常
      </body>
      </html>
    `)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doPost(e) {
  try {
    const request = e && e.parameter ? e.parameter : {};
    const action = String(request.action || 'login').trim();

    if (action === 'ackNotice') {
      return handleAckNotice(request);
    }

    if (action === 'getAckRecords') {
      return handleGetAckRecords(request);
    }

    if (action === 'remindUnconfirmed') {
      return handleRemindUnconfirmed(request);
    }

    if (action === 'getReminderRecords') {
      return handleGetReminderRecords(request);
    }

    return handleLogin(request);

  } catch (error) {
    console.error(error);

    return iframeResponse(
      {
        ok: false,
        message: '服務暫時發生錯誤'
      },
      'HEREMAY_SERVICE_RESULT'
    );
  }
}


/* =========================
   登入驗證
========================= */

function handleLogin(request) {
  const account = String(request.account || '').trim().toLowerCase();
  const password = String(request.password || '');

  if (!account || !password) {
    return iframeResponse(
      {
        ok: false,
        message: '請輸入帳號與密碼'
      },
      'HEREMAY_LOGIN_RESULT'
    );
  }

  const sheet = SpreadsheetApp
    .openById(SPREADSHEET_ID)
    .getSheetByName(SHEET_NAME);

  if (!sheet) {
    throw new Error(`找不到工作表：${SHEET_NAME}`);
  }

  const values = sheet.getDataRange().getDisplayValues();

  if (values.length < 2) {
    return iframeResponse(
      {
        ok: false,
        message: '員工登入資料尚未建立'
      },
      'HEREMAY_LOGIN_RESULT'
    );
  }

  const headers = values[0].map(value => String(value).trim());

  const column = {
    employeeId: headers.indexOf('員工編號'),
    name: headers.indexOf('姓名'),
    account: headers.indexOf('登入帳號'),
    jobTitle: headers.indexOf('職稱'),
    identity: headers.indexOf('身分類別'),
    group: headers.indexOf('編組'),
    homeType: headers.indexOf('首頁類型'),
    enabled: headers.indexOf('是否可登入'),
    password: headers.indexOf('臨時密碼')
  };

  const missingHeaders = Object.entries(column)
    .filter(([, index]) => index === -1)
    .map(([name]) => name);

  if (missingHeaders.length) {
    throw new Error('登入資料表欄位不完整');
  }

  for (let rowIndex = 1; rowIndex < values.length; rowIndex++) {
    const row = values[rowIndex];

    const savedAccount = String(row[column.account] || '')
      .trim()
      .toLowerCase();

    if (savedAccount !== account) continue;

    const canLogin = String(row[column.enabled] || '').trim();

    if (canLogin !== '是') {
      return iframeResponse(
        {
          ok: false,
          message: '這個帳號目前未開放登入'
        },
        'HEREMAY_LOGIN_RESULT'
      );
    }

    const savedPassword = String(row[column.password] || '');

    if (!savedPassword || savedPassword !== password) {
      return iframeResponse(
        {
          ok: false,
          message: '帳號或密碼錯誤'
        },
        'HEREMAY_LOGIN_RESULT'
      );
    }

    return iframeResponse(
      {
        ok: true,
        role: roleFromHomeType(row[column.homeType]),
        employee: {
          employeeId: row[column.employeeId],
          name: row[column.name],
          account: row[column.account],
          jobTitle: row[column.jobTitle],
          identity: row[column.identity],
          group: row[column.group],
          homeType: row[column.homeType]
        }
      },
      'HEREMAY_LOGIN_RESULT'
    );
  }

  return iframeResponse(
    {
      ok: false,
      message: '帳號或密碼錯誤'
    },
    'HEREMAY_LOGIN_RESULT'
  );
}


/* =========================
   公告「我已收到」
========================= */

function handleAckNotice(request) {
  const noticeId = String(request.noticeId || '').trim();
  const noticeTitle = String(request.noticeTitle || '').trim();
  const employeeId = String(request.employeeId || '').trim();
  const employeeName = String(request.employeeName || '').trim();
  const account = String(request.account || '').trim().toLowerCase();

  if (!noticeId || !employeeName) {
    return iframeResponse(
      {
        ok: false,
        message: '缺少公告或登入者資料'
      },
      'HEREMAY_ACK_RESULT'
    );
  }

  const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = getOrCreateAckSheet(spreadsheet);

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const values = sheet.getDataRange().getDisplayValues();
    let existingRow = 0;

    for (let rowIndex = 1; rowIndex < values.length; rowIndex++) {
      const rowNoticeId = String(values[rowIndex][1] || '').trim();
      const rowEmployeeId = String(values[rowIndex][3] || '').trim();
      const rowEmployeeName = String(values[rowIndex][4] || '').trim();

      const sameEmployee = employeeId
        ? rowEmployeeId === employeeId
        : rowEmployeeName === employeeName;

      if (rowNoticeId === noticeId && sameEmployee) {
        existingRow = rowIndex + 1;
        break;
      }
    }

    if (!existingRow) {
      sheet.appendRow([
        new Date(),
        noticeId,
        noticeTitle,
        employeeId,
        employeeName,
        account
      ]);
    }

    const ackCount = countNoticeAcknowledgements(sheet, noticeId);

    return iframeResponse(
      {
        ok: true,
        alreadyRecorded: Boolean(existingRow),
        noticeId: noticeId,
        employeeName: employeeName,
        ackCount: ackCount,
        message: existingRow
          ? '您已經確認過這則公告'
          : '已確認收到'
      },
      'HEREMAY_ACK_RESULT'
    );

  } finally {
    lock.releaseLock();
  }
}


/* =========================
   主管讀取公告確認紀錄
========================= */

function handleGetAckRecords(request) {
  const noticePrefix = String(request.noticePrefix || '').trim();

  const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  const employeeSheet = spreadsheet.getSheetByName(SHEET_NAME);
  const ackSheet = spreadsheet.getSheetByName(ACK_SHEET_NAME);

  if (!employeeSheet) {
    throw new Error(`找不到工作表：${SHEET_NAME}`);
  }

  const employees = readEnabledEmployees(employeeSheet);
  const records = ackSheet
    ? readAckRecords(ackSheet, noticePrefix)
    : [];

  const notices = {};

  records.forEach(record => {
    if (!notices[record.noticeId]) {
      notices[record.noticeId] = {
        noticeId: record.noticeId,
        noticeTitle: record.noticeTitle,
        records: []
      };
    }

    notices[record.noticeId].records.push(record);
  });

  return iframeResponse(
    {
      ok: true,
      employees: employees,
      records: records,
      notices: Object.values(notices)
    },
    'HEREMAY_ACK_RECORDS_RESULT'
  );
}


/* =========================
   主管再次提醒未確認人員
========================= */

function handleRemindUnconfirmed(request) {
  const noticeId = String(request.noticeId || '').trim();
  const noticeTitle = String(request.noticeTitle || '').trim();
  const targetType = String(request.targetType || '').trim();
  const senderName = String(request.senderName || '主管').trim();
  const employeeIds = parseJsonArray(request.employeeIds);
  const employeeNames = parseJsonArray(request.employeeNames);

  if (!noticeId || !noticeTitle) {
    return iframeResponse(
      {
        ok: false,
        message: '缺少公告資料'
      },
      'HEREMAY_REMIND_RESULT'
    );
  }

  if (!employeeIds.length && !employeeNames.length) {
    return iframeResponse(
      {
        ok: false,
        noticeId: noticeId,
        message: '目前沒有人需要再次提醒'
      },
      'HEREMAY_REMIND_RESULT'
    );
  }

  const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = getOrCreateReminderSheet(spreadsheet);
  const reminderBatchId = Utilities.getUuid();
  const now = new Date();
  const total = Math.max(employeeIds.length, employeeNames.length);

  const rows = [];

  for (let index = 0; index < total; index++) {
    rows.push([
      now,
      reminderBatchId,
      noticeId,
      noticeTitle,
      targetType,
      employeeIds[index] || '',
      employeeNames[index] || '',
      senderName,
      '未讀'
    ]);
  }

  if (rows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 9).setValues(rows);
  }

  return iframeResponse(
    {
      ok: true,
      noticeId: noticeId,
      reminderBatchId: reminderBatchId,
      remindedCount: rows.length,
      message: `已再次提醒 ${rows.length} 人`
    },
    'HEREMAY_REMIND_RESULT'
  );
}


/* =========================
   員工讀取自己的再次提醒
========================= */

function handleGetReminderRecords(request) {
  const employeeId = String(request.employeeId || '').trim();
  const employeeName = String(request.employeeName || '').trim();
  const noticePrefix = String(request.noticePrefix || '').trim();

  if (!employeeId && !employeeName) {
    return iframeResponse(
      {
        ok: false,
        message: '缺少登入者資料'
      },
      'HEREMAY_REMINDER_RECORDS_RESULT'
    );
  }

  const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = spreadsheet.getSheetByName(REMINDER_SHEET_NAME);

  const records = sheet
    ? readReminderRecords(sheet, employeeId, employeeName, noticePrefix)
    : [];

  return iframeResponse(
    {
      ok: true,
      records: records
    },
    'HEREMAY_REMINDER_RECORDS_RESULT'
  );
}


/* =========================
   資料讀取工具
========================= */

function readEnabledEmployees(sheet) {
  const values = sheet.getDataRange().getDisplayValues();

  if (values.length < 2) return [];

  const headers = values[0].map(value => String(value).trim());

  const column = {
    employeeId: headers.indexOf('員工編號'),
    name: headers.indexOf('姓名'),
    account: headers.indexOf('登入帳號'),
    jobTitle: headers.indexOf('職稱'),
    identity: headers.indexOf('身分類別'),
    group: headers.indexOf('編組'),
    homeType: headers.indexOf('首頁類型'),
    enabled: headers.indexOf('是否可登入')
  };

  return values
    .slice(1)
    .filter(row => String(row[column.enabled] || '').trim() === '是')
    .map(row => ({
      employeeId: row[column.employeeId] || '',
      name: row[column.name] || '',
      account: row[column.account] || '',
      jobTitle: row[column.jobTitle] || '',
      identity: row[column.identity] || '',
      group: row[column.group] || '',
      homeType: row[column.homeType] || ''
    }))
    .filter(employee => employee.name);
}

function readAckRecords(sheet, noticePrefix) {
  const values = sheet.getDataRange().getDisplayValues();

  if (values.length < 2) return [];

  return values
    .slice(1)
    .map(row => ({
      confirmedAt: row[0] || '',
      noticeId: String(row[1] || '').trim(),
      noticeTitle: row[2] || '',
      employeeId: row[3] || '',
      employeeName: row[4] || '',
      account: row[5] || ''
    }))
    .filter(record =>
      record.noticeId &&
      (!noticePrefix || record.noticeId.indexOf(noticePrefix) === 0)
    );
}

function readReminderRecords(sheet, employeeId, employeeName, noticePrefix) {
  const values = sheet.getDataRange().getDisplayValues();

  if (values.length < 2) return [];

  return values
    .slice(1)
    .map(row => ({
      remindedAt: row[0] || '',
      reminderBatchId: row[1] || '',
      noticeId: String(row[2] || '').trim(),
      noticeTitle: row[3] || '',
      targetType: row[4] || '',
      employeeId: row[5] || '',
      employeeName: row[6] || '',
      senderName: row[7] || '',
      status: row[8] || ''
    }))
    .filter(record => {
      const sameEmployee = employeeId
        ? record.employeeId === employeeId
        : record.employeeName === employeeName;

      const samePrefix = !noticePrefix ||
        record.noticeId.indexOf(noticePrefix) === 0;

      return sameEmployee && samePrefix;
    });
}


/* =========================
   試算表工具
========================= */

function getOrCreateAckSheet(spreadsheet) {
  let sheet = spreadsheet.getSheetByName(ACK_SHEET_NAME);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(ACK_SHEET_NAME);

    sheet.getRange(1, 1, 1, 6).setValues([[
      '確認時間',
      '公告編號',
      '公告標題',
      '員工編號',
      '姓名',
      '登入帳號'
    ]]);

    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, 6);
  }

  return sheet;
}

function getOrCreateReminderSheet(spreadsheet) {
  let sheet = spreadsheet.getSheetByName(REMINDER_SHEET_NAME);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(REMINDER_SHEET_NAME);

    sheet.getRange(1, 1, 1, 9).setValues([[
      '提醒時間',
      '提醒批次編號',
      '公告編號',
      '公告標題',
      '對象類型',
      '員工編號',
      '姓名',
      '提醒人',
      '狀態'
    ]]);

    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, 9);
  }

  return sheet;
}

function countNoticeAcknowledgements(sheet, noticeId) {
  const values = sheet.getDataRange().getDisplayValues();
  let count = 0;

  for (let rowIndex = 1; rowIndex < values.length; rowIndex++) {
    if (String(values[rowIndex][1] || '').trim() === noticeId) {
      count++;
    }
  }

  return count;
}


/* =========================
   共用功能
========================= */

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed)
      ? parsed.map(item => String(item || '').trim())
      : [];
  } catch (error) {
    return [];
  }
}

function roleFromHomeType(homeType) {
  const value = String(homeType || '').trim();

  if (value === '管理首頁') return 'admin';
  if (value === '庶務首頁') return 'support';

  return 'teacher';
}

function iframeResponse(data, messageType) {
  const safeJson = JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');

  const safeType = String(messageType || 'HEREMAY_SERVICE_RESULT')
    .replace(/'/g, '');

  return HtmlService
    .createHtmlOutput(`
      <!doctype html>
      <html lang="zh-Hant">
      <head><meta charset="UTF-8"></head>
      <body>
        <script>
          window.top.postMessage(
            {
              type: '${safeType}',
              payload: ${safeJson}
            },
            '*'
          );
        <\/script>
      </body>
      </html>
    `)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function testSpreadsheetAccess() {
  const sheet = SpreadsheetApp
    .openById(SPREADSHEET_ID)
    .getSheetByName(SHEET_NAME);

  Logger.log(sheet.getName());
}
