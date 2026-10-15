import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const yaml = `openapi: 3.1.0
info:
  title: Tiny API
  version: '1.0'
paths:
  /hello:
    get:
      summary: Say hello
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: string
`;

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Try example' }).click();
  await expect(page.getByRole('button', { name: 'Copy', exact: true })).toBeEnabled();
});

test('example, presets, settings, JSON output, and operation filtering', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Compact', exact: true }).click();
  await expect(page.locator('#output')).not.toContainText('List all users with advanced');
  await expect(page.getByRole('slider', { name: 'Description length' })).toHaveValue('0');
  await page.getByRole('switch', { name: 'Include examples' }).check();
  await expect(page.locator('#custom-indicator')).toBeVisible();
  await page.getByRole('button', { name: 'JSON', exact: true }).click();
  await expect(page.locator('#output')).toContainText('\"operations\"');
  const document = JSON.parse(await page.locator('#output').innerText());
  expect(document.operations.length).toBeGreaterThan(0);
  await page.getByRole('searchbox', { name: 'Filter operations' }).fill('GET /users');
  await expect(async () => {
    const filtered = JSON.parse(await page.locator('#output').innerText());
    expect(filtered.operations.length).toBeGreaterThan(0);
    expect(
      filtered.operations.every(
        (op: { method: string; path: string }) =>
          op.method === 'GET' && op.path.startsWith('/users'),
      ),
    ).toBe(true);
  }).toPass();
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(page.locator('#filter-notice')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filter' }).click();
  await expect(page.locator('#filter-notice')).toBeHidden();
  expect(errors).toEqual([]);
});

test('invalid input and clearing remove stale output and disable export', async ({ page }) => {
  await page.getByRole('textbox', { name: 'OpenAPI source specification' }).fill('not an API');
  await expect(page.getByRole('alert')).toContainText('Expected an OpenAPI');
  await expect(page.locator('#output')).toBeEmpty();
  await expect(page.getByRole('button', { name: 'Copy', exact: true })).toBeDisabled();
  await expect(page.locator('#reduction')).toBeHidden();
  await page.getByRole('button', { name: 'Clear source' }).click();
  await expect(page.getByRole('alert')).toBeHidden();
  await expect(page.locator('#source')).toBeFocused();
  await expect(page.locator('#output-empty')).toBeVisible();
  await page.getByRole('textbox', { name: 'OpenAPI source specification' }).fill(yaml);
  await expect(page.locator('#output')).toContainText('GET /hello');
});

test('file import, formatting, clipboard, and correct download extension', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page
    .locator('#file-input')
    .setInputFiles({ name: 'tiny.yaml', mimeType: 'text/yaml', buffer: Buffer.from(yaml) });
  await expect(page.locator('#source')).toHaveValue(yaml);
  await expect(page.locator('#output')).toContainText('Tiny API');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Format source' }).click();
  await expect(page.locator('#source')).toHaveValue(/version: \"1.0\"/);
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(page.getByRole('button', { name: 'Copy', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Copied!' })).toBeVisible();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toContain('GET /hello');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const textDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download output' }).click();
  expect((await textDownload).suggestedFilename()).toBe('tiny.slim.txt');
  await page.getByRole('button', { name: 'JSON', exact: true }).click();
  await expect(page.locator('#output')).toContainText('\"operations\"');
  const jsonDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download output' }).click();
  expect((await jsonDownload).suggestedFilename()).toBe('tiny.slim.json');
});

test('drag and drop imports a file and renders imported markup as plain text', async ({ page }) => {
  const hostileSpec = JSON.stringify({
    openapi: '3.1.0',
    info: { title: '<img src=x onerror=alert(1)>' },
    paths: { '/safe': { get: { responses: { 204: {} } } } },
  });
  const transfer = await page.evaluateHandle((text) => {
    const data = new DataTransfer();
    data.items.add(new File([text], 'dropped.json', { type: 'application/json' }));
    return data;
  }, hostileSpec);
  await page.locator('#drop-zone').dispatchEvent('drop', { dataTransfer: transfer });
  await expect(page.locator('#source')).toHaveValue(hostileSpec);
  await expect(page.locator('#output')).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.locator('#output img')).toHaveCount(0);
});

test('preferences persist without saving the imported specification', async ({ page }) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Readable', exact: true }).click();
  await page.getByRole('button', { name: 'Close settings' }).click();
  await page.getByRole('textbox', { name: 'OpenAPI source specification' }).fill(yaml);
  await expect(page.locator('#output')).toContainText('Tiny API');
  await page.reload();
  await expect(page.locator('[data-preset=readable]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#source')).toHaveValue('');
  await expect(page.locator('#output')).toBeEmpty();
  const stored = await page.evaluate(() => JSON.stringify(localStorage));
  expect(stored).not.toContain('Tiny API');
});

test('settings support keyboard dismissal and mobile stays within the viewport', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Upload' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const copyBounds = await page.getByRole('button', { name: 'Copy', exact: true }).boundingBox();
  expect(copyBounds!.y + copyBounds!.height).toBeLessThan(844);
  await page.screenshot({ path: 'test-results/mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: 'test-results/mobile-settings.png', fullPage: true });
});

test('paste-first layout, live conversion, and local-only requests', async ({ page }) => {
  const external: string[] = [];
  page.on('request', (request) => {
    if (!request.url().startsWith('http://127.0.0.1:4173/')) external.push(request.url());
  });
  await page.reload();
  const source = page.getByRole('textbox', { name: 'OpenAPI source specification' });
  await expect(source).toHaveValue('');
  await expect(page.locator('[data-preset=max]')).toHaveAttribute('aria-pressed', 'true');
  await expect(source).toBeFocused();
  await expect(page.getByRole('button', { name: 'Copy', exact: true })).toBeDisabled();
  const bounds = await source.boundingBox();
  expect(bounds!.y).toBeLessThan(140);
  await expect(page.getByRole('button')).toHaveCount(4);
  expect(bounds!.height).toBeGreaterThan(600);
  await page.screenshot({ path: 'test-results/desktop-empty.png', fullPage: true });
  await source.fill(yaml);
  await expect(page.locator('#output')).toContainText('GET /hello');
  await expect(page.getByRole('button', { name: 'Copy', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Try example' }).click();
  await expect(page.locator('#output')).toContainText('Advanced E-Commerce');
  await page.screenshot({ path: 'test-results/desktop.png', fullPage: true });
  expect(external).toEqual([]);
});

test('workbench and settings meet automated WCAG AA checks', async ({ page }) => {
  const { default: AxeBuilder } = await import('@axe-core/playwright');
  for (const settingsOpen of [false, true]) {
    if (settingsOpen) await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const audit = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(
      audit.violations.map(({ id, nodes }) => ({
        id,
        nodes: nodes.map((node) => ({ target: node.target, summary: node.failureSummary })),
      })),
    ).toEqual([]);
  }
});

test('pasting Nevia uses Max by default and restores 98% size reduction', async ({
  page,
  context,
}) => {
  const input = gunzipSync(
    readFileSync(new URL('../fixtures/nevia.openapi.yaml.gz', import.meta.url)),
  ).toString('utf8');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate((text) => navigator.clipboard.writeText(text), input);
  await page.getByRole('textbox', { name: 'OpenAPI source specification' }).focus();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
  await expect(page.locator('[data-preset=max]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#reduction')).toHaveText('98.1% smaller');
  await expect(page.getByRole('button', { name: 'Copy', exact: true })).toBeEnabled();
  await expect(page.locator('#output')).toContainText('## Operations (58)');
  await expect(page.locator('#output')).toContainText('## Schemas (104)');
  await page.screenshot({ path: 'test-results/nevia.png', fullPage: true });
});
