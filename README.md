dev-gui — GUI für die Softwareschmiede-Fabrik. Siehe docs/.

## Tests

- `npm test` — Haupt-Gate (CI). Ignoriert bewusst `.claude/worktrees/` (kein Einsammeln fremder Worktree-Tests).
- `npm run test:worktree` — dieselbe Suite, aber **aus einem git-Worktree** lauffähig (hebt die Worktree-Ignore für
  diesen einen Lauf auf, isolierter Jest-Cache). Nutzen, wenn du in `.claude/worktrees/<name>/` arbeitest.

Spec: `docs/specs/worktree-friendly-tests.md`.
