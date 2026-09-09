/**
 * Capture a Facebook session for the marketplace adapter.
 *
 * One-time login, then automatic capture:
 *   1. Opens a dedicated Chrome window (persistent profile at .fb-session/).
 *   2. If not logged in, you log in once in that window.
 *   3. Reads the session cookies (including HttpOnly c_user/xs) via
 *      page.cookies(), and grabs fb_dtsg / lsd / __user / jazoest from a
 *      /api/graphql request body.
 *   4. Writes FB_COOKIE / FB_DTSG / FB_LSD / FB_USER / FB_JAZOEST into .env.
 *
 * The profile persists, so on the next run it is already logged in.
 * Run with:  npm run fb:session
 */

import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const pp = puppeteerExtra.default ?? puppeteerExtra;
pp.use(StealthPlugin());

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const PROFILE = path.join(root, '.fb-session');
const ENV_FILE = path.join(root, '.env');
const EXE =
  process.env.CHROME_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

console.log('> profile :', PROFILE, '| exists:', existsSync(PROFILE));

const browser = await pp.launch({
  headless: false,
  executablePath: EXE,
  userDataDir: PROFILE,
  args: ['--no-first-run', '--no-default-browser-check'],
  protocolTimeout: 120000,
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });

// Capture the auth fields from the first /api/graphql request that carries them.
let auth = null;
page.on('request', (req) => {
  if (auth || !req.url().includes('/api/graphql')) return;
  const post = req.postData();
  if (!post) return;
  try {
    const p = new URLSearchParams(post);
    // Require BOTH: fb_dtsg is tied to the session, so grabbing only lsd and
    // reusing an old dtsg makes the request invalid.
    const dtsg = p.get('fb_dtsg');
    const lsd = p.get('lsd');
    if (dtsg && lsd) {
      auth = { dtsg, lsd, user: p.get('__user'), jazoest: p.get('jazoest') };
    }
  } catch {}
});

const isLoggedIn = async () =>
  (await page.cookies('https://www.facebook.com')).some((c) => c.name === 'c_user');

await page
  .goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 60000 })
  .catch((e) => console.error('nav:', e.message));

if (await isLoggedIn()) {
  console.log('> already logged in (reused persisted profile)');
} else {
  console.log('> WAITING_FOR_LOGIN — completa el login en la ventana…');
  const start = Date.now();
  while (!(await isLoggedIn())) {
    if (Date.now() - start > 180000) {
      console.error('> timeout esperando login');
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log('> login detectado');
}

// Force a marketplace load so the page emits a /api/graphql request carrying
// both fb_dtsg and lsd; retry a couple of times if the first load did not.
for (let attempt = 0; attempt < 3 && !auth; attempt++) {
  await page
    .goto('https://www.facebook.com/marketplace/', { waitUntil: 'domcontentloaded', timeout: 60000 })
    .catch(() => {});
  for (let i = 0; i < 40 && !auth; i++) await new Promise((r) => setTimeout(r, 500));
}

const cookies = await page.cookies('https://www.facebook.com');
const fbCookie = cookies
  .filter((c) => /facebook\.com$/.test(c.domain || ''))
  .map((c) => `${c.name}=${c.value}`)
  .join('; ');
// The account id is the c_user cookie value.
const cUser = (cookies.find((c) => c.name === 'c_user') || {}).value || '';

if (!auth || !fbCookie) {
  console.error('> could not capture fb_dtsg+lsd (or cookies); .env NOT updated');
  await browser.close();
  process.exit(1);
}

const entries = {
  FB_COOKIE: fbCookie,
  FB_DTSG: auth.dtsg,
  FB_LSD: auth.lsd,
  FB_USER: auth.user && /^\d{4,}$/.test(auth.user) ? auth.user : cUser,
  FB_JAZOEST: auth.jazoest || '',
};
writeEnv(entries);

console.log('> WROTE .env (masked):');
console.log(JSON.stringify(
  Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, `${v.slice(0, 3)}…(${v.length})`])),
  null,
  2,
));

await browser.close();

function writeEnv(vars) {
  let txt = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : '';
  for (const [k, v] of Object.entries(vars)) {
    if (!v) continue;
    const line = `${k}=${JSON.stringify(v)}`;
    if (new RegExp(`^${k}=`, 'm').test(txt)) {
      txt = txt.replace(new RegExp(`^${k}=.*$`, 'm'), line);
    } else {
      txt += (txt.endsWith('\n') ? '' : '\n') + line;
    }
  }
  writeFileSync(ENV_FILE, txt);
}
