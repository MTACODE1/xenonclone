// Logs whenever the server could not answer anything for a while, and what it was doing.
//
// Node runs every request and every sync on one thread. If one piece of work holds that thread for over a minute,
// the load balancer's health check (every 30 s, 5 s timeout, 3 failures) gives up and ECS replaces the container,
// with nothing in the logs to say why. On 22 Nov 2026 that happened twice in a row on one client's duplicate-contact
// comparison; finding it took a morning. With this, the log says which client's sync was running and the last check it
// had finished ("[event-loop] blocked for 95.2 s while org 123: running checks, last finished inactive_contacts") the
// moment the thread is free again; the [slow-check] line for that sync names the check that took the time.
const CHECK_EVERY_MS = 1000;
const REPORT_OVER_MS = 3000;

const activities = new Map(); // key -> what that piece of work is doing now
let timer = null;

// Records what a long-running piece of work (a sync) is doing; returns a function to call when it ends.
function noteActivity(key, label) {
  activities.set(key, label);
  return () => activities.delete(key);
}

function describeActivity() {
  return activities.size ? [...activities.values()].join('; ') : 'no sync running';
}

function startEventLoopWatch({ log = console.warn } = {}) {
  if (timer) return;
  let expected = Date.now() + CHECK_EVERY_MS;
  timer = setInterval(() => {
    const now = Date.now();
    const late = now - expected;
    if (late > REPORT_OVER_MS) log(`[event-loop] blocked for ${(late / 1000).toFixed(1)} s while ${describeActivity()}`);
    expected = now + CHECK_EVERY_MS;
  }, CHECK_EVERY_MS);
  timer.unref();
}

function stopEventLoopWatch() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { noteActivity, describeActivity, startEventLoopWatch, stopEventLoopWatch, REPORT_OVER_MS };
