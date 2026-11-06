// content.js - 港台用語轉換主邏輯

(function () {
  'use strict';

  // 預設啟用
  let isEnabled = true;

  // 避免重複處理的標記
  const PROCESSED_ATTR = 'data-hk2tw-processed';

  // 白名單（依長度降序，長詞優先保護）
  const sortedWhitelist = (typeof HK2TW_WHITELIST !== 'undefined')
    ? [...HK2TW_WHITELIST].sort((a, b) => b.length - a.length)
    : [];

  // 白名單首字集合（快篩用）
  const whitelistFirstChars = new Set(sortedWhitelist.map(w => w[0]));

  // 建立詞庫快取（依詞彙長度降序排列，避免短詞蓋過長詞）
  const sortedDict = [...HK2TW_DICTIONARY].sort((a, b) => b.hk.length - a.hk.length);

  // 【單次掃描索引】首字 → 以該字開頭的詞條（長詞優先）
  // 轉換時逐字掃描原文、每個位置只取最長命中，轉換結果不會再被其他詞條二次轉換，
  // 避免「紙巾→面紙→臉紙」這類連鎖誤轉。
  const dictIndex = new Map();
  for (const entry of sortedDict) {
    const first = entry.hk[0];
    if (!dictIndex.has(first)) dictIndex.set(first, []);
    dictIndex.get(first).push(entry);
  }

  // 粗話詞庫（依長度降序）
  const sortedProfanity = (typeof HK2TW_PROFANITY !== 'undefined')
    ? [...HK2TW_PROFANITY].sort((a, b) => b.hk.length - a.hk.length)
    : [];

  // 【效能優化】字典首字集合：文字節點若不含任何首字，直接跳過整個詞庫掃描
  const dictFirstChars = new Set(sortedDict.map(e => e.hk[0]));
  const profFirstChars = new Set(sortedProfanity.map(e => e.hk[0]));

  // 【粵語語境閘】只在粵語中出現、幾乎不見於國語書面文的字。
  // 文字節點含任一標記字才視為粵語語境；標了 ctx: true 的詞條（國語亦常用、
  // 意思不同的詞，如「地下」「項目」「人工」）只在粵語語境下轉換，
  // 避免把台灣中文網頁改壞。
  const CANTO_MARKERS = new Set([...'唔咗嘅喺佢啲嘢冇乜咁嗰嚟睇俾畀搵揾噉㗎喎咩啱攞瞓諗哋嬲啫']);
  // 無單字標記、但幾乎只出現在粵語的詞（亦視為粵語語境）
  const CANTO_WORD_RE = /屋企|返工|放工|出糧|的士|邊度|邊個|點解|點樣|幾時|聽日|尋日|琴日|而家|依家|鍾意|傾計|傾偈|埋單|細路|老豆|老細|紅van/;
  function isCantoText(str) {
    return hasAnyChar(str, CANTO_MARKERS) || CANTO_WORD_RE.test(str);
  }

  // 【效能A】零記憶體首字快篩：用 for 迴圈取代 [...text].some() 避免陣列展開
  function hasAnyChar(str, charSet) {
    for (let i = 0; i < str.length; i++) {
      if (charSet.has(str[i])) return true;
    }
    return false;
  }

  // 不需要替換的標籤
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'TEXTAREA',
    'INPUT', 'SELECT', 'BUTTON', 'CODE', 'PRE', 'KBD', 'SAMP'
  ]);

  // 判斷是否為輸入區塊（input / textarea / contenteditable / ARIA 文字框）
  function isInputArea(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    const tag = node.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (node.isContentEditable) return true;
    const role = node.getAttribute('role');
    if (role === 'textbox' || role === 'searchbox' || role === 'combobox') return true;
    return false;
  }

  // 判斷節點是否位於輸入區塊內
  function isInsideInputArea(node) {
    let current = node;
    while (current) {
      if (isInputArea(current)) return true;
      current = current.parentNode;
    }
    return false;
  }

  /**
   * 替換單一文字節點的內容
   * 若包含粗話詞條，拆成多段並插入灰色 [粗話] span
   */
  // 【安全規則】判斷字串是否含有中文字元（CJK 統一漢字區段）
  // 純英文、純數字、純符號的節點一律跳過，避免誤轉換英文詞彙
  function hasChinese(str) {
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      if (
        (code >= 0x4E00 && code <= 0x9FFF) || // CJK 基本漢字
        (code >= 0x3400 && code <= 0x4DBF) || // CJK 擴充A
        (code >= 0x20000 && code <= 0x2A6DF) || // CJK 擴充B
        (code >= 0xF900 && code <= 0xFAFF) || // CJK 相容漢字
        (code >= 0x3000 && code <= 0x303F) || // CJK 符號與標點
        (code >= 0x31C0 && code <= 0x31EF) || // CJK 筆畫
        (code >= 0xFF00 && code <= 0xFFEF)    // 全形字元
      ) return true;
    }
    return false;
  }

  /**
   * 詞庫轉換核心（純函式）：單次掃描、每個位置取最長命中
   * @param {string} text  原始文字
   * @param {boolean} isCanto  是否為粵語語境（決定 ctx 詞條是否生效）
   * @returns {string} 轉換後文字（無變化時回傳原字串）
   */
  function convertDictText(text, isCanto) {
    // 【效能A】首字快篩：文字不含任何詞條首字則直接略過
    if (!hasAnyChar(text, dictFirstChars)) return text;

    // 【白名單保護】找出所有白名單詞條的位置，轉換時跳過這些範圍
    const protectedRanges = [];
    if (sortedWhitelist.length > 0 && hasAnyChar(text, whitelistFirstChars)) {
      for (const w of sortedWhitelist) {
        let pos = 0;
        while ((pos = text.indexOf(w, pos)) !== -1) {
          protectedRanges.push([pos, pos + w.length]);
          pos += w.length;
        }
      }
    }
    // 與白名單範圍重疊即視為受保護；但若詞條「嚴格涵蓋」整個白名單詞
    // （例如「冇關係」涵蓋白名單的「關係」），代表詞條更具體，予以放行。
    const isProtected = (start, end) => {
      for (let i = 0; i < protectedRanges.length; i++) {
        const r = protectedRanges[i];
        if (start < r[1] && end > r[0]) {
          const coversStrictly = start <= r[0] && end >= r[1] && (end - start) > (r[1] - r[0]);
          if (!coversStrictly) return true;
        }
      }
      return false;
    };

    let result = '';
    let changed = false;
    let i = 0;
    const len = text.length;
    while (i < len) {
      const candidates = dictIndex.get(text[i]);
      let matched = null;
      if (candidates) {
        for (let c = 0; c < candidates.length; c++) {
          const entry = candidates[c];
          if (entry.ctx && !isCanto) continue;
          if (!text.startsWith(entry.hk, i)) continue;
          if (protectedRanges.length > 0 && isProtected(i, i + entry.hk.length)) continue;
          matched = entry;
          break; // candidates 已依長度降序，首個命中即最長
        }
      }
      if (matched) {
        result += matched.tw;
        i += matched.hk.length;
        changed = true;
      } else {
        result += text[i];
        i++;
      }
    }
    return changed ? result : text;
  }

  function replaceTextNode(node) {
    const text = node.nodeValue;
    if (!text || !text.trim()) return;

    // 【安全規則】純英文／純數字／純符號節點直接跳過，不做任何轉換
    if (!hasChinese(text)) return;

    // 記錄原始文字，供停用時還原
    if (node.__hk2tw_original === undefined) {
      node.__hk2tw_original = text;
    }

    // 【粵語語境閘】以原文判斷一次，詞庫與粗話兩段共用
    const isCanto = isCantoText(text);

    const converted = convertDictText(text, isCanto);
    if (converted !== text) node.nodeValue = converted;

    // 檢查粗話詞庫（需要插入 span，故要操作 DOM）
    if (sortedProfanity.length === 0) return;
    // 【效能A】用 hasAnyChar 取代 [...text].some()
    const hasProfChar = hasAnyChar(node.nodeValue, profFirstChars);
    if (!hasProfChar) return;

    // 【效能C】預建所有命中位置，一次排序後線性處理，避免 O(n²) 內層迴圈
    const currentText = node.nodeValue;
    const hits = [];
    for (const { hk, tw, ctx } of sortedProfanity) {
      if (ctx && !isCanto) continue;
      if (!currentText.includes(hk)) continue;
      let pos = 0, idx;
      while ((idx = currentText.indexOf(hk, pos)) !== -1) {
        hits.push({ idx, len: hk.length, tw, hk });
        pos = idx + hk.length;
      }
    }
    if (hits.length === 0) return;

    // 按位置排序，去除重疊（後項 idx < 前項結束點則跳過）
    hits.sort((a, b) => a.idx - b.idx);

    const parent = node.parentNode;
    if (!parent) return;

    const fragment = document.createDocumentFragment();
    let cursor = 0;
    let foundAny = false;
    for (const { idx, len, tw, hk } of hits) {
      if (idx < cursor) continue; // 跳過與前一命中重疊的詞
      if (idx > cursor) {
        fragment.appendChild(document.createTextNode(currentText.slice(cursor, idx)));
      }
      const span = document.createElement('span');
      span.setAttribute('title', tw);
      span.setAttribute('data-hk2tw-profanity', '1');
      span.setAttribute('data-hk2tw-hk', hk);
      span.style.cssText = 'color:#999;font-size:0.85em;cursor:help;';
      span.textContent = '[粗話]';
      fragment.appendChild(span);
      cursor = idx + len;
      foundAny = true;
    }
    if (cursor < currentText.length) {
      fragment.appendChild(document.createTextNode(currentText.slice(cursor)));
    }
    if (foundAny) {
      const wrapper = document.createElement('span');
      wrapper.setAttribute('data-hk2tw-profanity-wrapper', '1');
      wrapper.setAttribute('data-hk2tw-original-text', node.__hk2tw_original || node.nodeValue);
      wrapper.appendChild(fragment);
      parent.replaceChild(wrapper, node);
    }
  }

  /**
   * 【效能優化】迭代式走訪 DOM（取代遞迴，避免深層 DOM stack overflow）
   */
  function walkNode(root) {
    if (!isEnabled) return;
    const stack = [root];
    while (stack.length > 0) {
      const node = stack.pop();
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (SKIP_TAGS.has(node.tagName)) continue;
        if (isInputArea(node)) continue;
        if (node.hasAttribute(PROCESSED_ATTR)) continue;
        node.setAttribute(PROCESSED_ATTR, '1');
        for (let i = node.childNodes.length - 1; i >= 0; i--) {
          stack.push(node.childNodes[i]);
        }
      } else if (node.nodeType === Node.TEXT_NODE) {
        if (isInsideInputArea(node)) continue;
        replaceTextNode(node);
      }
    }
  }

  /**
   * 初始執行替換
   */
  function runConversion() {
    if (!isEnabled) return;
    walkNode(document.body);
  }

  /**
   * 【效能優化】MutationObserver + rAF debounce
   * SPA 大量 DOM 更新時合併至同一 frame 處理，避免連續觸發
   */
  let pendingNodes = [];
  let rafId = null;

  function flushPendingNodes() {
    rafId = null;
    const nodes = pendingNodes;
    pendingNodes = [];
    for (const node of nodes) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (isInputArea(node)) continue;
        walkNode(node);
      } else if (node.nodeType === Node.TEXT_NODE) {
        if (isInsideInputArea(node)) continue;
        replaceTextNode(node);
      }
    }
  }

  const observer = new MutationObserver((mutations) => {
    if (!isEnabled) return;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (isInsideInputArea(node)) continue;
        pendingNodes.push(node);
      }
    }
    if (!rafId) {
      rafId = requestAnimationFrame(flushPendingNodes);
    }
  });

  function startObserver() {
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  function stopObserver() {
    observer.disconnect();
  }

  /**
   * 還原已轉換內容
   */
  function revertDictionaryChanges() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    let node;
    while ((node = walker.nextNode()) !== null) {
      if (node.__hk2tw_original !== undefined) {
        node.nodeValue = node.__hk2tw_original;
        delete node.__hk2tw_original;
      }
    }
  }

  function revertProfanityChanges() {
    const wrappers = document.querySelectorAll('[data-hk2tw-profanity-wrapper]');
    wrappers.forEach((wrapper) => {
      const originalText = wrapper.getAttribute('data-hk2tw-original-text');
      const textNode = document.createTextNode(originalText);
      wrapper.parentNode.replaceChild(textNode, wrapper);
    });
  }

  function clearProcessedMarkers() {
    document.querySelectorAll(`[${PROCESSED_ATTR}]`).forEach((el) => el.removeAttribute(PROCESSED_ATTR));
  }

  /**
   * 接收來自 background 的開關訊息
   */
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // 【安全】僅接受來自本擴充功能自身的訊息，忽略其他來源
    if (sender.id !== chrome.runtime.id) return;
    if (message.action === 'toggle') {
      isEnabled = message.enabled;
      if (isEnabled) {
        clearProcessedMarkers();
        runConversion();
        startObserver();
      } else {
        stopObserver();
        revertDictionaryChanges();
        revertProfanityChanges();
        clearProcessedMarkers();
      }
      sendResponse({ status: 'ok' });
    } else if (message.action === 'getStatus') {
      sendResponse({ enabled: isEnabled });
    }
    return true;
  });

  /**
   * 從 storage 讀取啟用狀態後執行
   */
  chrome.storage.sync.get(['hk2tw_enabled'], (result) => {
    isEnabled = result.hk2tw_enabled !== false; // 預設啟用
    if (isEnabled) {
      runConversion();
      startObserver();
    }
  });

  // 測試掛鉤：僅在 Node 測試環境（事先定義 __HK2TW_TEST__）下暴露純函式；網頁無法觸及
  if (typeof globalThis !== 'undefined' && globalThis.__HK2TW_TEST__ && typeof globalThis.__HK2TW_TEST__ === 'object') {
    globalThis.__HK2TW_TEST__.convertDictText = convertDictText;
    globalThis.__HK2TW_TEST__.isCantoText = isCantoText;
  }

})();
