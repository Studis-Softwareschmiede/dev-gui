---
id: questions-pending-notification
title: "Fragen-offen-Push (questions_pending) — ein ntfy-Push bei needs-answers eines Obsidian-Ingest-Laufs"
status: active
area: benachrichtigungen
version: 1
---

# Spec: Fragen-offen-Push  (`questions-pending-notification`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
Meldeklasse **„Eingabe zwingend nötig"** ([[notification-event-defaults]]). Ein Obsidian-Ingest-Lauf
([[obsidian-question-catalog]] / `ObsidianIngestRunner`, S-250) hält an, wenn er in den
Interrupt-Zustand **`needs-answers`** wechselt — ein maschinenlesbarer Fragenkatalog wartet auf
die Antworten des Owners; das projektweise Lock bleibt gehalten, der Lauf ruht, bis über
`POST …/answers` fortgesetzt wird. Heute merkt der Owner das **nur**, wenn er zufällig das
UI-Overlay offen hat oder aktiv pollt. Diese Spec schickt **genau EINEN** ntfy-Push, sobald ein
Lauf in `needs-answers` wechselt — damit der Owner weiss, dass seine Eingabe gebraucht wird.

## Annahmen (konservativ, da nicht-interaktiv geklärt)
- **A1 — Ein Push je Eintritt in `needs-answers`.** Der Push feuert bei **jedem** Wechsel in
  den Zustand `needs-answers`. Liefert eine **Resume-Runde** (nach eingereichten Antworten)
  einen **weiteren** Fragenkatalog (erneuter Eintritt in `needs-answers`), ist das ein
  **echter neuer** „Eingabe nötig"-Moment → erneuter Push (kein Verschlucken, analog der
  Mehr-Übergangs-Regel in [[push-notifications]]).
- **A2 — Label statt Pfad.** Der Push nennt als Projektbezeichner den **Basename** (Blatt-Ordner)
  des Ingest-Projektpfads, **nie** den absoluten Host-Pfad (Security-Floor, analog
  [[obsidian-question-catalog]] AC6: `catalog`/`error`/`result` sind secret-/pfad-frei).
- **A3 — Emission im Runner.** Der Zustandswechsel nach `needs-answers` ist **nur** im
  `ObsidianIngestRunner` selbst beobachtbar (der Lauf ist fire-and-forget; der Router sieht
  den Wechsel nicht, der Client pollt nur `GET`). Der Push wird daher **im Runner** an der
  `needs-answers`-Setzstelle ausgelöst — best-effort, über einen **injizierten** Notifier
  (Muster `auditStore`); ohne injizierten Notifier ist es ein No-op.

## Verhalten
1. **Auslöser.** Im `ObsidianIngestRunner.#runRound` — an der Stelle, an der ein Job auf
   `status = 'needs-answers'` gesetzt wird (Interrupt, Lock bleibt gehalten) — wird best-effort
   **genau ein** Push ausgelöst.
2. **Gating.** Der Push wird **nur** gesendet, wenn Notifications global aktiviert (`enabled=true`)
   **und** `questions_pending` in `events` aktiviert sind ([[push-notifications]] AC8 /
   [[notification-event-defaults]]). Andernfalls kein Versand — der Interrupt-/Resume-Zustand
   des Laufs ist davon **unberührt**.
3. **Inhalt.** Titel „❓ <label>: Fragen offen" mit `<label>` = Basename des Projektpfads (A2);
   der Text nennt kompakt, dass ein Fragenkatalog auf Antworten wartet (optional die Anzahl
   offener Fragen `catalog.length` — secret-frei). **Keine** absoluten Pfade/Secrets, kein
   Fragen-Freitext, der Host-Pfade leaken könnte (nur Zähler/Label).
4. **Best-effort, non-fatal.** Ein Notify-Fehler (Netz/Non-2xx/Token-Lesefehler) wird
   strukturiert geloggt, bricht aber **weder** die Zustandsmaschine, **noch** das Lock-Handling,
   **noch** den Ingest-Lauf ab (degradierend, wie das best-effort-Audit im Runner). Der
   `needs-answers`-Zustand wird **unabhängig** vom Push-Ausgang gesetzt.
5. **Kein Push bei terminalen Zuständen.** `done`/`failed`/`auth-expired` lösen **keinen**
   `questions_pending`-Push aus (das ist nicht „Eingabe nötig"). „Arbeit fertig" für den Ingest
   ist **nicht** Teil dieser Spec (Nicht-Ziel).

## Acceptance-Kriterien

- **AC1 — Auslöser + Ein-Push-je-Eintritt.** Wechselt ein Job im `ObsidianIngestRunner` nach
  `needs-answers`, wird **genau ein** Push ausgelöst (A1). Ein späterer erneuter Eintritt in
  `needs-answers` (Resume liefert weitere Fragen) löst **erneut** genau einen Push aus. Ein
  Lauf, der direkt nach `done` geht (nie `needs-answers`), löst **keinen** Push aus. Testbar mit
  gemocktem Notifier + `runClaude`-Adapter, der `needs-answers` bzw. `done` liefert. *(1,5)*
- **AC2 — Gating.** Der Push wird **nur** gesendet, wenn Config `enabled=true` **und** `events`
  `questions_pending` enthält; sonst **kein** Versand. Das Gating ändert den `needs-answers`-Job-
  Zustand / das Lock / den Katalog **nicht** (byte-identisch zum heutigen Runner-Verhalten
  ohne Notifier). *(2)*
- **AC3 — Inhalt (Label, kein Pfad).** Der Payload-Titel lautet „❓ <label>: Fragen offen" mit
  `<label>` = Basename des Projektpfads (A2); der Text ist secret-/pfad-frei (optional
  `catalog.length` als Anzahl). Kein absoluter Host-Pfad, kein Token, kein Fragen-Freitext im
  Push/Log. *(3)*
- **AC4 — Best-effort, non-fatal.** Ein Notify-Fehler (oder ein fehlender/injektions-loser
  Notifier) crasht den Runner **nicht**: der Job erreicht `needs-answers`, der Katalog liegt an,
  das Lock bleibt gehalten, `answers()`/Resume funktionieren unverändert. Der `needs-answers`-
  Zustand wird **vor/unabhängig** vom Push-Ergebnis gesetzt. *(4)*
- **AC5 — Wiring + Default-Regress.** `server.js` injiziert denselben Notifier-Baustein (Config-
  Provider + Token-Getter + `sendNotification`, geteilt mit [[drain-done-notification]] /
  [[push-notifications]]) in den `ObsidianIngestRunner`. Ohne injizierten Notifier verhält sich
  der Runner **bit-identisch** zu heute (kein Push, keine Zustandsänderung). *(3, A3)*
- **AC6 — Sicherheit (Floor, hart).** Weder Push, Log noch Fehlermeldung enthalten den
  ntfy-Token, einen absoluten Host-Pfad, die claude-`session-id` oder Fragen-/Notiz-Freitext,
  der ein Secret tragen könnte — nur Label (Basename) + Zähler. Token bleibt store-intern
  ([[push-notifications]] AC1/AC10). *(3)*

## Verträge

### Notifier-Baustein (geteilt, sprach-neutral)
- Derselbe Config-/Token-/Versand-Baustein wie [[drain-done-notification]] (`getNotificationConfig`,
  `getToken`, `sendNotificationFn`). Diese Spec nutzt eine schmale Methode, z.B.
  `notifyQuestionsPending({ label, questionCount }) → Promise<void>`:
  - No-op wenn Config `enabled=false` **oder** `questions_pending` nicht in `events`.
  - sonst: Payload bauen (AC3), `sendNotificationFn(config, payload)`; Fehler gefangen +
    geloggt (best-effort), nie geworfen.

### `ObsidianIngestRunner` (Erweiterung, `src/ObsidianIngestRunner.js`)
- Konstruktor-`deps`: optionaler `notifier` (Default `null` → No-op). Kein Einfluss auf Lock/
  Zustandsmaschine.
- An der `needs-answers`-Setzstelle in `#runRound`: nach dem Setzen von `status='needs-answers'`
  + `catalog` best-effort `notifier?.notifyQuestionsPending({ label: basename(projectPath),
  questionCount: catalog.length })` (in try/catch, non-fatal, AC4).

### Payload (ausgehend, secret-frei)
```
title:   "❓ <label>: Fragen offen"        // <label> = basename(projectPath)
message: kompakter Hinweis (Label + optional Anzahl offener Fragen)
tags:    ["question"]                      // Implementierungswahl
```

## Edge-Cases & Fehlerverhalten
- **`enabled=false` / `questions_pending` nicht aktiviert** → kein Push, Zustand unberührt (AC2).
- **Kein Notifier injiziert** → No-op (AC5).
- **ntfy unerreichbar / Non-2xx / Token-Lesefehler** → geloggt (secret-frei), Runner läuft
  weiter, Katalog liegt an, Lock gehalten (AC4).
- **Resume → erneut `needs-answers`** → erneuter Push (A1/AC1).
- **`needs-answers` mit leerem/kaputtem Katalog** → wird bereits im Runner als `failed`
  behandelt (bestehendes Verhalten) → **kein** `questions_pending`-Push (kein Eintritt in
  `needs-answers`).
- **Projektpfad ohne verwertbaren Basename** (theoretisch) → Label defensiv auf leer/Fallback,
  nie der volle Pfad (AC6).

## NFRs
- **Sicherheit (Floor, hart):** keine Secrets/Token/absoluten Pfade/`session-id`/Freitext im
  Push/Log (AC6); Token store-intern ([[push-notifications]]).
- **Robustheit:** der Push darf die Interrupt/Resume-Zustandsmaschine + Lock-Disziplin des
  Runners **nie** stören (AC4) — best-effort, non-fatal.
- **Anti-Flut:** ein Push je Eintritt in `needs-answers` (A1) — kein Dauer-Polling, kein
  Wiederholen für denselben offenen Katalog.

## Nicht-Ziele
- **Kein** Push bei `done`/`failed`/`auth-expired` (nur `needs-answers`).
- **Keine** Änderung der Interrupt/Resume-Zustandsmaschine, des Locks oder des Fragenkatalogs
  ([[obsidian-question-catalog]] unverändert — nur additiver Push).
- **Kein** „Ingest fertig"-Push (das wäre Klasse „Arbeit fertig"; hier bewusst ausgeklammert).
- **Kein** zweiter Push-Anbieter (nur ntfy).

## Abhängigkeiten
- [[notification-event-defaults]] (`questions_pending` im Katalog + im Default-Satz —
  **Voraussetzung**).
- [[push-notifications]] (`NotifyService`, Notification-Config/Token/Gating; F-025).
- [[obsidian-question-catalog]] (`ObsidianIngestRunner`, `needs-answers`-Zustand, Lock-Disziplin,
  Secret-/Pfad-Freiheit) · [[obsidian-project-intake]] / [[obsidian-vault-config]]
  (vault-confined Projektpfad).
- [[drain-done-notification]] (geteilter Notifier-/Config-/Token-Baustein).
