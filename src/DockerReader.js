/**
 * DockerReader — reads running preview containers from the Docker engine.
 *
 * Architecture boundary: the ONLY place that touches the Docker engine.
 *
 * Design:
 *   - Talks to Docker by shelling out to `docker ps` (via an injectable exec function)
 *     so no extra dependency is needed. The command reads only — no writes.
 *   - The exec function is injectable for tests (mock-friendly).
 *   - If Docker is unreachable or the command fails, returns an empty array
 *     (AC4 graceful degradation).
 *   - Preview containers are identified by the label `agent-flow.preview`.
 *   - The host port is extracted from the port mapping and used to build a URL.
 *
 * @module DockerReader
 */

import { execFile } from 'node:child_process';

/** Default timeout for docker ps in ms. */
const EXEC_TIMEOUT_MS = 5000;

/**
 * Default exec implementation — wraps child_process.execFile.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {Promise<string>} stdout
 */
function defaultExec(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}

/**
 * Parse the output of:
 *   docker ps --filter label=agent-flow.preview
 *             --format '{{.Names}}\t{{.Ports}}\t{{.Status}}'
 *
 * Each line: `name\tports\tstatus`
 *
 * Extracts the first published host port from the Ports column.
 * URL = `http://localhost:<hostport>`.
 *
 * @param {string} output
 * @returns {Array<{name:string, url:string, status:string}>}
 */
function parseDockerOutput(output) {
  const lines = output.split('\n').filter((l) => l.trim() !== '');
  return lines.map((line) => {
    const parts = line.split('\t');
    const name = (parts[0] ?? '').trim();
    const ports = (parts[1] ?? '').trim();
    const status = (parts[2] ?? '').trim();

    // Extract first host port from e.g. "0.0.0.0:3001->3000/tcp, ..."
    const portMatch = ports.match(/(?:0\.0\.0\.0|:::?)?:?(\d+)->/);
    const hostPort = portMatch ? portMatch[1] : null;
    const url = hostPort ? `http://localhost:${hostPort}` : null;

    return { name, url, status };
  }).filter((c) => c.name !== '');
}

/**
 * DockerReader reads preview container metadata from the Docker engine.
 *
 * @param {object} [options]
 * @param {(cmd:string, args:string[], timeoutMs:number) => Promise<string>} [options.execFn]
 *   Injectable exec function. Defaults to child_process.execFile wrapper.
 */
export class DockerReader {
  #exec;

  constructor({ execFn } = {}) {
    this.#exec = execFn ?? defaultExec;
  }

  /**
   * Return all running preview containers.
   *
   * On error (Docker unreachable, command fails), returns an empty array (AC4).
   *
   * @returns {Promise<Array<{name:string, url:string|null, status:string}>>}
   */
  async getPreviews() {
    try {
      const stdout = await this.#exec(
        'docker',
        [
          'ps',
          '--filter', 'label=agent-flow.preview',
          '--format', '{{.Names}}\t{{.Ports}}\t{{.Status}}',
        ],
        EXEC_TIMEOUT_MS,
      );
      return parseDockerOutput(stdout);
    } catch {
      // Docker not reachable or command failed — degrade gracefully (AC4)
      return [];
    }
  }
}
