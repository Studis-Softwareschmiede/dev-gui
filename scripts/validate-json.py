#!/usr/bin/env python3
"""validate-json.py — echter JSON-Parser-Check für eine Datei (Pfad als Argument).

Zweck (S-061, regression-define AC13 Sicherheitsnetz):
  Nach dem Schreiben einer ergebnis_datei muss geprueft werden, dass der Inhalt
  echtes valides JSON ist. Diese Datei nimmt den Pfad als sys.argv[1] entgegen
  und liest den Inhalt vom Dateisystem — der Inhalt wird NIE in einen Shell-
  String interpoliert. Das vermeidet die Bash-Quoting-Kollision, die entsteht,
  wenn man `python3 -c "...<interpolierter JSON-Text mit Anführungszeichen>..."`
  baut (siehe .claude/lessons zu S-061, drei gescheiterte Voranläufe).

Aufruf:
    python3 scripts/validate-json.py <pfad-zur-datei>

Exit-Codes:
    0  — Datei existiert und enthält valides JSON (nichts wird ausgegeben)
    1  — Falsche Anzahl Argumente
    2  — Datei nicht lesbar (existiert nicht / keine Berechtigung)
    3  — Inhalt ist kein valides JSON (json.JSONDecodeError) — Fehlermeldung auf stderr
"""
import json
import sys


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: validate-json.py <pfad-zur-datei>", file=sys.stderr)
        return 1

    path = sys.argv[1]

    try:
        with open(path, "r", encoding="utf-8") as f:
            content = f.read()
    except OSError as exc:
        print(f"validate-json.py: Datei nicht lesbar: {path} ({exc})", file=sys.stderr)
        return 2

    try:
        json.loads(content)
    except json.JSONDecodeError as exc:
        print(f"validate-json.py: kein valides JSON in {path}: {exc}", file=sys.stderr)
        return 3

    return 0


if __name__ == "__main__":
    sys.exit(main())
