# 港台翻譯機 — 安全審計報告

**審計日期**: 2026-07-11
**最後更新**: 2026-07-11（已套用強化建議 1、2 並通過驗證）
**審計範圍**: Chrome 擴充功能 (Manifest V3) — `manifest.json`、`background.js`、`content.js`、`dictionary.js`、`profanity.js`、`whitelist.js`、`privacy.html`
**整體嚴重程度**: 低（無高風險漏洞）

---

## 執行摘要

本擴充功能為 **純本機運作** 的網頁用語轉換工具，不含後端伺服器、不發出任何網路請求、不使用任何密鑰或認證機制。針對常見 Web 漏洞（弱密鑰、SQL 注入、CORS、敏感資訊外洩、認證缺失）的檢查大多 **不適用**；審計重點放在擴充功能專屬的攻擊面（權限範圍、內容腳本 DOM 注入、XSS、跨腳本訊息通道）。

| 類別 | 結果 |
|------|------|
| 高風險漏洞 | **0** |
| 中風險問題 | **0** |
| 低風險 / 強化建議 | **3**（其中 2 項已修復，1 項僅記錄） |

**結論：可安全上架與使用。** 最小權限與縱深防禦的強化建議 1、2 已於本次審計套用並通過驗證。

---

## 已檢查且通過（未發現問題）

### 1. XSS / DOM 注入（重點項目）✅
內容腳本會改寫任意網頁的文字，此為主要攻擊面。檢查結果：
- 詞彙轉換透過 `node.nodeValue = text`（`content.js:167`）與 `document.createTextNode(...)`，屬 **純文字寫入**，瀏覽器不會將內容當作 HTML 解析。
- 粗話標記透過 `span.textContent = '[粗話]'`（`content.js:208`）建立，非 `innerHTML`。
- 全專案 **未使用** `innerHTML` / `outerHTML` / `insertAdjacentHTML` / `document.write` / `eval` / `new Function`（已 grep 驗證，零命中）。
- **判定：無 XSS 注入風險。**

### 2. 網路連線與資料外洩 ✅
- 未使用 `fetch` / `XMLHttpRequest` / WebSocket / 動態 `.src` 設定（已 grep 驗證，零命中）。
- 詞庫（`dictionary.js` / `profanity.js` / `whitelist.js`）為靜態本機資料，不含遠端端點。
- 與 `privacy.html` 宣稱的「完全離線、不收集資料」**一致**。

### 3. 密鑰 / 認證 / 注入 ✅
- 無 JWT / Session / API Key / 密碼等機敏資料，無弱默認密鑰問題。
- 無資料庫、無 SQL，無注入面。
- 無 CORS 設定需求（無伺服器）。

### 4. 儲存安全 ✅
- 僅以 `chrome.storage.sync` 儲存單一布林開關 `hk2tw_enabled`（`background.js`、`content.js:355`），無機敏資料。

### 5. 跨腳本訊息通道 ✅
- `chrome.runtime.onMessage`（`content.js:332`）僅處理 `toggle` / `getStatus`，payload 僅一個布林值，無程式碼執行路徑。
- manifest 未設定 `externally_connectable`，故 **一般網頁無法** 對本擴充功能送訊息，僅擴充功能自身元件可通訊。風險極低。

---

## 低風險 / 強化建議

### ✅ 建議 1 —（低）`activeTab` 權限冗餘，可移除 —— **已修復**
`manifest.json` 原同時宣告 `activeTab` 與 `host_permissions: <all_urls>`。內容腳本已透過 `content_scripts` + `host_permissions: <all_urls>` 在所有頁面注入，`activeTab` 對本功能並無實際作用。

**已套用修復**（`manifest.json:28`）：
```json
"permissions": ["storage"],
"host_permissions": ["<all_urls>"]
```
> 驗證：`background.js` 的 `chrome.tabs.sendMessage` 依賴 `host_permissions: <all_urls>`（與 `activeTab` 無關），圖示點擊切換的訊息通道經功能測試確認正常。
> 註：`<all_urls>` 為功能所必需（需在任意網站轉換用語），屬合理寬權限，且 `privacy.html` 第 6 條已明確說明用途，無需變更。

### ✅ 建議 2 —（低）訊息監聽加上來源檢查（縱深防禦）—— **已修復**
`content.js` 的 `onMessage` 原未驗證 `sender`。雖因無 `externally_connectable` 而無實質風險，仍加固之。

**已套用修復**（`content.js:333`）：
```js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 【安全】僅接受來自本擴充功能自身的訊息，忽略其他來源
  if (sender.id !== chrome.runtime.id) return;
  ...
});
```
> 驗證：以 stub 環境載入 `content.js` 實測——合法自身訊息（`sender.id === chrome.runtime.id`）`getStatus` / `toggle` 正常回應；外部來源訊息被守衛擋下，`sendResponse` 未被呼叫。

### 建議 3 —（低）還原機制信任頁面既有屬性 —— **僅記錄，無需修復**
`revertProfanityChanges()`（`content.js:316`）以 `querySelectorAll('[data-hk2tw-profanity-wrapper]')` 掃描全頁，並讀取 `data-hk2tw-original-text` 還原。惡意頁面理論上可預先植入此屬性——但因還原僅透過 `createTextNode` 產生 **純文字節點**，不會造成 XSS，最壞情況僅為顯示文字被替換。**無安全危害**，此處僅作記錄。

---

## 部署前必須設置的環境變數

**無。** 本擴充功能不依賴任何環境變數、密鑰或伺服器設定。

---

## 結論

港台翻譯機在安全設計上表現良好：遵循 Manifest V3、純本機運作、全程使用安全的純文字 DOM API、無網路請求、無機敏資料、無可執行注入面。**未發現任何高或中風險漏洞。** 3 項低風險強化建議中，建議 1（最小權限）與建議 2（訊息來源檢查）已於本次審計套用並通過驗證，建議 3 經評估無安全危害僅作記錄。目前安全狀態：**良好，可安全上架與使用。**
