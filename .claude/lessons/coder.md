# Coder Lessons — dev-gui (newest first)

## 2026-05-26 — Number() ohne Validierung bricht numerische Guards still
`restartMax = Number(process.env.RESTART_MAX ?? 5)` — wenn `RESTART_MAX=abc` gesetzt ist, ergibt `Number('abc') === NaN`. Alle Vergleiche mit `NaN` (z.B. `length >= NaN`) ergeben `false`, was Limit-Checks (AC4-Restart-Cap) lautlos deaktiviert. Immer `Number.isFinite()` + Fallback einsetzen: `const n = Number(raw); restartMax = Number.isFinite(n) && n >= 0 ? n : 5;`.

## 2026-05-26 — EventEmitter-Server-Level-Fehler separat behandeln
`WebSocketServer.on('error', …)` fehlt regelmäßig wenn nur `ws.on('error', …)` pro Socket eingebaut wird. Der Server selbst kann ebenfalls `'error'` emittieren (Upgrade-Fehler, interne Fehler) — kein Handler → unhandled EventEmitter-Error → Prozess-Crash. Immer beide Ebenen absichern.

## 2026-05-26 — AccessGuard ist Backend-Middleware, nicht nur Infra
Architektur-Doc definiert `AccessGuard` als eigene Backend-Komponente, die `Cf-Access-Jwt-Assertion` **vor jeder `/api/*`- und WS-Anfrage** validiert und den Server bei fehlendem Konfig **nicht starten lässt**. Dieses Middleware-Stück ist Teil der Implementierungs-Items, nicht delegierbar an den Cloudflare-Tunnel allein. Immer mitimplementieren, wenn ein `/api/*`-Endpunkt oder ein WS-Upgrade eingeführt wird.

## 2026-05-26 — process.env vollständig an child-PTY: nur gezielte Keys strippen reicht nicht
`childEnv = {...process.env}; delete childEnv.ANTHROPIC_API_KEY` ist unzureichend, wenn weitere Secrets im Parent-Env liegen (z. B. `CLOUDFLARE_API_TOKEN`, `GPG_PASSPHRASE`). Strategie: entweder eine explizite **Allowlist** sicherer Env-Variablen für den PTY-Child bauen, oder zumindest alle bekannten Secret-Keys strippen (zentrale Liste).
