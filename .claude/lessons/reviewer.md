# Reviewer Lessons — dev-gui (newest first)

## 2026-06-07 — aria-modal auf role="presentation" ist ein falsch-positiver A11y-Befund
`aria-modal="true"` auf dem Overlay-Wrapper mit `role="presentation"` ist semantisch inkorrekt (aria-modal ist nur für role=dialog/alertdialog definiert), aber harmlos — Screen-Reader ignorieren aria-modal auf presentational Elementen und nutzen das innere `role="dialog" aria-modal="true"`. Vor einem Important-Befund prüfen: hat das innere Dialog-Element selbst korrekt `role="dialog" aria-modal="true"`? Wenn ja: Suggestion, nicht Important. Kein Gate-Blocker.

## 2026-06-07 — Doppelter focus()-Aufruf (useEffect + setTimeout) nach State-Änderung: redundant aber harmlos
Wenn eine Komponente sowohl einen `useEffect([state])` mit `ref.current.focus()` als auch einen `setTimeout(() => ref.current?.focus(), 0)` im gleichen Handler hat, sind beide Pfade funktional korrekt (focus() ist idempotent), aber der setTimeout ist redundant — der useEffect feuert nach dem DOM-Commit und sieht den gemounteten DOM-Knoten bereits. Kein Important-Befund; als Suggestion empfehlen, den setTimeout zu entfernen.

## 2026-06-07 — useCallback-Deps: fehlende stabile Prop nicht als Befund wenn kein react-hooks-Lint konfiguriert und Prop nachweislich stabil
Wenn ein `useCallback` eine Prop-Funktion verwendet (z.B. `onCloneSuccess`), diese aber nicht in der Deps-Array steht (`[name, fetchFn]`), ist das nur dann ein Befund wenn (a) eslint-plugin-react-hooks aktiv ist UND (b) ein echtes Runtime-Risiko besteht (d.h. die Prop kann sich ändern und würde dann stale sein). Wenn die Prop nachweislich stabil ist (z.B. `fetchWorkspaceRepos = useCallback([], [])`) und kein react-hooks-Plugin im Projekt konfiguriert ist: Suggestion, kein Important.

## 2026-06-07 — Workspace-Fetch ohne cancelled-Guard: in React 18+ kein Befund, da setState auf unmounted component gesilenced ist
`fetchWorkspaceRepos()` in einem `useEffect` ohne eigene `cancelled`-Prüfung setzt nach dem Await `setLocalRepoNames()`. In React 18+ ist das setState nach Unmount gesilenced (kein Crash, keine Warning). Das ist kein Important-Befund. Nur wenn das Projekt explizit React 16/17 unterstützt oder ein unmount-sensitive Side-Effect (z.B. externe Mutation) stattfindet, wäre ein cancelled-Guard nötig.

## 2026-06-07 — Clone-State-Machine: Mehrfachklick-Schutz ist hinreichend belegt wenn der busy-Button disabled+aria-busy ist
Der Mehrfachklick-Schutz beim Klonen ist vollständig implementiert wenn (a) der Idle-Button im cloning-State nicht gerendert wird und (b) der Lade-Button disabled+aria-busy=true ist. Der Test muss nur das aria-busy-Element + disabled prüfen — die Abwesenheit des Idle-Buttons ist eine Stärkung, kein Pflichtassert für den Header-Claim "Mehrfachklick-Schutz". Kein Befund (nicht mal Suggestion) wenn die Implementierung korrekt ist und der Claim belegt ist.

## 2026-06-07 — role=alert ohne explizites aria-live="assertive" ist per WAI-ARIA konform (kein Header-Overclaim-Befund)
WAI-ARIA 1.2 definiert role=alert mit implizitem aria-live=assertive. Wenn der Test-Header "role=alert, aria-live=assertive" behauptet und das Element role=alert ohne explizites aria-live-Attribut hat, ist das per Spec korrekt (impliziter Wert). Kein Overclaim-Befund. Reviewer soll nicht auf explizites aria-live pochen wenn role=alert vorhanden ist.

## 2026-06-07 — Shared-Helper-Migration: erster Konsument (Referenz-Impl.) ist nicht automatisch gate-blockierend
Wenn ein shared helper extrahiert wird (z.B. githubAppToken.js) und der ERSTE Konsument (Referenz-Impl., z.B. GitHubCloner) NICHT im selben Diff migriert wird: kein Important/Critical, wenn (a) die Referenz-Impl. nachweislich korrekt ist (sie war das Vorbild), (b) die Neuimplementierung im Diff korrekt ist (identisches Skript-Format), und (c) die Nicht-Migration explizit als Folge-Item dokumentiert ist. Die coder.md-Lesson "sofort extrahieren" greift, wenn ein NEUER dritter Konsument hinzugefügt wird, aber ohne die bestehenden umzuhängen — hier wurde der neue (WorkspaceMutator) via shared helper implementiert; der alte (GitHubCloner) ist bereits korrekt und wartet auf ein Folge-Item. → Suggestion, nicht Important.

## 2026-06-07 — GIT_ASKPASS-Protokoll: immer gegen bestehende korrekte Implementierung vergleichen
Bei einer neuen GIT_ASKPASS-Implementierung im Diff immer gegen die bestehende korrekte Version (GitHubCloner.#writeAskpassScript) vergleichen — nicht nur prüfen ob der Token im argv auftaucht. Das ASKPASS-Protokoll erfordert prompt-sensitives Branching (Username vs. Password); ein Skript das denselben Wert für alle Prompts ausgibt, ist falsch und führt zu Produktions-Fehlern, auch wenn alle Tests grün sind (weil Tests execFn mocken und git nie wirklich aufgerufen wird).

## 2026-06-07 — Symlink-Flucht bei git-Subprozessen: cwd-Resolution prüfen, nicht nur Eingabe-Traversal
Wenn ein git-Kommando mit user-kontrolliertem cwd ausgeführt wird, muss explizit geprüft werden: (a) verhindert der Code Symlinks im cwd, die aus dem Workspace zeigen? und (b) wird realpath() verwendet oder nur lstat() + syntaktische Prüfung? lstat() prüft die Existenz des Symlinks selbst, resolvert ihn aber nicht. git pull FOLGT dem Symlink als cwd. Für delete (rm) reicht lstat — für git-Subprozess-cwd ist realpath zwingend. Reviewer-Test: suche nach `cwd: targetPath` im Diff → prüfe immer ob danach ein realpath-Check folgt.

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

