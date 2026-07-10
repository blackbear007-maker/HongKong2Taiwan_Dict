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

  // 粗話詞庫（依長度降序）
  const sortedProfanity = (typeof HK2TW_PROFANITY !== 'undefined')
    ? [...HK2TW_PROFANITY].sort((a, b) => b.hk.length - a.hk.length)
    : [];

  // 粗話詞條的 hk 字串集合（用於快速判斷）
  const profanitySet = new Set(sortedProfanity.map(e => e.hk));

  // 【效能優化】字典首字集合：文字節點若不含任何首字，直接跳過整個詞庫掃描
  const dictFirstChars = new Set(sortedDict.map(e => e.hk[0]));
  const profFirstChars = new Set(sortedProfanity.map(e => e.hk[0]));

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

  function replaceTextNode(node) {
    let text = node.nodeValue;
    if (!text || !text.trim()) return;

    // 【安全規則】純英文／純數字／純符號節點直接跳過，不做任何轉換
    if (!hasChinese(text)) return;

    // 記錄原始文字，供停用時還原
    if (node.__hk2tw_original === undefined) {
      node.__hk2tw_original = text;
    }

    // 【白名單保護】先找出文字中所有白名單詞條的位置，轉換時跳過這些範圍
    // 【效能A】用 hasAnyChar 取代 [...text].some() 避免陣列展開
    const hasWhiteChar = sortedWhitelist.length > 0 && hasAnyChar(text, whitelistFirstChars);
    let protectedRanges = [];
    if (hasWhiteChar) {
      for (const w of sortedWhitelist) {
        let pos = 0;
        while ((pos = text.indexOf(w, pos)) !== -1) {
          protectedRanges.push([pos, pos + w.length]);
          pos += w.length;
        }
      }
    }

    // 判斷某位置是否在白名單保護範圍內
    function isProtected(start, end) {
      return protectedRanges.some(([s, e]) => start < e && end > s);
    }

    // 【效能A】首字快篩：用 hasAnyChar 取代 [...text].some()
    const hasDictChar = hasAnyChar(text, dictFirstChars);
    if (hasDictChar) {
      let changed = false;
      for (const { hk, tw } of sortedDict) {
        if (!text.includes(hk)) continue;
        // 逐一比對，跳過白名單保護範圍
        let result = '';
        let remaining2 = text;
        let offset = 0;
        let localChanged = false;
        while (true) {
          const idx = remaining2.indexOf(hk);
          if (idx === -1) { result += remaining2; break; }
          const absStart = offset + idx;
          const absEnd = absStart + hk.length;
          if (isProtected(absStart, absEnd)) {
            result += remaining2.slice(0, idx + hk.length);
            offset += idx + hk.length;
            remaining2 = remaining2.slice(idx + hk.length);
          } else {
            result += remaining2.slice(0, idx) + tw;
            // 【效能B】偏移修正：直接更新保護範圍座標，不重新掃描白名單
            if (protectedRanges.length > 0) {
              const delta = tw.length - hk.length;
              if (delta !== 0) {
                for (let ri = 0; ri < protectedRanges.length; ri++) {
                  const [s, e] = protectedRanges[ri];
                  if (s >= absEnd) {
                    protectedRanges[ri] = [s + delta, e + delta];
                  }
                }
              }
            }
            offset += idx + hk.length;
            remaining2 = remaining2.slice(idx + hk.length);
            localChanged = true;
          }
        }
        if (localChanged) {
          text = result;
          changed = true;
        }
      }
      if (changed) node.nodeValue = text;
    }

    // 檢查粗話詞庫（需要插入 span，故要操作 DOM）
    if (sortedProfanity.length === 0) return;
    // 【效能A】用 hasAnyChar 取代 [...text].some()
    const hasProfChar = hasAnyChar(node.nodeValue, profFirstChars);
    if (!hasProfChar) return;

    // 【效能C】預建所有命中位置，一次排序後線性處理，避免 O(n²) 內層迴圈
    const currentText = node.nodeValue;
    const hits = [];
    for (const { hk, tw } of sortedProfanity) {
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

})();
