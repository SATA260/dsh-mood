import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'

async function open(page: Page) {
  const url = process.env.DSH_MOOD_TEST_URL ?? JSON.parse(await readFile('test-results/host.json', 'utf8')).url
  await page.goto(url)
  await expect(page.getByRole('button', { name: '搭档状态', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Continue', exact: true }).click({ timeout: 2000 }).catch(() => {})
}
async function panel(page: Page) {
  await page.getByRole('button', { name: '搭档状态', exact: true }).click()
  await expect(page.getByRole('heading', { name: '现在的情绪' })).toBeVisible()
  await expect(page.getByRole('slider')).toHaveCount(7)
}
async function setSlider(page: Page, name: string, value: number) {
  const slider = page.getByRole('slider', { name, exact: true })
  await slider.press('End')
  for (let i = 100; i > value; i--) await slider.press('ArrowLeft')
  await expect(slider).toHaveValue(String(value))
}
async function send(page: Page, text: string) {
  const editor = page.locator('[contenteditable="true"]').first()
  await editor.fill(text)
  const submit = page.getByRole('button', { name: 'Send message', exact: true })
  await expect(submit).toBeEnabled()
  await submit.click()
}
async function newChat(page: Page) {
  await page.getByRole('button', { name: /New session/i }).first().click()
  await expect(page.getByRole('textbox', { name: /Describe what you want to build/ })).toBeVisible()
}

test('installed bundle: panel, saved traits, reload and concurrent edit conflict', async ({ page, context }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  await open(page); await panel(page)
  await expect(page.getByRole('meter')).toHaveCount(5)
  await expect(page.getByRole('button', { name: '保存性格' })).toBeDisabled()
  await setSlider(page, '社交取向', 80)
  await page.getByRole('button', { name: '保存性格' }).click()
  await expect(page.locator('.mood-notice')).toContainText('已保存')
  await page.reload(); await panel(page)
  await expect(page.getByRole('slider', { name: '社交取向' })).toHaveValue('80')
  const other = await context.newPage()
  await open(other); await panel(other)
  await setSlider(page, '探索取向', 90)
  await setSlider(other, '立场坚持', 95)
  await other.getByRole('button', { name: '保存性格' }).click()
  await expect(other.locator('.mood-notice')).toContainText('已保存')
  await page.getByRole('button', { name: '保存性格' }).click()
  await expect(page.getByRole('alert')).toContainText('其他聊天')
  await page.getByRole('button', { name: '放弃草稿' }).click()
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  await expect(page.getByRole('slider', { name: '探索取向' })).toHaveValue('0')
  await expect(page.getByRole('slider', { name: '立场坚持' })).toHaveValue('95')
  await page.screenshot({ path: 'docs/验收/状态面板.png', fullPage: true })
  expect(errors).toEqual([])
  await other.close()
})

test('real keyless conversation calls state tool, renders one sticker, replays and corrects history', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  await open(page)
  await send(page, '目标完成了，请表达一下心情')
  await expect(page.getByText('收到，我们继续。', { exact: true })).toBeVisible()
  const image = page.getByRole('img', { name: 'DeepSeek：微笑' })
  await expect(image).toBeVisible()
  await expect(image).toHaveJSProperty('naturalWidth', 1024)
  await expect(page.locator('img.mood-sticker')).toHaveCount(1)
  // The native Markdown projection hides the reference definition.
  await expect(page.locator('body')).not.toContainText('[dsh-mood-sticker]: smile')
  await page.screenshot({ path: 'docs/验收/对话表情.png', fullPage: true })
  await page.reload()
  await expect(page.getByRole('img', { name: 'DeepSeek：微笑' })).toBeVisible()
  await panel(page)
  await expect(page.getByRole('meter', { name: '悲喜', exact: true })).toHaveAttribute('aria-valuenow', /^[1-9]/)
  await expect(page.locator('.mood-snapshot')).toContainText('本轮工具续步沿用开场提示词')
  await page.getByText('查看本轮注入内容', { exact: true }).click()
  await expect(page.locator('.mood-snapshot pre')).toContainText('情绪：')
  await page.getByRole('button', { name: '这次理解错了' }).first().click()
  await expect(page.locator('.mood-history')).toContainText('已撤销')
  await expect(page.getByRole('meter', { name: '悲喜', exact: true })).toHaveAttribute('aria-valuenow', '0')
  expect(errors).toEqual([])
})

test('code examples, unknown IDs, multiple IDs and missing images preserve text', async ({ page }) => {
  await open(page)
  await send(page, '[no-update] code-example')
  await expect(page.getByText('代码示例：', { exact: true })).toBeVisible()
  await expect(page.locator('img.mood-sticker')).toHaveCount(0)
  await newChat(page)
  await send(page, '[no-update] unknown-sticker')
  await expect(page.getByText('收到。', { exact: true })).toBeVisible()
  await expect(page.locator('img.mood-sticker')).toHaveCount(0)
  await newChat(page)
  await send(page, '[no-update] multi-sticker')
  await expect(page.getByRole('img', { name: 'DeepSeek：微笑' })).toBeVisible()
  await expect(page.locator('img.mood-sticker')).toHaveCount(1)
  await newChat(page)
  await page.route('**/plugins/dsh-mood/assets/**', route => route.abort())
  await send(page, '[no-update] missing-image')
  await expect(page.getByText('收到，我们继续。', { exact: true })).toBeVisible()
  await expect(page.locator('img.mood-sticker')).toHaveCount(0)
})


test('panel remains usable in a narrow viewport and inherits the Host dark theme', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await open(page); await panel(page)
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
  await page.setViewportSize({ width: 600, height: 900 })
  await expect(page.getByRole('heading', { name: '现在的情绪' })).toBeVisible()
  const theme = await page.locator('.mood-panel').evaluate(el => ({ own: getComputedStyle(el).getPropertyValue('--mood-paper').trim(), host: getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').trim() }))
  expect(theme.host).not.toBe('')
  expect(theme.own).toBe(theme.host)
  const overflow = await page.locator('.mood-panel').evaluate(el => el.scrollWidth - el.clientWidth)
  expect(overflow).toBeLessThanOrEqual(1)
  await page.screenshot({ path: 'docs/验收/窄屏面板.png', fullPage: true })
})
