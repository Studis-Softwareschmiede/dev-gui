---
id: obsidian-vault-folder-browser
title: Obsidian-Vault-Ordner-Browser + verständliche Mount-fehlt-Meldung
status: active
area: einstellungen
version: 1
spec_format: use-case-2.0
---

# Spec: Obsidian-Vault-Ordner-Browser + verständliche Mount-fehlt-Meldung (`obsidian-vault-folder-browser`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer` — hartes Drift-Gate. Security-relevant (Dateisystem-Lese-Boundary, Path-Traversal/Symlink — gleiche Härte wie [[obsidian-vault-config]] AC3).

> **Anlass (Owner-Vorfall 2026-07-18):** Die Obsidian-Sektion der Einstellungen ([[obsidian-vault-config]] AC1, `ObsidianVaultPathSection`) verlangt den Vault-Pfad als **Container-Pfad** unterhalb der Mount-Schranke `OBSIDIAN_VAULT_DIR` (Default `/obsidian-vault`). Der Owner gab seinen **Mac-Host-Pfad** ein und bekam die technische Meldung „Pfad '…' liegt außerhalb der gemounteten Schranke OBSIDIAN_VAULT_DIR …" — für ihn unverständlich. Zusätzlich war der Mount gar nicht eingerichtet (`OBSIDIAN_VAULT_HOST_DIR` fehlte in der lokalen `.env`; Compose mountet dann `/dev/null` nach `/obsidian-vault` — der Pfad ist dann **kein Verzeichnis**, sondern ein Character-Device). Diese Spec ergänzt zwei Dinge: (1) einen **server-seitigen, read-only Ordner-Browser**, mit dem der Owner den Container-Pfad **klickt statt tippt**, und (2) eine **Mount-fehlt-Erkennung** mit einer **Alltagssprache-Anleitung** statt der technischen Schranken-Meldung.

## Zweck
Der Owner soll den Obsidian-Vault-Pfad in den Einstellungen **per Ordner-Browser auswählen** können statt ihn als Container-Pfad zu tippen, und bei nicht nutzbarer Mount-Schranke eine **verständliche Anleitung** statt einer technischen Fehlermeldung erhalten. Der Browser ist bewusst **server-seitig** (ein read-only Verzeichnis-Listing-Endpunkt, strikt confined auf `OBSIDIAN_VAULT_DIR`), weil ein nativer Browser-Dateidialog keine absoluten Server-/Host-Pfade liefern kann. Die bestehende Set-/Speichern-Validierung ([[obsidian-vault-config]] AC2/AC3, `PUT /api/settings/obsidian-vault-path`) bleibt **unverändert das Gate** — der Browser liefert nur einen Kandidaten-Pfad in dieses Feld.

> **Muster:** Confinement-Härte und `realpath`/Trailing-Slash-Prefix-Technik bewusst 1:1 gespiegelt von `src/obsidianVaultPath.js` ([[obsidian-vault-config]] AC3, `listObsidianVaultProjects`). Der neue Browse-Endpunkt ist die read-only-Verallgemeinerung derselben Confinement-Linie auf einen **beliebigen** Unterordner unterhalb der Mount-Schranke (statt nur `<vault>/<Projekt-Unterordner>`).

## Verhalten

### Mount-Health-Erkennung (Backend)
1. Das Backend leitet aus der Env `OBSIDIAN_VAULT_DIR` einen **Mount-Status** ab:
   - **`unconfigured`** — `OBSIDIAN_VAULT_DIR` ist ungesetzt/leer: es gibt keine Confinement-Schranke, unter der gebrowst werden könnte.
   - **`unusable`** — `OBSIDIAN_VAULT_DIR` ist gesetzt, aber der Pfad **existiert nicht** oder ist **kein Verzeichnis** (z. B. der `/dev/null`-Mount → Character-Device). Das ist der Owner-Vorfall (fehlender `OBSIDIAN_VAULT_HOST_DIR`).
   - **`ok`** — `OBSIDIAN_VAULT_DIR` ist gesetzt, existiert und ist ein Verzeichnis (unabhängig davon, ob es leer ist — ein leeres, korrekt gemountetes Vault-Root ist ein gültiger, wenn auch inhaltsloser Zustand).
2. Der Mount-Status ist **read-only Betreiber-Info** (kein Secret) und wird der UI zugänglich gemacht, damit sie zwischen technischem und Alltags-Fall unterscheiden kann.

### Ordner-Browser-Endpunkt (Backend)
3. Ein **read-only** Endpunkt listet die **direkten Unterordner** eines Container-Pfads **innerhalb** der Mount-Schranke `OBSIDIAN_VAULT_DIR`. Ohne `path`-Parameter wird das Mount-Root selbst aufgelistet.
4. Die Antwort enthält: den confinten aktuellen Pfad, den Eltern-Pfad (oder `null` am Root), eine **Breadcrumb**-Kette (Root → aktueller Ordner) und die Liste der **Unterordner** (`{ name, path }`). Nur **Verzeichnisse** (nach Symlink-Auflösung); keine Dateien, keine versteckten/Dot-Ordner; stabil nach `name` sortiert. Es werden **nie Datei-Inhalte** gelesen oder zurückgegeben.
5. **Confinement (Security-Floor, hart):** jeder aufzulistende Pfad und jeder Eintrag wird per `realpath` aufgelöst und **muss innerhalb** von `realpath(OBSIDIAN_VAULT_DIR)` liegen (Trailing-Slash-Prefix-Technik, kein nacktes `startsWith`). Ein `path`-Parameter mit `..`, ein absoluter Pfad außerhalb der Schranke oder ein Symlink, der aus der Schranke hinausführt, wird abgewiesen (kein Listing außerhalb); ein einzelner Eintrag, der aus der Schranke hinauszeigt (Symlink-Flucht), wird still übersprungen statt gelistet — dieselbe Härte wie [[obsidian-vault-config]] AC3.
6. Ist der Mount-Status `unusable`/`unconfigured`, liefert der Browse-Endpunkt einen **definierten** Fehler mit dem Mount-Status (kein Crash, kein Listing) — die UI zeigt dann die Alltags-Anleitung statt der Ordner-Liste.

### Ordner-Browser + Meldung (Frontend)
7. In der Obsidian-Sektion der Einstellungen öffnet ein **„Durchsuchen"-Button** den Ordner-Browser: er zeigt die Unterordner-Liste des aktuellen Pfads, eine **Breadcrumb**/„Zurück"-Navigation und pro Unterordner einen Eintrag zum Hineinnavigieren. **„Diesen Ordner verwenden"** übernimmt den **Container-Pfad** des aktuellen Ordners in das bestehende Vault-Pfad-Feld/den Speichern-Flow (`PUT /api/settings/obsidian-vault-path`) — die bestehende PUT-Validierung ([[obsidian-vault-config]] AC2/AC3) bleibt unverändert das Gate (wählt der Owner einen Ordner ohne gültigen Projekt-Unterordner, weist der bestehende PUT-Pfad ihn wie bisher ab).
8. Ist der Mount-Status `unusable`/`unconfigured`, zeigt die Sektion **statt** der technischen Schranken-Meldung eine **Alltagssprache-Anleitung**: was los ist („Der Obsidian-Ordner ist noch nicht in den Container hineingereicht") und was zu tun ist (auf dem Mac: `OBSIDIAN_VAULT_HOST_DIR=<Pfad>` in die lokale `.env` neben `docker-compose.yml` setzen, dann Container neu erstellen; Verweis auf `docs/obsidian-vault-mount-runbook.md`). Der „Durchsuchen"-Button ist in diesem Zustand **deaktiviert** mit demselben Hinweis. Die bestehende technische Validierungsmeldung darf als Detail erhalten bleiben, aber die Alltags-Erklärung **führt**.
9. Das bestehende **Freitext-Feld bleibt als Fallback** bestehen (kein Zwang zum Browser); die bestehende Set-/Ändern-/Löschen-Funktion ([[obsidian-vault-config]] AC1) bleibt unverändert.

## Acceptance-Kriterien
- **AC1** — Das Backend leitet aus `OBSIDIAN_VAULT_DIR` einen Mount-Status ab: `unconfigured` (Env ungesetzt/leer), `unusable` (Env gesetzt, aber Pfad existiert nicht **oder** ist kein Verzeichnis — inkl. `/dev/null`-Character-Device), `ok` (Env gesetzt, existiert, ist Verzeichnis). Der Status ist über einen read-only Endpunkt (bzw. als Feld des bestehenden Vault-Pfad-Zustands) hinter der Access-Mauer abrufbar; kein Secret in Response/Log. *(1,2)*
- **AC2** — `GET …/obsidian-vault/browse` (read-only, hinter AccessGuard) liefert bei Mount-Status `ok` die **direkten Unterordner** eines Container-Pfads innerhalb `OBSIDIAN_VAULT_DIR` als `{ path, parent, breadcrumb: [{name,path}], entries: [{name,path}] }` — nur Verzeichnisse, keine Dot-Ordner, keine Dateien, stabil nach `name` sortiert; ohne `path`-Parameter wird das Mount-Root aufgelistet. Es werden nie Datei-Inhalte gelesen/zurückgegeben. *(3,4)*
- **AC3** — **Traversal-/Symlink-Schutz (Security-Floor, hart):** ein `path`-Parameter mit `..`, ein absoluter Pfad außerhalb `OBSIDIAN_VAULT_DIR` oder ein Symlink, der aus der Schranke hinausführt, wird mit `4xx` und klarer Meldung abgewiesen, **ohne** außerhalb zu listen; ein einzelner Unterordner-Eintrag, dessen `realpath` aus der Schranke hinauszeigt (Symlink-Flucht), wird still übersprungen (nicht gelistet). `realpath`-Auflösung beider Seiten + Trailing-Slash-Prefix — identische Technik/Härte wie [[obsidian-vault-config]] AC3 (`src/obsidianVaultPath.js`). Traversal-/Symlink-Fälle sind mit Tests abgedeckt (analog `test/` zu `obsidianVaultPath`). *(5)*
- **AC4** — Ist der Mount-Status `unusable`/`unconfigured`, liefert der Browse-Endpunkt einen **definierten** Fehler (`409` mit `{ mountStatus }`), **kein** Crash und **kein** Listing; ein Race (Mount verschwindet zwischen Status-Read und `readdir`) liefert einen definierten `4xx`, kein Crash. *(6)*
- **AC5** — Die neuen Endpunkte sind **read-only** und hinter der Access-Mauer (`/api/*`, kein zusätzlicher Rollencheck — kein Geheimnis, keine Mutation); kein Secret in Response oder Log. Kein neuer PTY-Pfad, kein Anthropic-API. *(3,5)*
- **AC6** — In der Obsidian-Settings-Sektion öffnet ein **„Durchsuchen"-Button** den Ordner-Browser (Breadcrumb/„Zurück" + Unterordner-Liste, Navigation in Unterordner). **„Diesen Ordner verwenden"** übernimmt den Container-Pfad des aktuellen Ordners in den bestehenden Vault-Pfad-Speichern-Flow (`PUT /api/settings/obsidian-vault-path`); die bestehende PUT-Validierung bleibt unverändert das Gate. *(7)*
- **AC7** — Bei Mount-Status `unusable`/`unconfigured` zeigt die Sektion **statt** der technischen Schranken-Meldung eine **Alltagssprache-Anleitung** (was los ist + Mac-Schritt: `OBSIDIAN_VAULT_HOST_DIR` in die lokale `.env` setzen, Container neu erstellen + Verweis auf `docs/obsidian-vault-mount-runbook.md`); der „Durchsuchen"-Button ist deaktiviert mit demselben Hinweis. Die technische Validierungsmeldung darf als Detail erhalten bleiben, aber die Alltags-Erklärung führt. *(8)*
- **AC8** — Das bestehende **Freitext-Feld bleibt als Fallback** (kein Zwang zum Browser); die bestehende Set-/Ändern-/Löschen-Funktion ([[obsidian-vault-config]] AC1, `ObsidianVaultPathSection`) bleibt verhaltensunverändert. *(9)*
- **AC9** — **A11y (WCAG 2.1 AA, docs/design.md):** der Ordner-Browser ist tastaturbedienbar (Navigation, „Diesen Ordner verwenden", „Zurück"/Breadcrumb), Fokusführung beim Öffnen/Übernehmen/Schließen, Bedienziele ≥44px, aria-Labels für Navigations-/Auswahl-Elemente, Zustände (leer / deaktiviert / Fehler) nicht nur über Farbe kommuniziert (`role=status`/`alert`, `aria-disabled`/`disabled` + Textbegründung). *(7,8)*

## Verträge
> Persistenz/Andockpunkt: der Browse-Endpunkt schreibt **nichts** — reine Leseoperation auf dem Dateisystem innerhalb der Mount-Schranke. Kein neues Store-/DB-Element.

- **`GET /api/settings/obsidian-vault-path`** (bestehend, [[obsidian-vault-config]]) wird um ein Feld **`mountStatus: 'ok'|'unusable'|'unconfigured'`** erweitert (additive, rückwärtskompatible Erweiterung des bestehenden `{ vaultPath, configured, mountRoot? }`). Alternativ ein eigener read-only Endpunkt — bindend ist nur: die UI kann den Mount-Status hinter der Access-Mauer abrufen, ohne Secret. *(Detail-Entscheidung `architekt`; Default dieser Spec: additives Feld am bestehenden Endpunkt.)*
- **`GET /api/settings/obsidian-vault/browse`** (read-only, hinter AccessGuard) — Query `?path=<container-pfad>` (optional; Default = `OBSIDIAN_VAULT_DIR`-Root).
  - **200** `{ root: string, path: string, parent: string|null, breadcrumb: Array<{name:string,path:string}>, entries: Array<{name:string,path:string}> }` — `path`/`parent`/jeder `entries[].path` ist **realpath-confined** innerhalb `OBSIDIAN_VAULT_DIR` (AC3). `entries` = direkte Unterordner (nur Verzeichnisse, keine Dot-Ordner), stabil nach `name` sortiert.
  - **409** `{ mountStatus: 'unusable'|'unconfigured' }` — Mount-Schranke nicht nutzbar (AC4).
  - **4xx** (`400`/`422`) bei `path` außerhalb der Schranke / `..` / Symlink-Flucht — klare Meldung, kein Listing außerhalb (AC3).
  - **404** wenn der angefragte `path` (mehr) nicht existiert (Race) — kein Crash (AC4).
- **Env `OBSIDIAN_VAULT_DIR`** (bestehend, Default `/obsidian-vault`) — die Confinement-Schranke, aus deren Existenz/Verzeichnis-Charakter der Mount-Status abgeleitet wird. Deploy-Zeit-Konfiguration (docker-compose, `OBSIDIAN_VAULT_HOST_DIR` → `/obsidian-vault`), unverändert; diese Spec ändert **nichts** an Compose/Deploy.

## Edge-Cases & Fehlerverhalten
- `OBSIDIAN_VAULT_DIR` ungesetzt → Browse `409 { mountStatus: 'unconfigured' }`; UI zeigt Alltags-Anleitung, „Durchsuchen" deaktiviert.
- `OBSIDIAN_VAULT_DIR` gesetzt, aber `/dev/null`-Mount (Character-Device) → Mount-Status `unusable`, Browse `409 { mountStatus: 'unusable' }`; UI zeigt Alltags-Anleitung (Owner-Vorfall).
- `OBSIDIAN_VAULT_DIR` existiert, ist Verzeichnis, aber **leer** → Mount-Status `ok`, Browse `200` mit `entries: []` (kein Fehler — leeres, gültiges Root).
- `path`-Parameter zeigt auf eine **Datei** statt Verzeichnis → `4xx` (nur Verzeichnisse browsebar).
- `path`-Parameter mit `..`, das aus der Schranke hinausführt → `4xx`, kein Listing außerhalb (AC3).
- Symlink innerhalb der Schranke, der aus dem Vault hinauszeigt → als Eintrag **nicht** gelistet (übersprungen, AC3); als `path`-Parameter → `4xx`.
- Mount wird zwischen Status-Read und `readdir` extern entfernt/unmounted (Race) → definierter `4xx`/`404`, kein Crash.
- Owner wählt per Browser einen Ordner **ohne** gültigen Projekt-Unterordner → der bestehende `PUT` weist ihn mit der bestehenden `422`-Meldung ab (Gate unverändert); der Browser ändert daran nichts.

## NFRs
- **Sicherheit (Floor, hart):** Dateisystem-Zugriff des Browse-Endpunkts strikt auf `OBSIDIAN_VAULT_DIR` confined (Path-Traversal-/Symlink-sicher), read-only, nur Verzeichnis-Namen — nie Datei-Inhalte. Kein Secret in Response/Log/Audit. Endpunkte hinter der Access-Mauer.
- **A11y:** WCAG 2.1 AA (docs/design.md) — Tastaturbedienung, Fokusführung, Touch-Ziele ≥44px, aria, Zustände nicht nur über Farbe.
- **Kompatibilität:** additive Erweiterung — bestehende Vault-Pfad-Endpunkte/-UI ([[obsidian-vault-config]]) bleiben verhaltensunverändert; Freitext-Fallback bleibt.
- **Kein neuer Ausführungspfad:** rein Express-Endpunkt + React-UI (Muster der bestehenden Settings-Sektion); kein Anthropic-API, kein neuer PTY-Pfad.

## Nicht-Ziele
- **Host-/Mac-Pfade** im Browser auflisten — der Browser ist server-seitig und zeigt nur **Container-Pfade** innerhalb der Mount-Schranke (technische Leitplanke, mit Owner geklärt).
- **Datei-Auswahl / Datei-Inhalte** — nur Verzeichnisse, nie Dateien oder deren Inhalt.
- **Mount-/Volume-Konfiguration über die GUI ändern** — bleibt Deploy-Zeit (`OBSIDIAN_VAULT_HOST_DIR`, docker-compose, Runbook); diese Spec ändert Compose/Deploy nicht.
- **Änderung der bestehenden PUT-Validierung** ([[obsidian-vault-config]] AC2/AC3) — sie bleibt unverändert das Gate; der Browser liefert nur einen Kandidaten-Pfad.
- **Mehrere Vaults / mehrere Mount-Roots** — unverändert ein Root ([[obsidian-vault-config]] Nicht-Ziel).

## Abhängigkeiten
- [[obsidian-vault-config]] (Basis: Vault-Pfad-Endpunkte/-UI, `OBSIDIAN_VAULT_DIR`-Schranke, Confinement-Technik in `src/obsidianVaultPath.js`, `ObsidianVaultPathSection`; PUT-Validierung bleibt das Gate).
- [[access-and-guardrails]] (Access-Mauer vor `/api/*`).
- [[settings-panel-navigation]] (Einstellungen-Panel/Integrationen-Kategorie, in der die Obsidian-Sektion lebt).
- `docs/obsidian-vault-mount-runbook.md` (Betreiber-Anleitung, auf die die Alltags-Meldung verweist).

## Offene Annahmen (mangels Rückfrage-Möglichkeit als Subagent konservativ gesetzt — vom Owner bestätigbar)
- **A1 (Mount-Status-Andockpunkt):** Der Mount-Status wird als **additives Feld `mountStatus`** am bestehenden `GET /api/settings/obsidian-vault-path` geliefert (statt eines neuen Endpunkts) — konservativ, weil rückwärtskompatibel und ohne neue Route. `architekt` kann einen eigenen Endpunkt vorziehen; das Verhalten (AC1) bleibt gleich.
- **A2 („leer" zählt nicht als `unusable`):** Ein korrekt gemountetes, aber **leeres** Vault-Root gilt als `ok` (gültiger, inhaltsloser Zustand) — nur „existiert nicht" / „kein Verzeichnis" sind `unusable`. Der Owner-Wortlaut bündelte „ist leer" mit dem Fehlerfall; konservativ (weniger falsch-negative Sperren) wird „leer" hier **nicht** als Fehler behandelt, sondern zeigt eine leere Ordner-Liste. Soll ein leeres Root ebenfalls die Alltags-Anleitung auslösen, ist das eine bewusste Umentscheidung — dann wird AC1 um „leeres Verzeichnis → `unusable`" geschärft.
- **A3 (Browse-Query-Kontrakt):** `?path=<container-pfad>` als absoluter Container-Pfad innerhalb der Schranke; Default (ohne Param) = Mount-Root. Relative-vs-absolute-Detail ist `coder`/`architekt`-Ausgestaltung, solange das Confinement (AC3) hart bleibt.
