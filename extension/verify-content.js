// Runs on Akrio Verify's own pages only (see manifest "matches"). It passes a "read this client's
// Xero bank page" request from the page to the extension and hands the answer back to the same page.
// It never sees Verify's session cookie or form token; the page itself saves the reading to Verify.
(function () {
  'use strict';
  const FROM_PAGE = 'akrio-verify-page';
  const FROM_EXTENSION = 'akrio-verify-extension';
  const reply = message => window.postMessage({ source: FROM_EXTENSION, ...message }, window.location.origin);

  // Only one read runs at a time, so stage updates from the service worker belong to the newest request.
  let activeRequestId = null;
  chrome.runtime.onMessage.addListener(message => {
    if (message && message.type === 'READ_PROGRESS' && activeRequestId && typeof message.stage === 'string') {
      reply({ type: 'READ_PROGRESS', requestId: activeRequestId, stage: message.stage });
    }
  });

  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || data.source !== FROM_PAGE || typeof data.requestId !== 'string') return;
    if (data.type === 'PING') {
      reply({ type: 'PONG', requestId: data.requestId, version: chrome.runtime.getManifest().version });
    } else if (data.type === 'READ_BANK_PAGE') {
      activeRequestId = data.requestId;
      chrome.runtime.sendMessage({ type: 'READ_BANK_PAGE', shortCode: data.shortCode }, response => {
        if (activeRequestId === data.requestId) activeRequestId = null;
        const failed = chrome.runtime.lastError || !response;
        reply({ type: 'READ_RESULT', requestId: data.requestId,
          ...(failed ? { ok: false, error: 'extension_error', message: 'The extension did not answer. Reload this page and try again.' } : response) });
      });
    }
  });
})();
