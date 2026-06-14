---
id: team-entity-icons
title: Entity-Icons — Icon-System für Agenten/Skills/Knowledge (TeamView + Boards-Ausblick)
status: draft
version: 1
---

# Spec: Entity-Icons — Icon-System für Agenten/Skills/Knowledge (`team-entity-icons`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer` (hartes Drift-Gate).

## Zweck
Stattet die dev-gui mit einem **wiederverwendbaren Icon-System** für die drei Entity-Typen der Fabrik — **Agent**, **Skill**, **Knowledge** — aus. Statt die Einträge rein textuell darzustellen, bekommt jeder Eintrag ein **Icon** mit typ-spezifischer **Akzentfarbe**, sodass die drei Typen auf einen Blick unterscheidbar sind und einzelne Rollen (z.B. `coder`, `dba`) ein erkennbares Symbol tragen. Erstes Einsatzfeld ist die **Team-Ansicht** ([[team-view-frontend]], [[team-detail-related-refs]]); das System wird so geschnitten, dass dieselbe `<EntityIcon>`-Komponente später auf **Boards/Story-Cards** (GitHubView, heute Platzhalter) wiederverwendbar ist (Ausblick, nicht Teil der ersten Umsetzung).

## Designentscheidungen (mit dem Betreiber bereits abgestimmt — keine offenen Rückfragen)
- **(a) Icon-Technik — `lucide-react`** (neue Dependency in `client/`-Abschnitt der `package.json`). Monochrome SVG-Icons, einfärbbar über `currentColor`, passend zum Dark-Theme und WCAG AA. *Dies ist eine bewusste, eng begrenzte Ausnahme von der „keine neue externe Bibliothek"-Klausel der Team-Specs ([[team-view-frontend]] AC10, [[team-detail-related-refs]] AC10): erlaubt ist ausschliesslich `lucide-react` als Icon-Quelle; weiterhin verboten bleiben externe Markdown-/Router-/Graph-/Chart-Libraries. Der generische Security-/A11y-Floor (kein `dangerouslySetInnerHTML`/`innerHTML`, keine Secrets, nur `/api/team*`) bleibt vollständig in Kraft.*
- **(b) Icon-Quelle — zentrale Registry IM dev-gui.** Das Mapping lebt vollständig in der dev-gui; **kein Eingriff** ins fremde agent-flow-Plugin-Repo, **kein** neues `icon`-Feld in Frontmatter/Datenmodell. Ein optionaler Frontmatter-`icon:`-Override ist **explizit Out-of-Scope** (spätere Phase).
- **(c) Typ-Differenzierung über Akzentfarbe.** Je Typ (Agent/Skill/Knowledge) eine eigene Akzentfarbe; Bedeutung trägt weiterhin das **Text-Label** (Icon ist dekorativ, `aria-hidden`) — Farbe ist nie alleinige Bedeutung (docs/design.md, WCAG AA).
- **(d) Deterministischer Monogramm-Fallback.** Existiert kein passendes Icon, wird ein stabiles Buchstaben-Badge erzeugt (erster Buchstabe der id, Farbe per Hash der id) — kein zufälliges/instabiles Rendering, keine leeren Lücken.

## Verhalten

### Icon-Registry (`client/src/icons/iconRegistry.js`)
1. Die Registry exportiert ein **Typ-Default-Mapping** `kind ('agent'|'skill'|'knowledge') → { Icon, accentColor }`: je Typ ein lucide-Default-Icon und eine **typ-spezifische Akzentfarbe** (drei unterscheidbare Farben, alle WCAG-AA-konform auf dem Dark-Theme-Hintergrund). Vorschlag: Skill-Default → `Zap`, Knowledge-Default → `BookOpen`, Agent-Default → `Users` (oder gleichwertig).
2. Die Registry exportiert zusätzlich ein **individuelles Mapping** `id (bzw. Gruppe) → lucide-Icon` für bekannte Rollen. Rollen-Mapping (Agenten): `coder→Code`, `architekt→Compass`, `dba→Database`, `designer→Palette`, `requirement→ClipboardList`, `teamLeader→Users`, `reviewer→ShieldCheck`, `tester→FlaskConical`, `cicd→Rocket`, `estimator→Scale`, `retro→RefreshCw`, `train→GraduationCap`.
3. Die Registry stellt eine **reine Auflösungsfunktion** bereit (z.B. `resolveIcon({ kind, id, group })`), die die **Fallback-Kaskade** kapselt und für gleiche Eingaben **immer dasselbe** Ergebnis liefert (deterministisch). Sie führt **keine** Seiteneffekte aus und liest **keine** Daten von ausserhalb (kein Fetch, kein FS).

### Fallback-Kaskade (in `EntityIcon` bzw. der Auflösungsfunktion)
4. Die Icon-Auswahl folgt strikt dieser Reihenfolge:
   1. **explizites Registry-Mapping** für `id` (bzw. `group` bei Knowledge) — falls vorhanden,
   2. sonst das **Typ-Default-Icon** für `kind`,
   3. sonst (unbekannter/fehlender `kind`) ein **deterministisches Monogramm-Badge**: erster Buchstabe der `id` (uppercased), Hintergrund-/Akzentfarbe **deterministisch aus einem Hash der `id`** abgeleitet — gleiche id ⇒ gleiches Badge über Reloads/Renders hinweg.
5. Die **Akzentfarbe** richtet sich primär nach dem **Typ** (Regel 1c). Beim Monogramm-Fallback (Stufe 3, kein bekannter Typ) wird die Farbe aus dem id-Hash bestimmt.

### EntityIcon-Komponente (`client/src/icons/EntityIcon.jsx`)
6. `<EntityIcon kind id group size />` rendert das aufgelöste Icon (bzw. das Monogramm-Badge) in der angegebenen `size` (Default sinnvoll, z.B. 16 px); fehlt `size`, gilt der Default.
7. Das gerenderte Icon ist **dekorativ**: es trägt `aria-hidden="true"` (bzw. `role="img"` ohne sprechende Bedeutung) und **keinen** eigenständigen, bedeutungstragenden Text — die Bedeutung bleibt am sichtbaren Text-Label des umgebenden Eintrags. Es wird **kein** `dangerouslySetInnerHTML`/`innerHTML` verwendet (lucide rendert React-SVG-Elemente).
8. `<EntityIcon>` ist **rein präsentational**: kein Fetch, kein Zugriff auf `window`/Netzwerk, keine Secrets; für unbekannte/fehlende Props (kein `id`, kein `kind`) stürzt es **nicht** ab, sondern degradiert über die Kaskade (Regel 4) zu einem stabilen Fallback (mind. ein leeres, aber valides Badge — niemals ein Crash oder leeres Fragment, das das Layout bricht).

### Einbau in die Team-Ansicht (`client/src/TeamView.jsx`)
9. **NavItem:** Jeder Listeneintrag zeigt **vor** dem Namen ein `<EntityIcon kind id group size />` (kleine Grösse). Das Icon ist `aria-hidden`; der sichtbare Name bleibt unverändert die Bedeutung; `aria-current` und Fokusverhalten des Buttons bleiben unverändert ([[team-view-frontend]] AC4/AC8 unberührt).
10. **DetailPane:** Im Kopf des Detail-Panes erscheint ein **grosses Kopf-Icon** (grössere `size`) neben dem Titel (`name`/`id`), passend zur Akzentfarbe des Typs. Layout/Lesbarkeit bleiben WCAG-AA-konform.
11. **Related-Chips:** Die Chips für `relatedSkills`, `relatedKnowledge` und `usedByAgents` ([[team-detail-related-refs]] AC7/AC9) zeigen je ein **Mini-Icon** vor dem Label. Die Chips bleiben fokussierbare, per Tastatur aktivierbare Bedienelemente mit sichtbarem Fokusring ([[team-detail-related-refs]] AC10 unberührt); das Mini-Icon ist `aria-hidden`.
12. **Keine Verhaltensänderung** an Datenfluss, Routing, Navigation oder API: Es werden **keine** neuen Endpunkte aufgerufen, **kein** neues Datenfeld konsumiert; die Icons werden allein aus den bereits vorhandenen `kind`/`id`/`group` der Team-Daten abgeleitet.

## Acceptance-Kriterien

### Etappe 1 — Icon-Primitive (referenziert vom Item „Icon-Primitive")
- **AC1** — `lucide-react` ist als Dependency im `client`-Abschnitt der `package.json` deklariert und installierbar; `npm ci` / Build (`vite build`) und `npm test` laufen weiterhin grün. Es wird **keine** weitere externe Bibliothek hinzugefügt.
- **AC2** — `client/src/icons/iconRegistry.js` exportiert (a) ein Typ-Default-Mapping `kind → { Icon, accentColor }` für `agent`/`skill`/`knowledge` mit **drei unterscheidbaren** Akzentfarben und (b) das individuelle Rollen-Mapping aus Regel 2 (mindestens die zwölf gelisteten Agenten-ids → die genannten lucide-Icons).
- **AC3** — Die Auflösung ist **deterministisch** und folgt der Kaskade aus Regel 4 (explizites Mapping → Typ-Default → Monogramm-Badge). Für eine bekannte Rolle (z.B. `id:'coder'`, `kind:'agent'`) wird das explizite Icon gewählt; für einen unbekannten Agenten das Agent-Typ-Default; für einen unbekannten `kind` das Monogramm-Badge.
- **AC4** — Das Monogramm-Badge ist **stabil pro id**: der angezeigte Buchstabe (erster Buchstabe der id, uppercased) und die abgeleitete Farbe ergeben sich **deterministisch aus der id** und sind über wiederholte Aufrufe/Renders identisch (gleiche id ⇒ gleiches Badge).
- **AC5** — `client/src/icons/EntityIcon.jsx` rendert für `kind`/`id`/`group` das aufgelöste lucide-Icon bzw. das Monogramm-Badge; `size` steuert die Grösse (Default greift, wenn nicht gesetzt). Das Icon trägt `aria-hidden="true"` und keinen bedeutungstragenden Text.
- **AC6** (Robustheit) — `<EntityIcon>` ohne `id` und/oder ohne bekannten `kind` rendert **ohne Crash** ein valides Fallback (kein leeres Fragment, das das Layout bricht); die Komponente macht **keinen** Fetch und greift nicht auf Netzwerk/Secrets zu.
- **AC7** (A11y/Floor) — Icon-Farben sind nicht alleinige Bedeutungsträger (Text-Label bleibt massgeblich); Kontrast der Akzentfarben WCAG-AA-konform auf dem Dark-Theme-Hintergrund; **kein** `dangerouslySetInnerHTML`/`innerHTML`; keine Secrets im Bundle. Tests decken AC2–AC6 (Mapping, Kaskade, Determinismus, Fallback, `aria-hidden`) ab.

### Etappe 2 — Einbau in TeamView (referenziert vom Item „TeamView-Einbau")
- **AC8** — In der Navigationsliste rendert jedes `NavItem` ein `<EntityIcon>` **vor** dem Namen; der sichtbare Name, `aria-current` und das Fokus-/Tastaturverhalten des Buttons bleiben unverändert ([[team-view-frontend]] AC4/AC8 weiterhin erfüllt).
- **AC9** — Im `DetailPane` erscheint ein **grosses Kopf-Icon** neben Titel `name`/`id`, mit der Typ-Akzentfarbe.
- **AC10** — Die Chips für `relatedSkills`/`relatedKnowledge`/`usedByAgents` zeigen je ein Mini-`<EntityIcon>` vor dem Label; die Chips bleiben fokussierbare, per Tastatur (Enter/Space) aktivierbare Bedienelemente mit sichtbarem Fokusring und `loadDetail(kind,id)`-Klickverhalten ([[team-detail-related-refs]] AC8/AC9/AC10 weiterhin erfüllt).
- **AC11** — Alle eingebauten Icons sind `aria-hidden`; es werden **keine** neuen API-Aufrufe/Endpunkte und **kein** neues Datenfeld eingeführt — die Icons leiten sich allein aus vorhandenem `kind`/`id`/`group` ab. Bestehende TeamView-Tests bleiben grün; neue Tests belegen das Vorhandensein der Icons in NavItem, DetailPane-Kopf und Chips.

### Etappe 3 — Boards/Story-Cards (Ausblick, referenziert vom optionalen Item „Boards-Icons")
- **AC12** (Ausblick — nur wirksam, sobald Boards in der GUI umgesetzt sind) — Story-Cards verwenden **dieselbe** `<EntityIcon>`-Komponente; der `kind`/`id` wird aus einer **GitHub-Issue-Label-Konvention** abgeleitet (z.B. Label `agent:coder` → `kind:'agent', id:'coder'`, `skill:flow` → `kind:'skill', id:'flow'`). Es werden **keine** Änderungen an `iconRegistry`/`EntityIcon` nötig sein, die die TeamView-AC (AC8–AC11) brechen.

## Verträge
- **`client/src/icons/iconRegistry.js`** — exportiert das Typ-Default-Mapping (`kind → { Icon, accentColor }`), das individuelle id/group-Mapping und eine reine Auflösungsfunktion (z.B. `resolveIcon({ kind, id, group }) → { Icon, accentColor, monogram? }`). Keine Seiteneffekte, kein I/O.
- **`client/src/icons/EntityIcon.jsx`** — `({ kind, id, group, size }) → React-Element` (lucide-SVG oder Monogramm-Badge), `aria-hidden`, rein präsentational.
- **`client/src/TeamView.jsx`** — `NavItem`, `DetailPane` und die Chip-Komponente (`RefChips`) konsumieren `<EntityIcon>`; **keine** neue Route, **kein** neuer Endpunkt, **kein** neues Datenfeld.
- **`package.json`** — neue Runtime-Dependency `lucide-react` (einzige neue Bibliothek).
- **Daten-Shapes** unverändert aus [[team-view-backend]] / [[team-detail-related-refs]] (`{ id, name, model, tools, group, relatedSkills, relatedKnowledge, usedByAgents }`).

## Edge-Cases & Fehlerverhalten
- Unbekannte Agenten-id (nicht im Rollen-Mapping) → Agent-Typ-Default-Icon (Kaskade Stufe 2), nicht Monogramm.
- Eintrag mit fehlender/leerer `id` → Monogramm-Fallback ohne Crash (AC6); Buchstabe ggf. Platzhalter, aber valides Badge.
- Unbekannter/fehlender `kind` → Monogramm-Badge mit id-Hash-Farbe (Kaskade Stufe 3).
- Knowledge-id mit Sub-Pfad (`frameworks/spring-boot-3`) → Auflösung über `group`/`kind`-Default; Determinismus bleibt; kein Crash.
- Sehr lange Labels in Chips/NavItems → Icon bricht das Layout nicht (feste `size`, Icon vor Text).
- lucide stellt ein erwartetes Icon nicht bereit → Registry verwendet ein vorhandenes Ersatz-lucide-Icon; niemals ein Build-Fehler durch fehlenden Import.

## NFRs
- **A11y (WCAG 2.1 AA):** Icons dekorativ/`aria-hidden`, Bedeutung am Text-Label; Akzentfarben kontraststark, nie alleinige Bedeutung (AC7).
- **Sicherheit (Floor):** keine Secrets im Bundle; kein `dangerouslySetInnerHTML`/`innerHTML`; keine neuen Netzwerk-/API-Aufrufe; einzige neue Bibliothek ist `lucide-react`.
- **Determinismus/Robustheit:** identische Eingaben ⇒ identisches Icon/Badge; vollständige Degradation für unbekannte/fehlende Props ohne Crash.
- **Wiederverwendbarkeit:** `<EntityIcon>` ist view-unabhängig (kein TeamView-spezifischer State), damit Boards/Story-Cards sie unverändert nutzen können (AC12).
- **Performance:** rein synchrones, lokales Rendering; keine zusätzlichen Requests.

## Nicht-Ziele
- **Kein** Frontmatter-`icon:`-Override und **keine** Änderung am agent-flow-Plugin-Repo / am Datenmodell (zentrale Registry im dev-gui).
- **Keine** Anzeige/Umsetzung von Boards/Story-Cards in dieser Spec-Phase — AC12 ist reiner Ausblick; GitHubView bleibt Platzhalter.
- **Keine** weitere externe Bibliothek ausser `lucide-react`; **keine** externe Markdown-/Router-/Chart-/Graph-Lib.
- **Keine** Verhaltens-/API-/Routing-Änderung der Team-Ansicht; **kein** Editieren/Schreiben von Entities (read-only bleibt read-only).

## Abhängigkeiten
- [[team-view-frontend]] — TeamView/NavItem/DetailPane werden um Icons erweitert; die „keine externe Bibliothek"-Klausel (AC10) wird eng begrenzt um `lucide-react` ergänzt (nur Icons).
- [[team-detail-related-refs]] — Related-/Used-by-Chips werden um Mini-Icons erweitert; AC8–AC10 bleiben erfüllt.
- [[view-github]] / GitHubView (Platzhalter) — späteres Wiederverwendungsfeld der `<EntityIcon>` (AC12, Ausblick).
- `lucide-react` (neue externe Icon-Bibliothek, einzige erlaubte Ausnahme).
