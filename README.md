# 排班系統（Shift Scheduler）

員工用 Google 帳號登入、自行排下個月的班；老闆在單一畫面掌握班表與統計。
全系統採 **Serverless** 架構，部署於 Firebase。

## 系統架構

```
┌──────────────────────────┐        ┌───────────────────────────────────────┐
│ 瀏覽器  Vue 3 + TypeScript │  HTTPS │ Firebase Hosting（靜態網站、CDN）       │
│  ├─ 員工：月曆排班         │◀──────▶│                                       │
│  └─ 老闆：總覽/統計/設定   │        └───────────────────────────────────────┘
└────────────┬─────────────┘
             │ Google 登入 → ID Token（含 custom claim role=boss）
             ▼
┌──────────────────────────┐  callable  ┌──────────────────────────────────┐
│ Firebase Authentication  │──────────▶│ Cloud Functions 2nd gen（asia-east1）│
└──────────────────────────┘            │ saveSchedule / getDashboard /      │
                                        │ addSpecialDay … 所有規則在此驗證   │
             即時讀取（onSnapshot）       └──────────────┬───────────────────┘
             ┌────────────────────────────────────────────┤ transaction 寫入
             ▼                                            ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ Cloud Firestore   allowlist / schedules / dayCounts / specialDays /        │
│                   holidays（國定假日快取）/ settings                         │
│ Security Rules：前端只能讀；唯一可寫的是老闆維護白名單                       │
└───────────────────────────────────────────────────────────────────────────┘
             ▲ 每 7 天更新一次
   政府行政機關辦公日曆（TaiwanCalendar JSON，來源為人事行政總處）
```

### 技術重點

| 需求 | 做法 |
|---|---|
| 只能排下個月 | 由 Cloud Function 以 **Asia/Taipei 時區** 計算，不信任使用者電腦時鐘 |
| 週末 / 國定假日自動判斷 | 抓政府辦公日曆並快取在 Firestore；「補假」自動組成「國慶日補假」等名稱 |
| 每天最多 3 人 | `dayCounts` 文件 + **Firestore transaction**，兩人同時搶最後名額也不會超賣 |
| 每人每月 10～20 天 | 選取時前端即時提示；送出時前後端都檢查，不符合跳出警告且**保留已選日期** |
| 不設草稿 | 送出前的選擇只暫存在員工瀏覽器（localStorage），**不佔名額**，避免有人佔位不送出；關掉頁面再回來會自動恢復 |
| 老闆特殊休假日 | 新增時自動移除當天已排的員工並留下通知，不足 10 天者標示「需補排」 |
| 角色 | 老闆：Firebase Auth **Custom Claims**（`role=boss`）；員工：Firestore 白名單 |
| 防止繞過前端 | Security Rules 禁止前端寫入班表，所有寫入只能經過 Cloud Functions |
| 即時更新 | 員工月曆的 x/3 人數、老闆總覽皆用 `onSnapshot` 即時刷新 |
| 示範模式 | 老闆可模擬「今天」日期，展示其他月份的節日與年度統計 |

### 資料模型

| Collection | 文件 ID | 內容 |
|---|---|---|
| `allowlist` | 小寫 email | `name`, `email`, `createdAt` |
| `schedules` | `YYYY-MM_uid` | `days[]`, `count`, `status`(submitted/needsFix), `year`, `notice` |
| `dayCounts` | `YYYY-MM-DD` | `uids[]`, `count`, `month` |
| `specialDays` | `YYYY-MM-DD` | `reason`, `month`, `createdBy` |
| `holidays` | `YYYY` | `days{date: {isHoliday, name}}`, `fetchedAt` |
| `settings` | `app` | `simulatedToday` |

## 專案結構

```
functions/src/rules.ts       排班規則（純函式，有單元測試）
functions/src/index.ts       Cloud Functions（callable API）
firestore.rules              安全規則
web/src/views/               登入 / 員工排班 / 老闆頁面
web/src/components/boss/     班表總覽、特殊休假日、白名單、示範模式
scripts/set-role.mjs         設定老闆角色（custom claims）
```

## 本機開發（Firebase 模擬器，不需要真的 Firebase 專案）

需求：Node.js 22+、**Java JDK 21+**（模擬器需要）

```bash
npm run install:all     # 安裝所有套件
npm test                # 執行排班規則單元測試
npm run test:e2e        # 模擬器啟動後：43 項整合測試（權限、併發搶名額、特殊日…，會清空模擬器資料）
npm run emulators       # 終端機 1：啟動 Auth / Firestore / Functions 模擬器
npm run dev             # 終端機 2：啟動前端 http://localhost:5173
```

1. 開 http://localhost:5173 用模擬器的 Google 登入，新增一個老闆帳號（例如 `boss@example.com`）
2. 設定老闆角色：`npm run set-role -- boss@example.com --emulator`，然後登出再登入
3. 老闆在「員工白名單」加入員工 email，員工即可登入排班
4. 模擬器 UI：http://localhost:4000

### 一鍵建立示範資料（面試展示用）

```bash
npm run seed:demo       # 模擬器啟動後執行；會先清空模擬器資料
```

建立老闆 `boss@example.com` 與 4 位員工（模擬器的 Google 登入視窗直接點選帳號即可），
今年已過去月份的歷史班表（年度統計用），開放月份 3 人已送出、`yating@example.com` 尚未排班（可現場示範送出），
以及一天「尾牙」特殊休假日。資料固定，每次執行結果相同。

## 部署到 Firebase

1. 到 [Firebase Console](https://console.firebase.google.com/) 建立專案
   - 升級 **Blaze 方案**（Cloud Functions 需要），建議到 Google Cloud Billing 設定預算警示
   - Authentication → 登入方式 → 啟用 **Google**
   - Firestore Database → 建立資料庫，位置選 **asia-east1（台灣）**
   - 專案設定 → 新增網頁應用程式，取得設定值
2. 本機設定
   ```bash
   npx firebase login
   npx firebase use --add          # 選擇剛建立的專案，alias 設為 default
   cp web/.env.example web/.env.production.local   # 填入 Firebase 設定值，VITE_USE_EMULATORS=false
   ```
3. 部署：`npm run deploy`
4. 設定老闆：
   - 用老闆的 Google 帳號登入網站一次
   - Firebase Console → 專案設定 → 服務帳戶 → 產生新的私密金鑰，存成 `scripts/keys/service-account.json`（已在 .gitignore）
   - `GOOGLE_APPLICATION_CREDENTIALS=scripts/keys/service-account.json npm run set-role -- 老闆@gmail.com`
   - 老闆登出再登入
5. 若使用自訂網域，記得加到 Authentication → 設定 → 授權網域
