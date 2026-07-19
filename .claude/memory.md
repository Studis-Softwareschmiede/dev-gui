> Orientierung, nie Wahrheit: bei Widerspruch gelten Board + docs/specs/.
> Kuratiert von /flow am Ende jeder Session. Max. 60 Zeilen.

## Aktueller Stand
Board ist leer — F-088 (Obsidian-Vault-Ordner-Browser + verständliche
Mount-fehlt-Meldung, S-378/S-379) ist gelandet und ausgerollt (Revision cd98eec),
direkt nach F-087 (Deployments-Untermenü + GPG-Schlüssel-Ansicht) und S-377
(Digest-Pin-Fix). Der Obsidian-Vault ist auf dem Mac eingerichtet:
OBSIDIAN_VAULT_HOST_DIR in lokaler .env, OBSIDIAN_PROJEKTE_SUBDIR
„300 Projekte/Studis Softwareschmiede" in compose aktiv, Settings-Pfad
/obsidian-vault gesetzt, mountStatus meldet live „ok".

## Letzte Arbeiten
- S-379 / Ordner-Browser-Overlay + Alltagssprache-Mount-Meldung in der Obsidian-Settings-Sektion; Freitext bleibt Fallback.
- S-378 / Mount-Status (unconfigured/unusable/ok, /dev/null-Fall) + read-only Browse-Endpunkt, hart vault-confined.
- S-376 / „Rotieren" je gewählter App in der GPG-Schlüssel-Ansicht (Zwei-Phasen-Rotation unverändert).
- S-375 / GPG-Ansicht: App-Dropdown + „Passphrase anlegen" mit Existenz-Gating.
- S-377 / Container-Update zieht bei Digest-Pin den beweglichen Tag nach (fail-closed `update-unsafe`).
- S-374 / Linkes Untermenü „Deployment"/„GPG-Schlüssel" in DeploymentsView.
- S-373 / Read-only `GET /api/deployments/:app/gpg-exists`.

## Offene Fäden
- Retro 2026-07-19: agent-flow PR #372 gemergt (Owner-Freigabe); Issue #371 (board-ship.sh worktree-tauglich) bleibt offen.
- Reviewer-Suggestion S-377: Digest-Pin-Fix beim nächsten echten VPS-Update einmal am realen Container verifizieren.
- Reviewer-Suggestions F-088 (Kosmetik): Fehler-Zweig von `fetchObsidianVaultBrowse` direkt unit-testen; Tab-Fokus-Trap für beide Obsidian-Overlays gemeinsam nachrüsten.
- Metrik-Ledger: flow/L05-Defekt BEHOBEN; `tok_total` zählt per Design in+out+cache (Millionenwerte normal).
