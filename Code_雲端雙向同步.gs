const HEADERS = [
  '紀錄編號',
  '巡堂日期',
  '時段',
  '班級',
  '巡堂人員',
  '巡堂結果',
  '缺失代碼',
  '備註',
  '通知對象',
  '照片數量',
  '照片連結',
  '建立時間',
  '最後修改時間',
  '同步狀態'
];

const PHOTO_FOLDER_NAME = '和美智慧校園_巡堂照片';

/**
 * 第一次安裝時執行一次。
 * 功能：
 * 1. 記住目前試算表 ID
 * 2. 建立／取得巡堂照片資料夾
 * 3. 建立欄位標題
 */
function setupSystem() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();

  if (!spreadsheet) {
    throw new Error(
      '找不到目前連結的 Google 試算表。請從試算表的「擴充功能 → Apps Script」開啟本專案。'
    );
  }

  const properties = PropertiesService.getScriptProperties();
  properties.setProperty('SPREADSHEET_ID', spreadsheet.getId());

  const folder = getOrCreatePhotoFolder_();
  properties.setProperty('PHOTO_FOLDER_ID', folder.getId());

  const sheet = spreadsheet.getSheets()[0];
  ensureHeaders_(sheet);

  console.log('系統設定完成');
  console.log('試算表：' + spreadsheet.getName());
  console.log('照片資料夾：' + folder.getName());
  console.log('照片資料夾 ID：' + folder.getId());
}

/**
 * 用瀏覽器開啟部署網址時，顯示系統狀態。
 * 部署網址後面加 ?test=1，可建立或更新一筆測試資料。
 */
function doGet(e) {
  try {
    if (e && e.parameter && e.parameter.action === 'records') {
      const records = getPatrolRecords_(
        e.parameter.from || '',
        e.parameter.to || ''
      );

      return jsonResponse_({
        success: true,
        count: records.length,
        records: records
      });
    }

    if (e && e.parameter && e.parameter.test === '1') {
      const now = new Date();

      const testData = {
        patrolDate: Utilities.formatDate(
          now,
          Session.getScriptTimeZone(),
          'yyyy-MM-dd'
        ),
        session: '測試',
        className: 'TEST',
        patrolPerson: '謝子元',
        result: '同步測試',
        defectCodes: '',
        notes: 'Apps Script 完整版同步測試',
        notifyTargets: '',
        photos: []
      };

      const result = upsertPatrolRecord_(testData);

      return jsonResponse_({
        success: true,
        action: result.action,
        row: result.row,
        message: result.action === 'updated'
          ? '測試資料已更新'
          : '測試資料已新增'
      });
    }

    return jsonResponse_({
      success: true,
      message: '和美智慧校園巡堂同步程式運作正常'
    });

  } catch (error) {
    return errorResponse_(error);
  }
}

/**
 * 接收巡堂網頁送來的資料。
 */
function doPost(e) {
  try {
    const data = parseRequestData_(e);
    const result = upsertPatrolRecord_(data);

    return jsonResponse_({
      success: true,
      recordId: result.recordId,
      action: result.action,
      row: result.row,
      photoCount: result.photoCount,
      photoLinks: result.photoLinks,
      message: result.action === 'updated'
        ? '巡堂紀錄已更新'
        : '巡堂紀錄已新增'
    });

  } catch (error) {
    return errorResponse_(error);
  }
}


/**
 * 讀取雲端試算表中的巡堂紀錄。
 * 可選擇用 from、to（yyyy-MM-dd）限制日期範圍。
 */
function getPatrolRecords_(fromDate, toDate) {
  const sheet = getPatrolSheet_();
  ensureHeaders_(sheet);

  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return [];
  }

  const rows = sheet
    .getRange(2, 1, lastRow - 1, HEADERS.length)
    .getValues();

  const from = normalizeText_(fromDate);
  const to = normalizeText_(toDate);

  return rows
    .map(function(row) {
      const patrolDate = normalizeSheetDate_(row[1]);

      return {
        recordId: normalizeText_(row[0]),
        patrolDate: patrolDate,
        session: normalizeSession_(row[2]),
        className: normalizeText_(row[3]),
        patrolPerson: normalizeText_(row[4]),
        result: normalizeText_(row[5]),
        defectCodes: normalizeText_(row[6]),
        notes: normalizeText_(row[7]),
        notifyTargets: normalizeText_(row[8]),
        photoCount: Number(row[9] || 0),
        photoLinks: normalizeText_(row[10])
          .split(/\r?\n/)
          .map(function(value) {
            return value.trim();
          })
          .filter(Boolean),
        createdAt: formatDateTime_(row[11]),
        updatedAt: formatDateTime_(row[12]),
        syncStatus: normalizeText_(row[13])
      };
    })
    .filter(function(record) {
      if (!record.patrolDate || !record.className) {
        return false;
      }

      if (from && record.patrolDate < from) {
        return false;
      }

      if (to && record.patrolDate > to) {
        return false;
      }

      return true;
    })
    .sort(function(a, b) {
      const keyA = a.patrolDate + '_' + sessionKey_(a.session) + '_' + a.className;
      const keyB = b.patrolDate + '_' + sessionKey_(b.session) + '_' + b.className;
      return keyA.localeCompare(keyB);
    });
}

function formatDateTime_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(
      value,
      Session.getScriptTimeZone(),
      'yyyy-MM-dd HH:mm:ss'
    );
  }

  return normalizeText_(value);
}

/**
 * 接收 payload 或直接 JSON。
 */
function parseRequestData_(e) {
  if (!e) {
    throw new Error('沒有收到資料。');
  }

  if (e.parameter && e.parameter.payload) {
    return JSON.parse(e.parameter.payload);
  }

  if (e.postData && e.postData.contents) {
    return JSON.parse(e.postData.contents);
  }

  throw new Error('收到的資料格式不正確。');
}

/**
 * 新增或更新巡堂紀錄。
 * 同一天、同一時段、同一班級只保留一筆。
 */
function upsertPatrolRecord_(data) {
  const sheet = getPatrolSheet_();
  ensureHeaders_(sheet);

  const now = new Date();
  const patrolDate = normalizeText_(data.patrolDate);
  const session = normalizeSession_(data.session);
  const className = normalizeText_(data.className);

  if (!patrolDate || !session || !className) {
    throw new Error('巡堂日期、時段與班級不可空白。');
  }

  const recordId =
    patrolDate + '_' +
    sessionKey_(session) + '_' +
    className;

  const lastRow = sheet.getLastRow();
  let targetRow = 0;
  let createdAt = now;
  let oldPhotoLinks = '';

  if (lastRow >= 2) {
    const rows = sheet
      .getRange(2, 1, lastRow - 1, HEADERS.length)
      .getValues();

    for (let i = 0; i < rows.length; i++) {
      const rowDate = normalizeSheetDate_(rows[i][1]);
      const rowSession = normalizeSession_(rows[i][2]);
      const rowClass = normalizeText_(rows[i][3]);

      if (
        rowDate === patrolDate &&
        rowSession === session &&
        rowClass === className
      ) {
        targetRow = i + 2;
        createdAt = rows[i][11] || now;
        oldPhotoLinks = normalizeText_(rows[i][10]);
        break;
      }
    }
  }

  const photoResult = savePhotos_(
    data.photos || [],
    patrolDate,
    session,
    className
  );

  const photoLinks = photoResult.links.length
    ? photoResult.links.join('\n')
    : oldPhotoLinks;

  const photoCount = photoResult.links.length
    ? photoResult.links.length
    : Number(data.photoCount || countPhotoLinks_(oldPhotoLinks));

  const rowValues = [[
    recordId,
    patrolDate,
    session,
    className,
    data.patrolPerson || '',
    data.result || '',
    data.defectCodes || '',
    data.notes || '',
    data.notifyTargets || '',
    photoCount,
    photoLinks,
    createdAt,
    now,
    '已同步'
  ]];

  if (targetRow) {
    sheet
      .getRange(targetRow, 1, 1, HEADERS.length)
      .setValues(rowValues);

    SpreadsheetApp.flush();

    return {
      recordId: recordId,
      action: 'updated',
      row: targetRow,
      photoCount: photoCount,
      photoLinks: photoLinks
    };
  }

  const newRow = lastRow + 1;

  sheet
    .getRange(newRow, 1, 1, HEADERS.length)
    .setValues(rowValues);

  SpreadsheetApp.flush();

  return {
    recordId: recordId,
    action: 'created',
    row: newRow,
    photoCount: photoCount,
    photoLinks: photoLinks
  };
}

/**
 * 將 Base64 照片存入 Google Drive。
 * data.photos 預期格式：
 * [
 *   "data:image/jpeg;base64,...",
 *   "data:image/jpeg;base64,..."
 * ]
 */
function savePhotos_(photos, patrolDate, session, className) {
  if (!Array.isArray(photos) || photos.length === 0) {
    return { links: [] };
  }

  const folder = getOrCreatePhotoFolder_();
  const links = [];

  photos.forEach(function(photoData, index) {
    const text = normalizeText_(photoData);

    if (!text || text.indexOf('data:image/') !== 0) {
      return;
    }

    const match = text.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);

    if (!match) {
      return;
    }

    const mimeType = match[1];
    const base64Data = match[2];
    const extension = extensionFromMimeType_(mimeType);
    const bytes = Utilities.base64Decode(base64Data);

    const safeClassName = className.replace(/[\\/:*?"<>|]/g, '_');
    const timestamp = Utilities.formatDate(
      new Date(),
      Session.getScriptTimeZone(),
      'yyyyMMdd_HHmmss'
    );

    const fileName =
      patrolDate.replace(/-/g, '') + '_' +
      sessionKey_(session) + '_' +
      safeClassName + '_' +
      timestamp + '_' +
      (index + 1) + '.' +
      extension;

    const blob = Utilities.newBlob(bytes, mimeType, fileName);
    const file = folder.createFile(blob);

    // 只有知道連結的人可以檢視。
    file.setSharing(
      DriveApp.Access.ANYONE_WITH_LINK,
      DriveApp.Permission.VIEW
    );

    links.push(file.getUrl());
  });

  return { links: links };
}

function extensionFromMimeType_(mimeType) {
  const map = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif'
  };

  return map[mimeType] || 'jpg';
}

function countPhotoLinks_(photoLinks) {
  const text = normalizeText_(photoLinks);

  if (!text) {
    return 0;
  }

  return text
    .split(/\r?\n/)
    .map(function(value) {
      return value.trim();
    })
    .filter(Boolean)
    .length;
}

function getOrCreatePhotoFolder_() {
  const properties = PropertiesService.getScriptProperties();
  const savedFolderId = properties.getProperty('PHOTO_FOLDER_ID');

  if (savedFolderId) {
    try {
      return DriveApp.getFolderById(savedFolderId);
    } catch (error) {
      console.log('原照片資料夾不存在，將重新建立。');
    }
  }

  const folders = DriveApp.getFoldersByName(PHOTO_FOLDER_NAME);
  let folder;

  if (folders.hasNext()) {
    folder = folders.next();
  } else {
    folder = DriveApp.createFolder(PHOTO_FOLDER_NAME);
  }

  properties.setProperty('PHOTO_FOLDER_ID', folder.getId());
  return folder;
}

function normalizeText_(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeSession_(value) {
  const text = normalizeText_(value).toLowerCase();

  if (text === 'morning' || text === '上午') {
    return '上午';
  }

  if (text === 'afternoon' || text === '下午') {
    return '下午';
  }

  return normalizeText_(value);
}

function sessionKey_(session) {
  if (session === '上午') {
    return 'morning';
  }

  if (session === '下午') {
    return 'afternoon';
  }

  return normalizeText_(session);
}

function normalizeSheetDate_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(
      value,
      Session.getScriptTimeZone(),
      'yyyy-MM-dd'
    );
  }

  return normalizeText_(value).replace(/\//g, '-');
}

function getPatrolSheet_() {
  const spreadsheetId = PropertiesService
    .getScriptProperties()
    .getProperty('SPREADSHEET_ID');

  if (!spreadsheetId) {
    throw new Error(
      '尚未完成試算表連結設定。請先在 Apps Script 中執行 setupSystem。'
    );
  }

  const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  return spreadsheet.getSheets()[0];
}

function ensureHeaders_(sheet) {
  const currentHeaders = sheet
    .getRange(1, 1, 1, HEADERS.length)
    .getDisplayValues()[0];

  const headersAreDifferent = HEADERS.some(function(header, index) {
    return currentHeaders[index] !== header;
  });

  if (headersAreDifferent) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, HEADERS.length);
  }
}

function errorResponse_(error) {
  return jsonResponse_({
    success: false,
    message: String(error && error.message ? error.message : error)
  });
}

function jsonResponse_(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
