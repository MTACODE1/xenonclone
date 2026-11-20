// Injected into Xero's "Bank statements" tab of ONE bank account by the service worker, when someone clicks
// "items to reconcile" in Akrio Verify. It uses the page's own search box to show only Unreconciled statement
// lines (a filter, exactly as a person would set it), pages through the result with the page's own "Next"
// link, and reads the rows shown. It changes nothing in Xero and calls none of Xero's data endpoints itself.
// The last expression is the result.
(async function () {
  'use strict';
  const MAX_LINES = 1000;
  const MAX_PAGES = 60;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const fire = (el, types) => types.forEach(type => el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window })));
  const visible = el => Boolean(el && el.offsetParent);
  const table = () => document.getElementById('statementDetails');
  const cellText = cell => (cell.textContent || '').replace(/\s+/g, ' ').trim();
  const result = extra => ({
    host: location.host, path: location.pathname, pageTitle: document.title.slice(0, 200),
    heading: ((document.querySelector('#title, h1') || {}).innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300),
    ...extra,
  });

  // The page (an older Xero screen) draws its table a moment after loading.
  for (let i = 0; i < 40 && !table(); i++) await sleep(500);
  if (!table()) return result({ ok: false, reason: 'no_table' });

  // Every change of the list (search, next page) redraws the table rows. Mark the rows there now, do the
  // action, then wait until none of the marked rows is left.
  const afterRedraw = async action => {
    table().querySelectorAll('tr').forEach(row => row.setAttribute('data-akrio-old', '1'));
    action();
    for (let waited = 0; waited < 30000; waited += 300) {
      await sleep(300);
      if (table() && !table().querySelector('tr[data-akrio-old]')) return true;
    }
    return false;
  };

  // 1. Show only Unreconciled lines, with the page's own search form.
  const statusBox = document.getElementById('sb_reconciledStatus_value');
  const openSearch = document.getElementById('bank-transactions-search-button');
  if (!statusBox || !openSearch) return result({ ok: false, reason: 'no_search_form' });
  if (!visible(statusBox)) { fire(openSearch, ['click']); await sleep(700); }
  const toggle = document.getElementById('sb_reconciledStatus_toggle');
  if (!toggle) return result({ ok: false, reason: 'no_status_filter' });
  fire(toggle, ['mousedown', 'mouseup', 'click']);
  let option = null;
  for (let i = 0; i < 10 && !option; i++) {
    await sleep(300);
    option = [...document.querySelectorAll('div')].find(el => el.children.length === 0 && visible(el) && el.textContent.trim() === 'Unreconciled');
  }
  if (!option) return result({ ok: false, reason: 'no_status_option' });
  fire(option, ['mouseover', 'mousedown', 'mouseup', 'click']);
  await sleep(300);
  if (statusBox.value !== 'Unreconciled') return result({ ok: false, reason: 'status_not_set' });
  const search = document.getElementById('sbSubmit_BT');
  if (!search) return result({ ok: false, reason: 'no_search_button' });
  if (!(await afterRedraw(() => fire(search, ['mousedown', 'mouseup', 'click'])))) return result({ ok: false, reason: 'search_timeout' });

  // 2. Read the rows shown, page by page.
  const header = () => [...table().rows[0].cells].map(cellText);
  const pageRows = () => [...table().rows].slice(1).filter(row => visible(row)).map(row => [...row.cells].map(cellText));
  const columns = header();
  const rows = [];
  let pages = 0, truncated = false;
  for (;;) {
    pages++;
    for (const row of pageRows()) rows.push(row);
    if (rows.length >= MAX_LINES) { truncated = true; break; }
    const next = [...document.querySelectorAll('a')].find(link => visible(link) && /^Next\b/.test(link.textContent.trim()));
    if (!next) break;
    if (pages >= MAX_PAGES) { truncated = true; break; }
    if (!(await afterRedraw(() => fire(next, ['mousedown', 'mouseup', 'click'])))) { truncated = true; break; }
  }
  const total = (document.body.innerText.match(/\(([\d,]+) total items?\)/) || [])[1];
  return result({
    ok: true, columns, rows: rows.slice(0, MAX_LINES), truncated,
    totalShownByXero: total ? Number(total.replace(/,/g, '')) : null,
    statusFilter: statusBox.value,
  });
})();
