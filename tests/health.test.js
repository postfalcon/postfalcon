import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../app.js';

describe('GET /health', () => {
  it('reports ok when the database is reachable', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.db).toBe('connected');
    // The test app never starts the cron jobs.
    expect(res.body.scheduler).toBe('off');
  });
});

describe('schedulerState', () => {
  it('tells a ticking scheduler from a stalled or failing one', async () => {
    const { schedulerHeartbeat, schedulerState } = await import('../lib/schedulerHeartbeat.js');
    const saved = { ...schedulerHeartbeat };
    const now = Date.now();
    try {
      Object.assign(schedulerHeartbeat, { startedAt: new Date(now - 30000), lastTickAt: null, lastError: null });
      expect(schedulerState(now)).toBe('starting');
      schedulerHeartbeat.lastTickAt = new Date(now - 60000);
      expect(schedulerState(now)).toBe('ok');
      schedulerHeartbeat.lastError = 'connect ECONNREFUSED';
      expect(schedulerState(now)).toBe('failing');
      Object.assign(schedulerHeartbeat, { lastTickAt: new Date(now - 10 * 60000), lastError: null });
      expect(schedulerState(now)).toBe('stalled');
    } finally {
      Object.assign(schedulerHeartbeat, saved);
    }
  });
});

// Ops endpoints that aren't pages: the installer's short address sits beside /health.
describe('GET /install.sh', () => {
  it('redirects to the installer script in the repository', async () => {
    const res = await request(app).get('/install.sh');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://raw.githubusercontent.com/postfalcon/postfalcon/main/install.sh');
  });
});
