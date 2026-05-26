# Coder Lessons — dev-gui (newest first)

## 2026-05-26 — Interne Fehler von Client-Fehlern im HTTP-Status trennen
Ein PTY-Write-Fehler (z.B. PTY destroyed) ist ein interner Serverfehler — nicht der Fehler des Clients. `reason:'invalid'` → 400 ist korrekt für Validierungsfehler (Allowlist, Sanitisierung, Audit-Fail). Für I/O-Fehler auf Server-Seite ein eigenes `reason:'internal'` zurückgeben und im Router auf 500 mappen. Audit-Fail = 400 (Integritätsbedingung — kein unauditierter Lauf), PTY-Write-Fail = 500 (Infra-Problem). Fehlt diese Unterscheidung, täuscht der Client eine eigene Schuld (400) vor, wo die Infra das Problem ist.

## 2026-05-26 — Lock auf JEDEM Exit-Pfad freigeben — auch auf PTY/IO-Write-Fehler
Wenn ein Lock vor einem I/O-Call acquired wird (z.B. `pty.write()`), muss der `catch`-Zweig den Lock explizit freigeben. Fehlt `try/catch` um den Write, ist der Lock nach einem Fehler permanent gehalten → DoS für alle folgenden Requests. Muster: `try { sink.write(data); } catch (e) { this.#lock.release(); throw e; }` (oder `return { ok: false, ... }`). Gilt analog für alle Lock-nach-Audit-Sequenzen.

## 2026-05-26 — jwtVerify immer mit explizitem `algorithms: ['RS256']` aufrufen
`jwtVerify(token, keySet, { audience: aud })` ohne `algorithms`-Option erlaubt `none`-Algorithmus und symmetrische Algorithmen (HS256 etc.) falls das Key-Material es hergibt. Bei Cloudflare Access immer `algorithms: ['RS256']` übergeben — einmal pro `jwtVerify`-Aufruf, auch wenn man zwei separate Guards (HTTP + WS) hat. Fehlender `algorithms`-Constraint ist ein security/R06-Befund.

## 2026-05-26 — WebSocketServer-Refactor: maxPayload beim Server mitnehmen
Wenn `WebSocketServer` aus einer Klasse (hier: WsGateway) in den Entrypoint (`server.js`) verschoben wird, um eine Upgrade-Guard vorschalten zu können, muss `maxPayload` **am neuen Konstruktor-Aufruf** gesetzt werden — nicht nur im alten Code. `new WebSocketServer({ noServer: true })` ohne `maxPayload` entfernt den DoS-Schutz lautlos. Immer: `new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })`.

## 2026-05-26 — Number() ohne Validierung bricht numerische Guards still
`restartMax = Number(process.env.RESTART_MAX ?? 5)` — wenn `RESTART_MAX=abc` gesetzt ist, ergibt `Number('abc') === NaN`. Alle Vergleiche mit `NaN` (z.B. `length >= NaN`) ergeben `false`, was Limit-Checks (AC4-Restart-Cap) lautlos deaktiviert. Immer `Number.isFinite()` + Fallback einsetzen: `const n = Number(raw); restartMax = Number.isFinite(n) && n >= 0 ? n : 5;`.

## 2026-05-26 — EventEmitter-Server-Level-Fehler separat behandeln
`WebSocketServer.on('error', …)` fehlt regelmäßig wenn nur `ws.on('error', …)` pro Socket eingebaut wird. Der Server selbst kann ebenfalls `'error'` emittieren (Upgrade-Fehler, interne Fehler) — kein Handler → unhandled EventEmitter-Error → Prozess-Crash. Immer beide Ebenen absichern.

## 2026-05-26 — AccessGuard ist Backend-Middleware, nicht nur Infra
Architektur-Doc definiert `AccessGuard` als eigene Backend-Komponente, die `Cf-Access-Jwt-Assertion` **vor jeder `/api/*`- und WS-Anfrage** validiert und den Server bei fehlendem Konfig **nicht starten lässt**. Dieses Middleware-Stück ist Teil der Implementierungs-Items, nicht delegierbar an den Cloudflare-Tunnel allein. Immer mitimplementieren, wenn ein `/api/*`-Endpunkt oder ein WS-Upgrade eingeführt wird.

## 2026-05-26 — process.env vollständig an child-PTY: nur gezielte Keys strippen reicht nicht
`childEnv = {...process.env}; delete childEnv.ANTHROPIC_API_KEY` ist unzureichend, wenn weitere Secrets im Parent-Env liegen (z. B. `CLOUDFLARE_API_TOKEN`, `GPG_PASSPHRASE`). Strategie: entweder eine explizite **Allowlist** sicherer Env-Variablen für den PTY-Child bauen, oder zumindest alle bekannten Secret-Keys strippen (zentrale Liste).
