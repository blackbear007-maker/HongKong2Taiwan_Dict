// background.js - 處理擴充功能圖示點擊切換

'use strict';

// 初始化圖示狀態
chrome.storage.sync.get(['hk2tw_enabled'], (result) => {
  const enabled = result.hk2tw_enabled !== false;
  updateIcon(enabled);
});

// 圖示點擊：直接切換啟用/停用，不彈出 popup
chrome.action.onClicked.addListener(async (tab) => {
  const result = await chrome.storage.sync.get(['hk2tw_enabled']);
  const enabled = result.hk2tw_enabled !== false;
  const newEnabled = !enabled;

  await chrome.storage.sync.set({ hk2tw_enabled: newEnabled });
  updateIcon(newEnabled);

  if (tab && tab.id) {
    chrome.tabs.sendMessage(tab.id, { action: 'toggle', enabled: newEnabled }).catch(() => {
      // 分頁無 content script 時忽略
    });
  }
});

function updateIcon(enabled) {
  if (enabled) {
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setTitle({ title: '港台翻譯機：已啟用' });
  } else {
    chrome.action.setBadgeText({ text: '✕' });
    chrome.action.setBadgeBackgroundColor({ color: '#888888' });
    chrome.action.setTitle({ title: '港台翻譯機：已停用' });
  }
}
