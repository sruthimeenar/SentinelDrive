// Verifies Phase 7 frontend with REAL data: uploads a pothole image through the
// UI (no simulated backfill), checks the municipality summary + invoice buttons
// and a dispatched pothole row in the portal.
// Run: node frontend/tests/e2e_dispatch.mjs
import puppeteer from 'file:///C:/Users/purpl/AppData/Local/Temp/opencode/pptr/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const URL = 'http://127.0.0.1:5173/'
const IMAGE = 'C:/Users/purpl/AppData/Local/Temp/opencode/pothole_test.jpg'

const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] })
try {
  const page = await browser.newPage()
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 })

  // Empty portal at start (no synthetic backfill).
  const emptyRows = await page.$$eval('.pothole-row', (r) => r.length)
  console.log(`pothole rows at load (should be 0, no fake data): ${emptyRows}`)

  // Upload a real road image through the file input.
  const input = await page.$('input[type="file"]')
  await input.uploadFile(IMAGE)
  await page.click('.btn-primary')

  // Upload result: detection table appears with a dispatched pothole.
  await page.waitForSelector('.upload-table tbody tr', { timeout: 30000 })
  const uploadRows = await page.$$eval('.upload-table tbody tr', (r) => r.length)
  console.log(`upload detections: ${uploadRows}`)

  // The detection is published over WS -> lands in the portal list.
  await page.waitForFunction(() => document.querySelectorAll('.pothole-row').length > 0, { timeout: 15000 })
  const rowCount = await page.$$eval('.pothole-row', (r) => r.length)
  console.log(`pothole rows after real upload: ${rowCount}`)

  // Municipality summary table present.
  await page.waitForSelector('.muni-summary', { timeout: 10000 })
  const muniRows = await page.$$eval('.muni-table tbody tr', (r) => r.length)
  const muniText = await page.$eval('.muni-table', (t) => t.textContent.slice(0, 120).replace(/\s+/g, ' ').trim())
  console.log(`muni table rows: ${muniRows}`)
  console.log(`muni table text: ${muniText}`)

  // Open the first pothole detail and check the invoice download works.
  await page.click('.pothole-main')
  await page.waitForSelector('.pothole-detail', { timeout: 5000 })
  const invBtns = await page.$$eval('.btn-invoice', (b) => b.length)
  console.log(`invoice buttons (after expand): ${invBtns}`)
  const detailHasMuni = await page.$eval('.pothole-detail', (d) => d.textContent.includes('Pittsburgh'))
  const detailHasInvoice = await page.$eval('.pothole-detail', (d) => d.textContent.includes('INVOICE PDF'))
  const detailIsCamera = await page.$eval('.pothole-detail', (d) => d.textContent.includes('CV-FALLBACK'))
  console.log(`detail shows municipality: ${detailHasMuni}`)
  console.log(`detail shows invoice button: ${detailHasInvoice}`)
  console.log(`detail is real CV-FALLBACK detection (not simulated): ${detailIsCamera}`)

  const ok = rowCount > 0 && muniRows > 0 && invBtns > 0 && detailHasMuni && detailHasInvoice && detailIsCamera
  console.log(ok ? '\nPHASE 7 REAL-UPLOAD E2E PASS' : '\nPHASE 7 REAL-UPLOAD E2E FAIL')
  process.exit(ok ? 0 : 1)
} finally {
  await browser.close()
}