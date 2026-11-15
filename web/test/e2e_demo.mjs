// e2e_demo.mjs — Automated check of the demo: plan -> inject each alert -> route changes.
// Setup once:  npm i -D playwright  &&  npx playwright install chromium
// Run:         (terminal 1) npx vite      (terminal 2) node test/e2e_demo.mjs [http://localhost:5173]
// Saves screenshots to test/screens/ so you can eyeball them.
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://localhost:5173';
fs.mkdirSync(new URL('./screens/', import.meta.url), { recursive: true });
let fails = 0;
const check = (n, ok, x = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n} ${x}`); if (!ok) fails++; };

const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const page = await browser.newPage({ viewport: { width: 1250, height: 850 } });
const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`${BASE}/planner-test.html`);
await page.waitForFunction(() => document.getElementById('out').textContent.startsWith('site'), null, { timeout: 30000 });

await page.click('#eva');
await page.waitForFunction(() => window.__last?.base, null, { timeout: 30000 });
const base = await page.evaluate(() => window.__last.base);
check('base EVA planned', base.path.geometry.coordinates.length > 10, `${base.stats.distance_m} m`);
await page.screenshot({ path: new URL('./screens/0_base.png', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1') });

for (const [i, label] of ['SPE → shelter', 'dust → return', 'suit → return'].entries()) {
  await page.click('#eva'); // reset: alerts stack, so each scenario starts from a fresh plan
  await page.waitForFunction(() => window.__last?.base && !window.__last.replan, null, { timeout: 30000 });
  const t = Date.now();
  await page.click(`text=${label}`);
  await page.waitForFunction(() => window.__last?.replan, null, { timeout: 30000 });
  const ms = Date.now() - t;
  const { replan: r, current } = await page.evaluate(() => window.__last);
  const c = r.path.geometry.coordinates;
  const d = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  check(`${label}: new route starts at astronaut`, d(c[0], current) < 1e-4);
  check(`${label}: route actually changed`, JSON.stringify(c) !== JSON.stringify(base.path.geometry.coordinates));
  check(`${label}: destination matches action`, label.includes('shelter') ? /shelter|habitat/i.test(r.replan.destination) : r.replan.destination === 'Habitat', `-> ${r.replan.destination}`);
  check(`${label}: under 1 s click-to-route`, ms < 1000, `${ms} ms`);
  await page.screenshot({ path: new URL(`./screens/${i + 1}_${label.split(' ')[0]}.png`, import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1') });
}
check('no JS errors in page', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(fails ? 1 : 0);
