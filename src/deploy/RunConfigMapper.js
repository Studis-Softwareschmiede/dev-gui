/**
 * RunConfigMapper — bildet die Run-Config eines BESTEHENDEN Containers
 * (`VpsDockerControl.inspectContainer()`-Ergebnis) auf die Saga-Parameter von
 * `DeployOrchestrator.deploy()` ab (container-image-update AC6).
 *
 * Reiner, seiteneffektfreier Mapper — kein Docker-/SSH-I/O (das lebt in
 * `VpsDockerControl`, ADR-012). Hintergrund: es gibt keinen Deploy-State-Store
 * (ADR-005) — der bestehende Container ist die einzige Quelle seiner eigenen
 * Run-Config (Env, Mount, Label); ohne diese Rekonstruktion würde ein Update
 * Env und config-Mount still verlieren.
 *
 * Eindeutigkeits-Prädikat (container-image-update AC6/AC7): erkennt binds, die
 * NICHT dem bekannten [[deploy-config-volume-mount]]-Verzeichnis-Mount-Muster
 * (`.../apps/<app>/config:<containerMountPath>`, read-write) entsprechen, und
 * liefert das als `ambiguous: true` nach außen — der fail-closed-Abbruch selbst
 * (kein Docker-Schritt) ist Aufgabe des Update-Endpunkts (container-image-update
 * AC7, Story S-355), nicht dieses Mappers.
 *
 * @module deploy/RunConfigMapper
 */

/**
 * Host-Pfad-Konvention des bekannten config-Verzeichnis-Mounts
 * ([[deploy-config-volume-mount]] AC3): `.../apps/<app>/config`, `<app>` folgt
 * demselben Zeichensatz wie der validierte config-App-Slug (`^[a-z0-9][a-z0-9._-]*$`).
 */
const KNOWN_CONFIG_BIND_HOST_RE = /\/apps\/([a-z0-9][a-z0-9._-]*)\/config$/;

/**
 * @typedef {object} DeployParamsMapping
 * @property {Record<string,string>} containerEnv - Env des Bestands-Containers, unverändert
 *   für den `run()`-Schritt der Saga (`opts.containerEnv`). **Kann Secrets enthalten** — server-
 *   intern/transient, NIE in Response/Log/Audit/WS/Frontend (AC12, Floor).
 * @property {boolean} requiresConfig - Saga-Parameter (deploy-config-volume-mount D1).
 * @property {string} [configApp]     - Saga-Parameter, nur gesetzt wenn requiresConfig true.
 * @property {string} [configMountPath] - Saga-Parameter, nur gesetzt wenn requiresConfig true.
 * @property {boolean} ambiguous - true, wenn die Binds NICHT eindeutig auf die von der Saga
 *   unterstützten Parameter abbildbar sind (container-image-update AC7). In diesem Fall sind
 *   `requiresConfig`/`configApp`/`configMountPath` NICHT verlässlich befüllt — der Aufrufer MUSS
 *   fail-closed abbrechen, statt die Mapping-Werte zu verwenden.
 * @property {string} [ambiguousReason] - secret-freie, maschinenlesbare Begründung
 *   (`multiple-binds`|`unrecognized-bind-format`|`non-rw-bind-mode`|`unknown-bind-pattern`).
 */

/**
 * Bildet eine `ContainerRunConfig` (aus `VpsDockerControl.inspectContainer()`) auf die
 * Saga-Parameter von `DeployOrchestrator.deploy()` ab.
 *
 * Regeln:
 *   - Kein Bind → `requiresConfig: false`, nicht ambiguous (Container ohne config-Mount).
 *   - Genau EIN Bind, der dem bekannten `.../apps/<app>/config:<mountPath>`-Muster
 *     entspricht (read-write, kein `:ro`/anderer Modus) → `requiresConfig: true`,
 *     `configApp`/`configMountPath` aus dem Bind extrahiert.
 *   - Mehr als ein Bind, ein nicht erkennbares Bind-Format, ein Nicht-rw-Modus oder ein
 *     Host-Pfad außerhalb des bekannten Musters → `ambiguous: true` (fail-closed-Signal
 *     an den Aufrufer, container-image-update AC7).
 *
 * @param {import('./VpsDockerControl.js').ContainerRunConfig} config
 * @returns {DeployParamsMapping}
 */
export function mapRunConfigToDeployParams(config) {
  const containerEnv = (config && typeof config.env === 'object' && config.env !== null)
    ? { ...config.env }
    : {};
  const binds = Array.isArray(config?.binds) ? config.binds : [];

  if (binds.length === 0) {
    return { containerEnv, requiresConfig: false, ambiguous: false };
  }

  if (binds.length > 1) {
    return { containerEnv, requiresConfig: false, ambiguous: true, ambiguousReason: 'multiple-binds' };
  }

  const bind = binds[0];
  const parts = typeof bind === 'string' ? bind.split(':') : [];
  if (parts.length < 2 || parts.length > 3) {
    return {
      containerEnv,
      requiresConfig: false,
      ambiguous: true,
      ambiguousReason: 'unrecognized-bind-format',
    };
  }

  const [hostPath, containerPath, mode] = parts;

  // Nur ein reiner rw-Mount (kein Modus-Suffix oder explizit "rw") entspricht dem bekannten
  // Muster (deploy-config-volume-mount D2) — z.B. ":ro" oder ":z"/":Z" sind ambiguous.
  if (mode && mode !== 'rw') {
    return {
      containerEnv,
      requiresConfig: false,
      ambiguous: true,
      ambiguousReason: 'non-rw-bind-mode',
    };
  }

  const match = KNOWN_CONFIG_BIND_HOST_RE.exec(hostPath);
  if (!match || !containerPath) {
    return {
      containerEnv,
      requiresConfig: false,
      ambiguous: true,
      ambiguousReason: 'unknown-bind-pattern',
    };
  }

  return {
    containerEnv,
    requiresConfig: true,
    configApp: match[1],
    configMountPath: containerPath,
    ambiguous: false,
  };
}
