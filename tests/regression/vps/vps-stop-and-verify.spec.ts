import { test, expect } from '@playwright/test';
import testData from './vps-stop-and-verify.data.json';

/**
 * Covers (regression-define): AC2, AC3, AC5, AC6
 * Covers (view-vps): AC6, AC9
 * Covers (vps-provider-boundary): AC5
 * @file Laufenden Hetzner-Server stoppen und danach kontrollieren, dass er nicht mehr läuft
 *
 * Quell-Specs: docs/specs/view-vps.md, docs/specs/vps-provider-boundary.md
 *
 * target: ephemeral-infra ([[regression-runner]] AC2/AC4) — setzt einen zuvor über
 * `vps-create-and-running.spec.ts` angelegten, laufenden rtest-*-Server voraus.
 *
 * Secrets: das Hetzner-API-Token wird NICHT aus dieser Datei oder der Datentabelle
 * gelesen, sondern zur Laufzeit über den Credential-Store injiziert
 * (process.env.HETZNER_API_TOKEN, [[regression-runner]] AC9, scripts/load-env.sh).
 */

test.describe('VPS — laufenden Hetzner-Server stoppen und Stop kontrollieren', () => {
  testData.forEach((testCase) => {
    test(`Server ${testCase.name} wird gestoppt und erreicht Status stopped`, async ({ page, baseURL }) => {
      const rtestName = `rtest-${testCase.name}`;

      // In der Maschinen-Übersicht den zuvor angelegten, laufenden Server auswählen
      await page.goto(`${baseURL ?? ''}/vps`);
      const row = page.getByRole('row', { name: new RegExp(rtestName) });
      await expect(row).toBeVisible();

      // Stop-Aktion auslösen
      const stopButton = row.getByRole('button', { name: /stop/i });
      await stopButton.click();

      // Erfolgsrückmeldung der Aktion abwarten — klares Ergebnis statt UI-Absturz
      const feedback = page.getByText(/erfolgreich|gestoppt|nicht unterstützt|fehler/i);
      await expect(feedback).toBeVisible({ timeout: 15_000 });

      // POLL: Übersicht wiederholt abrufen, bis Status "stopped" oder Kontrollzeitraum abläuft
      const deadline = Date.now() + testCase.kontrollzeitraum_sekunden * 1000;
      let statusIsStopped = false;
      while (Date.now() < deadline) {
        await page.reload();
        const currentRow = page.getByRole('row', { name: new RegExp(rtestName) });
        const statusText = (await currentRow.textContent()) ?? '';
        if (/stopped/i.test(statusText)) {
          statusIsStopped = true;
          break;
        }
        await page.waitForTimeout(testCase.poll_intervall_sekunden * 1000);
      }

      // PRÜFEN
      expect(statusIsStopped).toBe(true);

      // Kein Provider-Token/Geheimnis in der Oberfläche
      const bodyText = await page.textContent('body');
      expect(bodyText).not.toMatch(/api[_-]?token|secret|bearer\s+[a-z0-9]{20,}/i);
    });
  });
});
