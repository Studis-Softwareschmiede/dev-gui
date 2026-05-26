/**
 * AuditStore tests (AC3)
 *
 * Verifies:
 *   - record() appends entries with auto-stamped time
 *   - GET /api/audit returns all entries in append order
 *   - append-only: no delete/update possible
 *   - record() throws on invalid input (guard for AC3 invariant)
 */

import { describe, it, beforeEach, expect } from '@jest/globals';
import express from 'express';
import { createServer } from 'node:http';
import { AuditStore, auditRouter } from '../src/AuditStore.js';

// ── Helpers ───────────────────────────────────────────────────────────────

function makeAuditApp(store) {
  const app = express();
  app.use(auditRouter(store));
  return createServer(app);
}

function getAudit(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      import('node:http').then(({ request }) => {
        const req = request(
          { hostname: '127.0.0.1', port, path: '/api/audit', method: 'GET' },
          (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(body) }));
          },
        );
        req.on('error', () => resolve({ status: 0, data: [] }));
        req.end();
      });
    });
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('AuditStore — record() and getAll()', () => {
  let store;

  beforeEach(() => {
    store = new AuditStore();
  });

  it('record() returns an entry with time, identity, command', () => {
    const before = new Date();
    const entry = store.record({ identity: 'alice@example.com', command: '/flow #1' });
    const after = new Date();

    expect(entry.identity).toBe('alice@example.com');
    expect(entry.command).toBe('/flow #1');
    expect(new Date(entry.time) >= before).toBe(true);
    expect(new Date(entry.time) <= after).toBe(true);
  });

  it('getAll() returns entries in append order', () => {
    store.record({ identity: 'a@x.com', command: '/flow #1' });
    store.record({ identity: 'b@x.com', command: '/flow #2' });
    store.record({ identity: 'a@x.com', command: '/flow #3' });

    const all = store.getAll();
    expect(all).toHaveLength(3);
    expect(all[0].command).toBe('/flow #1');
    expect(all[1].command).toBe('/flow #2');
    expect(all[2].command).toBe('/flow #3');
  });

  it('getAll() returns a copy — mutation does not affect store', () => {
    store.record({ identity: 'x@x.com', command: '/flow #1' });
    const copy = store.getAll();
    copy.push({ time: 'fake', identity: 'evil', command: 'injected' });
    expect(store.getAll()).toHaveLength(1);
  });

  it('record() with null identity is allowed (dev bypass case)', () => {
    const entry = store.record({ identity: null, command: '/flow #1' });
    expect(entry.identity).toBeNull();
  });

  it('record() throws on empty command string', () => {
    expect(() => store.record({ identity: 'a@x.com', command: '' })).toThrow();
    expect(() => store.record({ identity: 'a@x.com', command: '   ' })).toThrow();
  });

  it('record() throws on non-string command', () => {
    expect(() => store.record({ identity: 'a@x.com', command: 42 })).toThrow();
  });

  it('record() throws on non-string/non-null identity', () => {
    expect(() => store.record({ identity: { email: 'a@x.com' }, command: '/flow' })).toThrow();
  });
});

describe('GET /api/audit — HTTP endpoint', () => {
  it('returns empty array when no entries', async () => {
    const store = new AuditStore();
    const server = makeAuditApp(store);
    try {
      const res = await getAudit(server);
      expect(res.status).toBe(200);
      expect(res.data).toEqual([]);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('returns recorded entries with time, identity, command', async () => {
    const store = new AuditStore();
    store.record({ identity: 'alice@example.com', command: '/flow #7' });
    store.record({ identity: 'bob@example.com', command: '/flow #8' });

    const server = makeAuditApp(store);
    try {
      const res = await getAudit(server);
      expect(res.status).toBe(200);
      expect(res.data).toHaveLength(2);
      expect(res.data[0].identity).toBe('alice@example.com');
      expect(res.data[0].command).toBe('/flow #7');
      expect(typeof res.data[0].time).toBe('string');
      expect(res.data[1].identity).toBe('bob@example.com');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('entries are in append order (oldest first)', async () => {
    const store = new AuditStore();
    store.record({ identity: 'a@x.com', command: 'first' });
    store.record({ identity: 'a@x.com', command: 'second' });

    const server = makeAuditApp(store);
    try {
      const res = await getAudit(server);
      expect(res.data[0].command).toBe('first');
      expect(res.data[1].command).toBe('second');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
