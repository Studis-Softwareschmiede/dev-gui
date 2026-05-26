/**
 * AccessGuard — Cloudflare Access JWT middleware (AC1, AC2, AC5).
 *
 * Validates the `Cf-Access-Jwt-Assertion` header against the JWKS published
 * at `https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs`.
 *
 * Config (env):
 *   ACCESS_TEAM_DOMAIN — Cloudflare Access team domain (e.g. "yourteam.cloudflareaccess.com")
 *   ACCESS_AUD         — Application Audience tag (AUD)
 *   DEV_NO_ACCESS      — set to "1" to bypass in non-production (dev only)
 *
 * Security:
 *   - Fail-closed: any JWT error or JWKS fetch failure → 403.
 *   - JWT and its raw claims are NEVER logged (AC5 / security/R01).
 *   - Only the `email` claim is attached to the request object.
 *   - Injectable keySet parameter for unit tests (no network calls).
 */

import { jwtVerify, createRemoteJWKSet } from 'jose';

/**
 * @typedef {object} AccessGuardOptions
 * @property {string} [teamDomain] - Cloudflare Access team domain (default: env ACCESS_TEAM_DOMAIN)
 * @property {string} [aud]        - Expected audience (default: env ACCESS_AUD)
 * @property {Function} [keySet]   - Injectable JWKS getter for tests; defaults to remote JWKS
 */

/**
 * Shared helper: build a JWKS key-set resolver from options.
 * Returns the injected keySet (tests), a remote JWKS (production), or undefined
 * when neither is available (fail-closed: callers treat undefined → 403).
 *
 * @param {AccessGuardOptions} options
 * @returns {Function|undefined}
 */
function buildKeySet(options) {
  if (options.keySet) {
    // Injected for tests — use as-is (must be a function compatible with jwtVerify)
    return options.keySet;
  }
  const teamDomain = options.teamDomain ?? process.env.ACCESS_TEAM_DOMAIN;
  if (teamDomain) {
    const certsUrl = new URL('/cdn-cgi/access/certs', `https://${teamDomain}`);
    return createRemoteJWKSet(certsUrl);
  }
  return undefined;
}

/**
 * Returns an Express middleware that enforces Cloudflare Access JWT validation.
 *
 * @param {AccessGuardOptions} [options]
 * @returns {import('express').RequestHandler}
 */
export function createAccessGuard(options = {}) {
  const aud = options.aud ?? process.env.ACCESS_AUD;

  // Build key-set resolver once (cached remote JWKS or injected keyset)
  const keySet = buildKeySet(options);

  return async function accessGuard(req, res, next) {
    // Dev bypass: allowed ONLY when not production and DEV_NO_ACCESS=1
    if (process.env.DEV_NO_ACCESS === '1' && process.env.NODE_ENV !== 'production') {
      req.identity = { email: 'dev@local' };
      return next();
    }

    const token = req.headers['cf-access-jwt-assertion'];

    // Missing header → 403 (AC1)
    if (!token || typeof token !== 'string' || token.trim() === '') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // No keySet means no team domain configured — fail-closed (AC2 + fail-closed)
    if (!keySet) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    try {
      const { payload } = await jwtVerify(token, keySet, {
        audience: aud,
        algorithms: ['RS256'],
        // jose enforces exp automatically
      });

      // AC5: only extract email — never log or forward the raw token or full payload
      const email = typeof payload.email === 'string' ? payload.email : null;
      req.identity = { email };
      return next();
    } catch {
      // Any verification failure (expired, wrong aud, bad sig, JWKS unreachable) → 403
      // Do NOT log the error message (may contain JWT content) — security/R01
      return res.status(403).json({ error: 'Forbidden' });
    }
  };
}

/**
 * Creates a WebSocket upgrade interceptor that enforces Access Guard
 * before the upgrade is handed to the WS server.
 *
 * Usage: call the returned function from `server.on('upgrade', ...)`.
 * It calls `wsServer.handleUpgrade` on success, destroys the socket on failure.
 *
 * @param {import('ws').WebSocketServer} wss
 * @param {AccessGuardOptions} [options]
 * @returns {(req: import('http').IncomingMessage, socket: import('net').Socket, head: Buffer) => void}
 */
export function createWsAccessGuard(wss, options = {}) {
  const aud = options.aud ?? process.env.ACCESS_AUD;
  const keySet = buildKeySet(options);

  return async function wsAccessGuard(req, socket, head) {
    // Dev bypass
    if (process.env.DEV_NO_ACCESS === '1' && process.env.NODE_ENV !== 'production') {
      req.identity = { email: 'dev@local' };
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
      return;
    }

    const token = req.headers['cf-access-jwt-assertion'];

    if (!token || typeof token !== 'string' || token.trim() === '') {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    if (!keySet) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    try {
      const { payload } = await jwtVerify(token, keySet, {
        audience: aud,
        algorithms: ['RS256'],
      });

      const email = typeof payload.email === 'string' ? payload.email : null;
      req.identity = { email };
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } catch {
      // Fail-closed: any error → reject upgrade (AC1, fail-closed)
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
    }
  };
}

/**
 * Fail-Fast production check (AC2).
 * Call this before server.listen().
 *
 * Throws (and should cause process exit) when:
 *   - NODE_ENV === 'production'
 *   - AND ACCESS_TEAM_DOMAIN or ACCESS_AUD is missing/empty
 *
 * Dev bypass is ONLY permitted when DEV_NO_ACCESS === '1' AND NODE_ENV !== 'production'.
 *
 * @param {object} [opts]
 * @param {string} [opts.teamDomain]
 * @param {string} [opts.aud]
 */
export function assertAccessConfig(opts = {}) {
  const teamDomain = opts.teamDomain ?? process.env.ACCESS_TEAM_DOMAIN;
  const aud = opts.aud ?? process.env.ACCESS_AUD;
  const isProd = process.env.NODE_ENV === 'production';
  const devBypass = process.env.DEV_NO_ACCESS === '1' && !isProd;

  if (devBypass) {
    // Dev-bypass: allowed — log a warning but proceed
    console.warn('[AccessGuard] DEV_NO_ACCESS=1 — Access validation DISABLED (dev only)');
    return;
  }

  if (!teamDomain || !aud) {
    const missing = [!teamDomain && 'ACCESS_TEAM_DOMAIN', !aud && 'ACCESS_AUD']
      .filter(Boolean)
      .join(', ');
    // In production this must abort startup (AC2)
    // In non-production without dev bypass it is still a configuration error
    throw new Error(
      `[AccessGuard] Missing required configuration: ${missing}. ` +
      `Server refuses to start. Set the env vars or use DEV_NO_ACCESS=1 for local dev.`,
    );
  }
}
