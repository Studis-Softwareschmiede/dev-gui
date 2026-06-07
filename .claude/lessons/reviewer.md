# Reviewer Lessons — dev-gui (newest first)

## 2026-06-07 — Worktree-Diff gegen main: später gelandete Items erscheinen als „entfernt" (Stale-Base-Artefakt)
Bei parallelen Worktree-Builds vergleicht `git diff main` im Worktree gegen das WEITERGEZOGENE main — Items, die nach der Worktree-Erstellung gelandet sind (z.B. #60-Frontend, #67-Delete), erscheinen dann fälschlich als „gelöscht". Vor einem Critical „Spec-Drift / Feature entfernt"-Befund: `git merge-base HEAD main` prüfen und den Diff gegen die Worktree-BASIS bewerten. Echte Kollateralentfernungen bleiben Critical (siehe coder.md-Lesson); Stale-Base-Artefakte löst der Orchestrator beim Rebase.
## 2026-06-07 — Toggle-Refactor: A11y-Struktur-Tests für versteckte Formulare systematisch prüfen
Wenn ein Formular hinter einen Toggle-Button versetzt wird, müssen beim Review die alten Struktur-/A11y-Tests auf zwei Dinge geprüft werden: (a) Wurden sie vollständig entfernt oder nur verschoben? (b) Deckt der Datei-JSDoc-Header weiterhin Claims ab, für die kein `it`-Block mehr existiert (z.B. „Touch-Target ≥ 44 px für Submit-Button")? Beides zieht einen Important-Befund nach sich. Die Prüfung: grep nach dem Claim-Text im Header, dann grep nach zugehörigem `getByRole` / `minHeight`-Assertion im Body — fehlt eine Seite, ist es ein Verstoß.

## 2026-06-07 — startsWith-Prefix-Check mit Trailing-Slash ist sicher (kein false-positive aus alter Lesson)
Die coder.md-Lesson „Traversal-Guard: immer per parent-dir-Vergleich" wurde in einem früheren Review aus einem anderen Kontext destilliert. Im GitHub-Cloner-Code wird `wsPrefix = resolvedWs + '/'` (mit Trailing-Slash) gebildet und dann `absPath.startsWith(wsPrefix)` geprüft. Das verhindert das beschriebene False-Positive (`/workspace-evil/x` startet NICHT mit `/workspace/`). Vor einem Traversal-Guard-Befund: immer prüfen, ob der Code schon Trailing-Slash hinzufügt. Kein Befund bei korrekter Trailing-Slash-Verwendung.

## 2026-06-07 — Test-Header „fokussiert" vs „fokussierbar": Spec-Wort genau lesen bevor Befund gesetzt wird
Wenn eine Spec „fokussierbar" (can receive focus) schreibt und der Test-Header „fokussiert" (is focused) behauptet, ist der Test-Header-Claim stärker als die Spec. Vor dem Important-Befund prüfen: (a) erfüllt der Code die Spec-Anforderung? (b) overclaimed der Header? Wenn Spec = fokussierbar und Test = tabIndex-Check → Spec erfüllt, Header overclaims. Befund ist Important auf Ebene „Test-Header-Claim", nicht auf Ebene „Spec-Verletzung".

## 2026-06-07 — AC mit „Frontend zeigt … an"-Klausel: immer client/-Verzeichnis auf zugehöriges Formular prüfen
Bei ACs die explizit frontend-seitiges Verhalten fordern (klickbare URL, Formular, Fokusführung), immer client/src prüfen ob die zugehörige View-Komponente das Formular enthält — Placeholder-Component ohne Formular = Critical-AC-Gap. Nicht darauf verlassen, dass die Coder-Summary „AC vollständig" korrekt ist.

## 2026-06-07 — Spec-Feld „Ergebnis" im Audit-Eintrag: Audit-First kann Outcome nicht kennen — Post-Audit-Eintrag prüfen
Wenn eine Spec den Audit-Eintrag mit „Ergebnis"-Feld beschreibt UND Audit-First fordert, muss ein post-mutation Eintrag mit dem tatsächlichen Outcome vorhanden sein. Analogon zur TOFU-Lesson. Fehlt der Post-Eintrag = Important.

## 2026-06-07 — Audit-First + TOFU: Hash ist zur Audit-Zeit noch nicht verfügbar — post-provision Eintrag prüfen
Wenn eine Provision-Route Audit-First verwendet UND die Spec „Hash im Audit-Eintrag geloggt" fordert, muss explizit geprüft werden ob (a) der Hash zur Audit-First-Zeit schon verfügbar ist (nein — SSH-Verbindung findet danach statt) und (b) ein zweiter post-provision Audit-Eintrag mit dem Hash existiert. Fehlt dieser zweite Eintrag: Important-Befund (Spec-vs-Code-Mismatch). Nicht verwechseln: Hash in HTTP-Response ≠ Hash in Audit-Store.

## 2026-06-07 — WS-Spy-Claim im Header braucht echten WS-Spy-Test
Wenn ein Test-Datei-Header "no WS call" als abgedeckt deklariert, muss ein `globalThis.WebSocket`-Spy-Test existieren — auch wenn die Komponente trivial ist und offensichtlich keinen WS-Aufruf macht. Die Regel (`coder.md 2026-05-27: Test-Header-Claim muss alle beworbenen Fälle abdecken`) gilt unabhängig von der Trivialitat der Komponente. Erst wenn der Test existiert, ist der Claim belegt. Ohne Test ist es eine Important-Finding.

