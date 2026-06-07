# Reviewer Lessons — dev-gui (newest first)

## 2026-06-07 — AC mit „Frontend zeigt … an"-Klausel: immer client/-Verzeichnis auf zugehöriges Formular prüfen
Bei ACs die explizit frontend-seitiges Verhalten fordern (klickbare URL, Formular, Fokusführung), immer client/src prüfen ob die zugehörige View-Komponente das Formular enthält — Placeholder-Component ohne Formular = Critical-AC-Gap. Nicht darauf verlassen, dass die Coder-Summary „AC vollständig" korrekt ist.

## 2026-06-07 — Spec-Feld „Ergebnis" im Audit-Eintrag: Audit-First kann Outcome nicht kennen — Post-Audit-Eintrag prüfen
Wenn eine Spec den Audit-Eintrag mit „Ergebnis"-Feld beschreibt UND Audit-First fordert, muss ein post-mutation Eintrag mit dem tatsächlichen Outcome vorhanden sein. Analogon zur TOFU-Lesson. Fehlt der Post-Eintrag = Important.

## 2026-06-07 — Audit-First + TOFU: Hash ist zur Audit-Zeit noch nicht verfügbar — post-provision Eintrag prüfen
Wenn eine Provision-Route Audit-First verwendet UND die Spec „Hash im Audit-Eintrag geloggt" fordert, muss explizit geprüft werden ob (a) der Hash zur Audit-First-Zeit schon verfügbar ist (nein — SSH-Verbindung findet danach statt) und (b) ein zweiter post-provision Audit-Eintrag mit dem Hash existiert. Fehlt dieser zweite Eintrag: Important-Befund (Spec-vs-Code-Mismatch). Nicht verwechseln: Hash in HTTP-Response ≠ Hash in Audit-Store.

## 2026-06-07 — WS-Spy-Claim im Header braucht echten WS-Spy-Test
Wenn ein Test-Datei-Header "no WS call" als abgedeckt deklariert, muss ein `globalThis.WebSocket`-Spy-Test existieren — auch wenn die Komponente trivial ist und offensichtlich keinen WS-Aufruf macht. Die Regel (`coder.md 2026-05-27: Test-Header-Claim muss alle beworbenen Fälle abdecken`) gilt unabhängig von der Trivialitat der Komponente. Erst wenn der Test existiert, ist der Claim belegt. Ohne Test ist es eine Important-Finding.

