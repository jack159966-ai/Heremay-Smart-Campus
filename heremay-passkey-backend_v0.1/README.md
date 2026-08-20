# 和美智慧校園｜Passkey 快速登入後端（測試分支用）

這是一個**獨立於現有 Apps Script 帳密登入**的 Passkey / WebAuthn 後端草案。正式 `index.html` 不需先改。

## 為什麼不直接在 Apps Script 裡硬做 WebAuthn
WebAuthn 伺服器端必須安全驗證 challenge、origin、RP ID、authenticator flags 與簽章。Google 官方建議使用成熟的 FIDO server library。此版本採 `@simplewebauthn/server`，避免自己手刻密碼學驗證。

## 資料來源
- 人員與登入資格：既有 Google Sheet `員工登入資料`（唯讀）
- Passkey 公開金鑰、counter、challenge：Google Firestore
- 臉部／指紋資料：**不保存**；只留在使用者手機或其 Passkey provider。

## 預設網站識別
- RP ID：`jack159966-ai.github.io`
- Origin：`https://jack159966-ai.github.io`
- GitHub Pages 路徑可位於 `/Heremay-Smart-Campus/`，RP ID 仍只使用網域主機名。

## 後端 API
- `POST /auth/passkey/register/options`
- `POST /auth/passkey/register/verify`
- `POST /auth/passkey/login/options`
- `POST /auth/passkey/login/verify`
- `GET /health`

## Cloud Run 必要設定
1. 建立 Google Cloud 專案並啟用 Cloud Run、Firestore、Google Sheets API。
2. 建立 Firestore database。
3. Cloud Run 使用的 service account 必須有 Firestore 讀寫權限。
4. 將 `員工登入資料` Google Sheet 分享給該 service account「檢視者」即可。
5. 設定 `env.example` 內的環境變數。
6. 部署此資料夾。
7. 後端 `/health` 回傳 `ok:true` 後，才修改前端 `index.html`。

## 前端修改原則
- 保留既有 Apps Script 帳號密碼登入，不改它。
- 新增第二個 `PASSKEY_API_BASE`，只供 Passkey 使用。
- Passkey request 改用 `application/json`；舊版 `apiPost(path, body)` 目前忽略 `path` 且會把 credential object 轉成字串，不能直接啟用。
- 首次設定：帳密驗證 -> Passkey 註冊。
- 之後：帳號 -> Face ID / 指紋 / 裝置解鎖 -> 快速登入。

## 安全注意
- 正式 Passkey 僅能在 HTTPS secure context 正常使用。
- 不要把 service-account 私鑰放進 GitHub；Cloud Run 應使用綁定的 service account。
- 不保存 Face ID／指紋影像或模板。
- 若人員被停用，後端每次登入都重新讀取 `是否可登入`，因此 Passkey 不會繞過停權。
