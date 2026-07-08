import { test, expect } from '@playwright/test';

/**
 * Rauchtest (target: local) — beweist die Regressions-Laufzeit ohne Cloud-Kosten.
 * Prüft nur, dass dev-gui ausgeliefert wird und die App-Hülle (#root) da ist.
 * Quell-Spec: docs/specs/run-state-live-view.md
 */
test('dev-gui wird ausgeliefert und zeigt die App-Hülle', async ({ page }) => {
  const resp = await page.goto('/');
  expect(resp?.ok(), 'HTTP-Antwort der Startseite ist ok').toBeTruthy();
  await expect(page).toHaveTitle(/dev-gui/);
  await expect(page.locator('#root')).toBeAttached();
});
