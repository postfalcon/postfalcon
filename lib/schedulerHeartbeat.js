// When the per-minute publishing job last ran, for the admin overview. In memory: the scheduler
// runs inside the one app process (ecosystem.config.cjs instances: 1), so the admin route reads
// the same object the cron job writes. Reset on every restart — `startedAt` says when that was.
export const schedulerHeartbeat = {
  startedAt: null,
  lastTickAt: null,
  lastError: null,
};

export function markSchedulerStarted() {
  schedulerHeartbeat.startedAt = new Date();
}

// For /health, so an outside uptime monitor also notices a scheduler that stopped ticking — the
// one failure lib/alerts.js can't email about, since its checks run from that same scheduler.
// 'off' = not started in this process (tests); 'stalled' = no tick for 3 minutes; 'failing' =
// the last tick threw.
const STALL_MS = 3 * 60000;

export function schedulerState(now = Date.now()) {
  const { startedAt, lastTickAt, lastError } = schedulerHeartbeat;
  if (!startedAt) return 'off';
  const last = (lastTickAt ?? startedAt).getTime();
  if (now - last > STALL_MS) return 'stalled';
  if (lastError) return 'failing';
  return lastTickAt ? 'ok' : 'starting';
}

export function markSchedulerTick(err = null) {
  schedulerHeartbeat.lastTickAt = new Date();
  schedulerHeartbeat.lastError = err ? String(err.message || err).slice(0, 500) : null;
}
