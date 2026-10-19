// Helpers for the client list's "Team Member Access" picker, which grants and removes several people at once.

// "3, 7,x,7,-2" -> [3, 7]. Only whole positive numbers survive, each once, in the order given.
function parseIdList(value) {
  const seen = new Set();
  for (const part of String(value == null ? '' : value).split(',')) {
    const trimmed = part.trim();
    if (!/^\d+$/.test(trimmed)) continue;
    const id = Number(trimmed);
    if (id > 0) seen.add(id);
  }
  return [...seen];
}

// What to do for one client: grant these, revoke those. Someone named in both lists is granted (never both),
// and anyone who is not an active team member is ignored, so a forged id cannot reach the database.
function accessChanges(grantValue, revokeValue, activeStaffIds) {
  const active = new Set(activeStaffIds);
  const grant = parseIdList(grantValue).filter(id => active.has(id));
  const granted = new Set(grant);
  const revoke = parseIdList(revokeValue).filter(id => active.has(id) && !granted.has(id));
  return { grant, revoke };
}

module.exports = { parseIdList, accessChanges };
