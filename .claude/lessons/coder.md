# Coder Lessons — dev-gui (newest first)

## 2026-06-07 — NavBar-Touch-Targets auf minHeight: 44px setzen — nicht 36px
Spec NFR (WCAG 2.1 AA, SC 2.5.5) schreibt Touch-Targets ≥ 44 px vor. NavBar-Links (`<a>`) sind interaktive Elemente und fallen unter dieselbe Regel wie Buttons und Kacheln. `minHeight: 36` reicht nicht. Fix: `navHome` und `navLink` auf `minHeight: 44` anheben. Tiles (120px) und Placeholder-Home-Buttons (44px) sind korrekt — NavBar ist der einzige blinde Fleck.

## 2026-06-07 — AC6-Tests müssen BEIDE Teilbedingungen abdecken: Unknown-Route UND Browser-Back/Forward
AC6 hat zwei unabhängige Bedingungen: (a) unbekannte Route → Panel-Fallback und (b) Browser-Zurück/Vor navigiert entlang des Verlaufs. In jsdom lässt sich (b) simulieren: Hash auf Route A setzen, rendern, via `navigate()` zu Route B wechseln, dann Hash manuell zurück auf Route A setzen und `hashchange` dispatchen — danach soll Route A angezeigt werden. Fehlt dieser Test, ist der Routing-Mechanismus für den Browser-History-Pfad unbewiesen. Test-Header-Claim muss beide Teile benennen oder den Browser-Back-Teil explizit als "nicht per Unit-Test abdeckbar — E2E" kennzeichnen.


## 2026-05-27 — AC7-Guard-Pfade brauchen symmetrische Abdeckung: alle required-Felder, alle Commands
AC7 schreibt vor, dass fehlende Pflichtfelder keinen Request auslösen. Wenn `adopt` mit leerem Repo getestet wird, muss auch `preview up` mit leerem Repo getestet werden — beide nutzen dieselbe `composeCommand → null`-Logik, aber der reviewer erwartet expliziten Nachweis pro Pfad. Gleiches gilt für optionale Commands: `requirement`/`train` brauchen je einen Test mit und einen ohne Argument, um zu beweisen, dass kein doppelter Leeraum entsteht. Faustregel: jede Bedingung in `composeCommand` bekommt genau einen Test.

## 2026-05-27 — Test-Header-Claim muss alle beworbenen Fälle abdecken
Wenn der Datei-JSDoc-Header (`@file` oder erstes Block-Kommentar) Abdeckungen auflistet (z.B. „requirement/train free-text"), müssen dafür auch echte `it(…)`-Blöcke existieren. Ein Claim ohne zugehörigen Test-Body ist eine falsche Abdeckungsaussage — der reviewer wird es beim nächsten Diff melden. Fix: für jede im Header genannte Kategorie mindestens einen `it`-Block ergänzen, BEVOR der Header den Claim enthält.

## 2026-05-27 — `build-essential` enthält bereits `make` und `g++` — keine Duplikate in apt
In einem Debian/Ubuntu-Dockerfile ist `build-essential` ein Metapaket, das `g++`, `make`,
`gcc` und weitere Build-Tools enthält. Das explizite Auflisten von `make g++ build-essential`
installiert dieselben Pakete doppelt und erzeugt unnötige Cache-Invalidierungen. Kanonisches
Muster: `build-essential python3` — das deckt node-gyp-Abhängigkeiten vollständig ab.

## 2026-05-27 — `.dockerignore` muss `.env` und `.env.*` explizit ausschließen
`COPY . .` im Builder-Stage kopiert alles, was nicht in `.dockerignore` steht — auch ein lokales `.env`. Selbst wenn das `.env` nicht in den Runtime-Layer kopiert wird, landet es im Builder-Layer (intermediate image, abrufbar mit `docker history --no-trunc` / `docker save`). Immer `.env` und `.env.*` in `.dockerignore` eintragen: zwei Zeilen `.env` und `.env.*` genügen. Gilt für jedes Multi-Stage-Dockerfile mit `COPY . .`.

## 2026-05-27 — `outline: 'none'` auf Inline-Styles entfernt den Browser-Fokus-Ring (WCAG SC 2.4.7)
`outline: 'none'` in einem React-Inline-Style entfernt den nativen Browser-Fokus-Ring, ohne ihn zu ersetzen — Inline-Styles können `:focus-visible` nicht nutzen. Fix: `outline: 'none'` weglassen (Browser-Standard reicht) ODER in `client/index.html` eine CSS-Regel `#trigger-arg:focus { outline: 2px solid #3b82f6; outline-offset: 1px; }` ergänzen. design.md schreibt „sichtbarer Fokus" vor.

## 2026-05-27 — Button-Text-Kontrast bei 13 px / 600 weight braucht ≥ 4.5:1, nicht 3:1
`#ffffff` auf `#3b82f6` ergibt 3.68:1; `#ffffff` auf `#d97706` ergibt 3.19:1. Beide Werte liegen unter WCAG 1.4.3 (4.5:1 für Text < 18 pt normal / < 14 pt bold). 13 px / 600 weight sind 9.75 pt — kein „large text". design.md schreibt ≥ 4.5:1 für Text vor. Fix: Primary-Button auf `#1d4ed8` (≥ 4.5:1) anheben; Kill-Button auf `#b45309` (≥ 4.5:1) abdunkeln. Gilt für alle Aktions-Buttons in dev-gui. (Fürs 3.1:1-Kriterium gelten nur Icon-/Nicht-Text-Kontrast-Regeln SC 1.4.11 — nicht Textinhalt in Buttons.)

## 2026-05-26 — "does not crash" Tests müssen async + waitFor/cleanup nutzen — kein synchrones render() mit Promise-fetchFn
Ein synchrones `expect(() => render(...)).not.toThrow()` mit einer Promise-basierten `fetchFn` erzeugt React-`act()`-Warnungen: Die Komponente startet einen `async doFetch`, dessen State-Updates (setData, setLoadState, setRefreshing) nach dem synchronen Test-Ende auflösen — außerhalb von `act()`. Fix: Test `async` machen und entweder `await waitFor(...)` auf das Ende der Fetch-Kette warten oder nach dem render `await act(async () => {})` flushten. Alternativ: den "kein Crash"-Assert durch einen `waitFor`-basierten inhaltlichen Assert ersetzen (ist aussagekräftiger).

## 2026-05-26 — Inline-Animation `spin` braucht @keyframes in globalem CSS
`animation: 'spin 1s linear infinite'` in einem React-Inline-Style referenziert einen `@keyframes spin`, der in `index.html` / einer globalen CSS-Datei definiert sein muss. Fehlt die Definition, rotiert das Element nicht (kein Fehler, aber Feature kaputt). Entweder den `@keyframes spin`-Block in `client/index.html` `<style>` ergänzen oder die Animation über ein CSS-Modul steuern.

## 2026-05-26 — Sekundärfarbe #6b7280 auf dunklem Hintergrund (#111) unterschreitet WCAG-AA
`#6b7280` auf `#111` ergibt Kontrast 3.91:1 — unter dem 4.5:1-Schwellwert für Fließtext (WCAG 2.1 AA). Gilt für Labels/Beschriftungen bei 11–12px. Fix: auf `#8a929e` (≥ 4.5:1) oder heller anheben, oder Schriftgröße auf ≥ 14px Bold anheben (dann gilt 3:1-Schwellwert für große Texte). design.md schreibt ≥ 4.5:1 vor.

## 2026-05-26 — Stub-Methoden müssen alle Component-Calls abdecken — attachCustomKeyEventHandler nachrüsten
Wird in `Terminal.jsx` eine neue xterm-Methode aufgerufen (hier: `attachCustomKeyEventHandler`), muss die Stub-Datei diese Methode sofort mitbekommen, sonst schlägt der Test mit "not a function" fehl. Pattern: neue Methode im Stub als `jest.fn((fn) => { Terminal._lastXyz = fn; })` anlegen und in `_reset()` auf `null` zurücksetzen — so können Tests den registrierten Handler direkt aufrufen und assertieren.

## 2026-05-26 — xterm.js Tab+Escape sind echte Focus-Trap-Kandidaten — immer attachCustomKeyEventHandler setzen
xterm.js setzt für Tab (keyCode 9) und Escape (keyCode 27) intern `result.cancel = true`, was `preventDefault()` auf dem KeyboardEvent aufruft. Damit funktioniert weder Browser-Tab-Navigation noch Escape-Blur aus dem Terminal heraus — WCAG 2.1 SC 2.1.2 (No Keyboard Trap) ist verletzt. Fix: `xterm.attachCustomKeyEventHandler(ev => { if (ev.type === 'keydown' && ev.key === 'Tab') return false; return true; })` direkt nach `xterm.open()` einfügen (gibt `false` zurück → xterm überspringt die Eingabe → Browser-Tab-Navigation läuft normal). Optional analog für Escape, falls gewünscht. `allowProposedApi: false` hat keinen Einfluss auf dieses Verhalten.

## 2026-05-26 — Spec-Enums müssen alle Code-Pfade abdecken (inkl. degraded)
Wenn AC4 einen Degradierungs-Wert (`'unknown'`) definiert, muss dieser auch in AC1-Enums und im Verträge-Abschnitt der Spec stehen. Fehlt `'unknown'` in AC1, sind Spec und Code inkonsistent: der reviewer schlägt beim Abgleich an (`Spec-Drift`). Bei jeder Implementierung: alle möglichen Return-Werte (inkl. Fehler-/Fallback-Pfade) in den Spec-Enums prüfen und ggf. Spec mitpflegen.

## 2026-05-26 — GitHub Issues-Endpoint liefert Issues UND PRs
`GET /repos/{org}/{repo}/issues?state=open` gibt sowohl offene Issues als auch offene Pull Requests zurück (GitHub modelliert PRs als Issues). Ein `openItems`-Count auf diesem Endpoint ist deshalb immer Issues+PRs. Für "nur Issues" den Search-Endpoint verwenden: `GET /search/issues?q=repo:{org}/{repo}+is:issue+is:open`. Andernfalls Kommentar "issues only, not PRs" weglassen und im Spec/Doc klarstellen, dass der Wert Issues+PRs enthält.

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
