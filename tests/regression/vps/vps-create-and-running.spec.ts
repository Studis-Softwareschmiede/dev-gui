import { test, expect, request as playwrightRequest } from '@playwright/test';
import testData from './vps-create-and-running.data.json';

/**
 * Covers (regression-define): AC2, AC3, AC5, AC6
 * Covers (view-vps): AC3, AC7, AC9
 * Covers (vps-provider-boundary): AC7, AC8
 * @file Hetzner-Server anlegen und in der Übersicht als laufend erkennen
 *
 * Quell-Specs: docs/specs/view-vps.md, docs/specs/vps-provider-boundary.md
 *
 * target: ephemeral-infra ([[regression-runner]] AC2/AC4) — dieser Test provisioniert
 * einen echten, wegwerfbaren Hetzner-Server (rtest-*-Namensschema, s. Begleitbeschreibung)
 * und baut ihn im finally-Block garantiert wieder ab
 * ([[regression-playwright-conventions]] AC4).
 *
 * Secrets: das Hetzner-API-Token wird NICHT aus dieser Datei oder der Datentabelle
 * gelesen, sondern zur Laufzeit über den Credential-Store injiziert
 * (process.env.HETZNER_API_TOKEN, [[regression-runner]] AC9, scripts/load-env.sh).
 */

test.describe('VPS — Hetzner-Server anlegen und als laufend erkennen', () => {
  testData.forEach((testCase) => {
    test(`Hetzner-Server ${testCase.name} wird angelegt und erreicht Status running`, async ({
      page,
      baseURL,
    }) => {
      const rtestName = `rtest-${testCase.name}`;
      let createdServerId: string | null = null;

      try {
        // PROVISION: VPS-Ansicht öffnen und das Create-Formular ausfüllen
        await page.goto(`${baseURL ?? ''}/vps`);
        await page.getByRole('button', { name: /server anlegen|create/i }).click();

        await page.getByLabel(/provider/i).selectOption(testCase.provider);
        await page.getByLabel(/name/i).fill(rtestName);
        await page.getByLabel(/region/i).selectOption(testCase.region);
        await page.getByLabel(/servertyp|server type/i).selectOption(testCase.serverType);
        await page.getByLabel(/image/i).selectOption(testCase.image);

        // Für die Rollen root/alex je ein hinterlegtes SSH-Key-Label zuordnen
        await page.getByLabel(/ssh.*root/i).selectOption(testCase.ssh_key_label_root);
        await page.getByLabel(/ssh.*alex/i).selectOption(testCase.ssh_key_label_alex);

        await page.getByRole('button', { name: /absenden|erstellen|submit/i }).click();

        // Erfolgsmeldung abwarten
        await expect(page.getByText(/erfolgreich|server wird erstellt|created/i)).toBeVisible({
          timeout: 30_000,
        });

        // Neuen Server in der Übersicht finden (Provider, Name, ggf. IPv4)
        const row = page.getByRole('row', { name: new RegExp(rtestName) });
        await expect(row).toBeVisible({ timeout: 30_000 });
        await expect(row).toContainText(new RegExp(testCase.provider, 'i'));

        const serverIdAttr = await row.getAttribute('data-server-id');
        createdServerId = serverIdAttr;

        // POLL: Übersicht wiederholt abrufen, bis Status "running" oder Kontrollzeitraum abläuft
        const deadline = Date.now() + testCase.kontrollzeitraum_sekunden * 1000;
        let statusIsRunning = false;
        while (Date.now() < deadline) {
          await page.reload();
          const currentRow = page.getByRole('row', { name: new RegExp(rtestName) });
          const statusText = (await currentRow.textContent()) ?? '';
          if (/running/i.test(statusText)) {
            statusIsRunning = true;
            break;
          }
          await page.waitForTimeout(testCase.poll_intervall_sekunden * 1000);
        }

        // PRÜFEN
        expect(statusIsRunning).toBe(true);

        // Kein Provider-Token/Geheimnis in der Oberfläche
        const bodyText = await page.textContent('body');
        expect(bodyText).not.toMatch(/api[_-]?token|secret|bearer\s+[a-z0-9]{20,}/i);
      } finally {
        // TEARDOWN (garantiert, auch im Fehlerpfad): angelegten Server wieder abbauen.
        // Guard-Aufruf analog infra-guard.ts vor jedem Abbau eines Infra-Ressourcennamens.
        if (createdServerId) {
          const api = await playwrightRequest.newContext({ baseURL });
          await api.post(`/api/vps/machines/${testCase.provider}/${createdServerId}/stop`);
          await api.dispose();
        }
      }
    });
  });
});
