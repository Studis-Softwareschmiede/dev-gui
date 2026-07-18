> Orientierung, nie Wahrheit: bei Widerspruch gelten Board + docs/specs/.
> Kuratiert von /flow am Ende jeder Session. Max. 60 Zeilen.

## Aktueller Stand
Board ist leer — F-087 (Deployments-Untermenü + kompakte GPG-Schlüssel-Ansicht,
S-373–S-376) und der Einzelgänger S-377 (Digest-Pin-Fix beim Container-Update)
sind gelandet und produktiv ausgerollt (Revision 9117e96). Die GPG-Verwaltung
lebt jetzt im Unterbereich „GPG-Schlüssel" der Deployments-Ansicht (Dropdown je
App, Anlegen mit Existenz-Gating, Rotieren via unveränderter Zwei-Phasen-Rotation).

## Letzte Arbeiten
- S-376 / „Rotieren" je gewählter App in der GPG-Schlüssel-Ansicht; Gates der Alt-UI (type-to-confirm-Discard) 1:1 erhalten.
- S-375 / GPG-Ansicht: App-Dropdown + „Passphrase anlegen" mit Existenz-Gating (gpg-exists), Race-Guard beim App-Wechsel.
- S-377 / Container-Update zieht bei Digest-gepinntem Bestands-Ref den beweglichen Tag nach (AC16/AC17, fail-closed `update-unsafe`).
- S-374 / Linkes Untermenü „Deployment"/„GPG-Schlüssel" in DeploymentsView; alte GPG-Listen-Sektionen entfernt.
- S-373 / Read-only `GET /api/deployments/:app/gpg-exists` (nie ein Passphrasen-Wert, access-not-ready-Fallback).

## Offene Fäden
- Reviewer-Suggestion S-377: Digest-Pin-Fix vor dem nächsten echten VPS-Rollout einmal gegen einen realen digest-gepinnten Container verifizieren (RepoTags liefert genau einen Eintrag).
- Metrik-Ledger: `dispatches.jsonl` enthält 4 korrupte Zeilen vom 2026-07-03 (flow/L05) — Owner-Entscheidung zum lokalen Entfernen steht aus; `tok_total`-Werte aus `metrics-collect` wirken zudem überhöht (Transcript-Matching zu breit).
- Kosmetik: Style-Namen `gpgDiscardConfirmLabel`/`gpgDiscardCheckbox` in DeploymentsView benennen nicht mehr ihre Funktion (Reviewer-Suggestion S-374).
