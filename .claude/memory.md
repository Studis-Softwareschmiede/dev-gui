> Orientierung, nie Wahrheit: bei Widerspruch gelten Board + docs/specs/.
> Kuratiert von /flow am Ende jeder Session. Max. 60 Zeilen.

## Aktueller Stand
Board ist leer — F-089 (Obsidian-Projekt-Unterordner in GUI wählbar, S-380/S-381)
ist gelandet und ausgerollt (Revision 0693b6d). Der Projekt-Unterordner ist damit
in Einstellungen → Integrationen persistierbar (Rangfolge persistiert→env→default);
die Compose-Env OBSIDIAN_PROJEKTE_SUBDIR steht seit 2026-07-19 auf „300 Projekte"
und ist nur noch Fallback. Vault auf dem Mac aktiv (/obsidian-vault, mountStatus ok).

## Letzte Arbeiten
- S-381 / GUI-Feld „Obsidian-Projekt-Unterordner" (Wert+Quelle, Ordner-Browser-Auswahl mit vault-relativer Segment-Ableitung, Freitext-Fallback, A11y).
- S-380 / Backend: meta-Block-Persistenz + resolveEffectiveProjekteSubdir (Rangfolge) + GET/PUT/DELETE /api/settings/obsidian-projekte-subdir (Confinement, Audit-First).
- S-379 / Ordner-Browser-Overlay + Alltagssprache-Mount-Meldung in der Obsidian-Settings-Sektion; Freitext bleibt Fallback.
- S-378 / Mount-Status (unconfigured/unusable/ok, /dev/null-Fall) + read-only Browse-Endpunkt, hart vault-confined.
- S-376 / „Rotieren" je gewählter App in der GPG-Schlüssel-Ansicht (Zwei-Phasen-Rotation unverändert).
- S-375 / GPG-Ansicht: App-Dropdown + „Passphrase anlegen" mit Existenz-Gating.
- S-377 / Container-Update zieht bei Digest-Pin den beweglichen Tag nach (fail-closed `update-unsafe`).

## Offene Fäden
- Retro 2026-07-19: agent-flow PR #372 gemergt (Owner-Freigabe); Issue #371 (board-ship.sh worktree-tauglich) bleibt offen.
- Reviewer-Suggestion S-377: Digest-Pin-Fix beim nächsten echten VPS-Update einmal am realen Container verifizieren.
- Reviewer-Suggestions F-088 (Kosmetik): Fehler-Zweig von `fetchObsidianVaultBrowse` direkt unit-testen; Tab-Fokus-Trap für die Obsidian-Overlays gemeinsam nachrüsten.
- Metrik-Ledger: flow/L05-Defekt BEHOBEN; `tok_total` zählt per Design in+out+cache (Millionenwerte normal).
