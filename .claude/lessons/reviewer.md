# Reviewer Lessons — dev-gui (newest first)

## 2026-06-07 — WS-Spy-Claim im Header braucht echten WS-Spy-Test
Wenn ein Test-Datei-Header "no WS call" als abgedeckt deklariert, muss ein `globalThis.WebSocket`-Spy-Test existieren — auch wenn die Komponente trivial ist und offensichtlich keinen WS-Aufruf macht. Die Regel (`coder.md 2026-05-27: Test-Header-Claim muss alle beworbenen Fälle abdecken`) gilt unabhängig von der Trivialitat der Komponente. Erst wenn der Test existiert, ist der Claim belegt. Ohne Test ist es eine Important-Finding.

