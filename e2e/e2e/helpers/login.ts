import { expect, Page } from '@playwright/test';

function isOnCognito(url: string) {
  return /amazoncognito\.com/i.test(url);
}
function isOnAppLogin(url: string) {
  return /\/login(\?|$)/i.test(url);
}
function isOnCloudFront(url: string) {
  return /d33xe02gdlyt8z\.cloudfront\.net/i.test(url);
}

export async function login(page: Page) {
  const email = process.env.E2E_EMAIL ?? '';
  const password = process.env.E2E_PASSWORD ?? '';
  if (!email || !password) throw new Error('Missing E2E_EMAIL / E2E_PASSWORD in environment');

  // Force auth by visiting protected route
  await page.goto('/settings', { waitUntil: 'domcontentloaded' });

  // App /login -> click through to Cognito
  if (isOnAppLogin(page.url())) {
    const loginBtn =
      page.getByRole('button', { name: /log in|login|sign in|continue/i }).first()
        .or(page.getByRole('link', { name: /log in|login|sign in|continue/i }).first());

    await expect(loginBtn).toBeVisible({ timeout: 15000 });
    await loginBtn.click();
  }

  // Cognito Hosted UI login
  if (isOnCognito(page.url())) {
    const username = page.locator('#signInFormUsername:visible').first();
    const pass = page.locator('#signInFormPassword:visible').first();

    await expect(username).toBeVisible({ timeout: 15000 });
    await username.fill(email);

    await expect(pass).toBeVisible({ timeout: 15000 });
    await pass.fill(password);

    // Submit via Enter
    await pass.press('Enter');

    // Wait return to CloudFront (could land on /auth/callback)
    await page.waitForURL((u) => isOnCloudFront(u.toString()), { timeout: 60_000 });

    // Let the SPA finish processing callback (if any)
    await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {});
    await page.waitForTimeout(1000);
  }

  // If we are still on /login, session not established
  if (isOnAppLogin(page.url())) {
    throw new Error('Back on /login after Cognito flow (tokens not stored / callback not processed).');
  }

  // Final verification: try protected route with a bit of patience
  await page.goto('/settings', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(500);

  if (isOnAppLogin(page.url())) {
    throw new Error('Still redirected to /login after Cognito sign-in (app did not persist auth state).');
  }

  await expect(page).toHaveURL(/\/settings/i);
}
