import { test, expect } from '@playwright/test';
import testData from './vps-stop-unsupported-capability.data.json';

/**
 * Covers (regression-define): AC2, AC3, AC5, AC6
 * Covers (view-vps): AC6
 * Covers (vps-provider-boundary): AC6
 * @file Stop einer Hetzner-Maschine, die die Aktion nicht unterstützt,
 *       führt zu klarer "nicht unterstützt"-Meldung statt Fehler
 *
 * Quell-Specs: docs/specs/view-vps.md, docs/specs/vps-provider-boundary.md
 *
 * target: ephemeral-infra ([[regression-runner]] AC2/AC4) — prüft nur die UI-Darstellung
 * anhand des Capability-Flags, provisioniert selbst keinen zusätzlichen Server.
 */

test.describe('VPS — Stop-Aktion bei fehlender Capability', () => {
  testData.forEach((testCase) => {
    test(`Stop wird für Provider ${testCase.provider} ohne Stop-Capability als nicht unterstützt dargestellt`, async ({
      page,
      baseURL,
    }) => {
      // Eine Maschine auswählen, für die laut Capability-Flag Stop nicht unterstützt ist
      await page.goto(`${baseURL ?? ''}/vps`);
      const row = page
        .getByRole('row')
        .filter({ has: page.getByText(new RegExp(testCase.provider, 'i')) })
        .first();
      await expect(row).toBeVisible();

      // Prüfen, ob die Stop-Aktion als deaktiviert bzw. "nicht unterstützt" dargestellt ist
      const stopButton = row.getByRole('button', { name: /stop/i });

      if (!testCase.capability_stop) {
        // Aktion wird nicht als auslösbarer Button angeboten ODER ist klar disabled
        const isVisible = await stopButton.isVisible().catch(() => false);
        if (isVisible) {
          await expect(stopButton).toBeDisabled();
        }
        await expect(row.getByText(/nicht unterstützt|unsupported/i)).toBeVisible();
      }

      // Es wird kein Fehleraufruf gegen den Provider provoziert: kein Netzwerk-Request
      // auf den Stop-Endpunkt, solange der Button disabled/nicht vorhanden ist.
      let stopRequestFired = false;
      page.on('request', (req) => {
        if (/\/api\/vps\/machines\/.+\/(stop)$/.test(req.url())) {
          stopRequestFired = true;
        }
      });
      await page.waitForTimeout(500);
      expect(stopRequestFired).toBe(false);
    });
  });
});
