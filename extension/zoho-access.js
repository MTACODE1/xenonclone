// The page the extension opens the first time a Zoho Books read is asked for. Chrome only lets an extension ask
// for new sites from a click on one of its own pages, so the Zoho sites are requested here rather than listed as
// required in the manifest: a required new site would make Chrome disable the whole extension on update until each
// user approved it, which would stop the Xero reads too.
(function () {
  'use strict';
  const origins = chrome.runtime.getManifest().optional_host_permissions || [];
  const result = document.getElementById('result');
  const button = document.getElementById('allow');
  const done = () => {
    button.hidden = true;
    result.textContent = 'Zoho Books is allowed. You can close this tab and click "Update from Zoho Books" in Akrio Verify again.';
  };
  chrome.permissions.contains({ origins }).then(allowed => { if (allowed) done(); }).catch(() => {});
  button.addEventListener('click', async () => {
    try {
      if (await chrome.permissions.request({ origins })) done();
      else result.textContent = 'Zoho Books was not allowed, so the extension cannot read it. Click the button to try again.';
    } catch (error) {
      result.textContent = 'Chrome could not ask for the permission: ' + String((error && error.message) || error);
    }
  });
})();
