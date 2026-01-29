import { test, expect } from '@playwright/test';
import path from 'path';
import { login } from './helpers/login';

test.describe('Spendify - E2E UX', () => {

  test('Login lands on app', async ({ page }) => {
    await login(page);
    await expect(page).toHaveURL(/\/settings/i);
  });

  test('Settings page loads and shows billing actions', async ({ page }) => {
    await login(page);

    // Prefer direct navigation: avoids flaky nav locators
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/settings/i);

    // Billing section should expose at least one action button
    const manage = page.getByRole('button', { name: /manage billing/i });
    const activate = page.getByRole('button', { name: /activate subscription/i });

    await expect(manage.or(activate)).toBeVisible();
  });

test('Upload receipt UI exposes file picker', async ({ page }) => {
  await login(page);

  // Go home or receipts page depending on your app
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  // Click Upload (button or link)
  const upload =
    page.getByRole('button', { name: /upload/i }).first()
    .or(page.getByRole('link', { name: /upload/i }).first());
  await expect(upload).toBeVisible({ timeout: 15000 });
  await upload.click();

  const filePath = path.resolve(__dirname, '../fixtures/receipt.jpg');

  // Find file input (hidden ok)
  const input = page.locator('input[type="file"]');
  await expect(input).toHaveCount(1, { timeout: 15000 });
  await input.setInputFiles(filePath);

  // Expect some feedback
  await expect(page.getByText(/upload|processing|analyzing|receipt/i)).toBeVisible({ timeout: 30000 });
});


});
