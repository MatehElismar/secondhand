/**
 * Isolated, READ-ONLY test of browser-based Facebook Marketplace interaction.
 *
 * Opens a listing with the persisted signed-in profile (.fb-session, created by
 * `npm run fb:session`) and reads the real rendered DOM: title, price, seller,
 * description, and whether there is an "Ask / Message" button. It does NOT send
 * messages or mutate anything.
 *
 * Usage:
 *   node scripts/seller-interact.mjs [--url=LISTING_URL] [--draft]
 *     --url    listing URL (defaults to a known Marketplace item)
 *     --draft  ALSO pre-fills the message box with a draft (does NOT send)
 */

import { getBrowser, newPage } from '../dist/browser.js';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (name) => {
  const a = args.find((x) => x.startsWith(name + '='));
  return a ? a.split('=').slice(1).join('=') : undefined;
};
const DRAFT = args.includes('--draft');
const SEND = args.includes('--send');
const CHECK = args.includes('--check');
const OPEN = args.includes('--open');
const MESSAGE = arg('--msg') || 'Sigue disponible?';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const PROFILE = path.join(root, '.fb-session');

const LISTING =
  arg('--url') ||
  'https://www.facebook.com/marketplace/item/1069168909422356';



if (!existsSync(PROFILE)) {
  console.error('No .fb-session profile. Run `npm run fb:session` first.');
  process.exit(1);
}

// Reuse the signed-in profile so the page is authenticated.
process.env.PUPPETEER_USER_DATA_DIR = PROFILE;

console.log('> opening (read-only):', LISTING);
const browser = await getBrowser();
const page = await newPage();
await page.setViewport({ width: 1280, height: 900 });

await page
  .goto(LISTING, { waitUntil: 'domcontentloaded', timeout: 60000 })
  .catch((e) => console.error('nav:', e.message));
await new Promise((r) => setTimeout(r, 4000));

const data = await page.evaluate(() => {
  const txt = (sel) => (document.querySelector(sel)?.textContent || '').trim();
  const has = (sel) => !!document.querySelector(sel);
  const bodyText = (document.body?.innerText || '');
  return {
    url: location.href,
    title: txt('h1') || document.title,
    // Price elements vary; grab money strings from the page.
    priceStrings: (bodyText.match(/DOP\s?[\d.,]+|\$\s?[\d.,]+/g) || []).slice(0, 5),
    bodySnippet: bodyText.slice(0, 400),
    seller: txt('[data-testid="marketplace_pdp_seller_link"]') || txt('a[href*="/profile/"]'),
    hasAsk: has('button, [role="button"]') && /ask|message|make offer/i.test(bodyText),
    hasMessageButton: has('[aria-label*="essage"], [aria-label*="Buy"], [aria-label*="Ask"]'),
  };
});

console.log('> DOM read:');
console.log(JSON.stringify(data, null, 2));

if (CHECK) {
  console.log('> --check: opening the conversation and reading what was sent…');
  await page.evaluate(() => {
    const cands = [...document.querySelectorAll('button,[role="button"],a[href]')];
    const target = cands.find((el) => {
      const label = `${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`;
      const href = el.getAttribute('href') || '';
      if (/inbox|marketplace\/you|notifications|help/i.test(href)) return false;
      return /^(message|msg|ask|buy|make offer|send message)\b/i.test(label);
    });
    if (target) target.click();
  });
  await new Promise((r) => setTimeout(r, 6000));
  const found = await page.evaluate(() => {
    const text = document.body ? document.body.innerText : '';
    return {
      contains: text.includes('Sigue disponible?'),
      urlNow: location.href,
      snippet: text.slice(0, 200),
    };
  });
  console.log(JSON.stringify(found, null, 2));
  console.log('> done (check, read-only).');
  await browser.close();
  process.exit(0);
}

if (OPEN) {
  console.log('> --open: opening the message modal for the human to write + send…');
  await page.evaluate(() => {
    const cands = [...document.querySelectorAll('button,[role="button"],a[href]')];
    const target = cands.find((el) => {
      const label = `${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`;
      const href = el.getAttribute('href') || '';
      if (/inbox|marketplace\/you|notifications|help/i.test(href)) return false;
      return /^(message|msg|ask|buy|make offer|send message)\b/i.test(label);
    });
    if (target) target.click();
  });
  await new Promise((r) => setTimeout(r, 5000));
  await page.screenshot({ path: '/tmp/fb-interact-open.png' }).catch(() => {});
  console.log('> modal open (no text typed, nothing sent) — check the window / screenshot.');
  await browser.close();
  process.exit(0);
}

if (DRAFT || SEND) {
  console.log(`> ${SEND ? '--send' : '--draft'}: opening the message modal${SEND ? ' and sending' : ' (pre-filling)'}…`);
  // Click the Message/Ask CTA (falls back to a DOM click).
  const clicked = await page.evaluate(() => {
    // Scope to the listing's actual Message/Ask CTA: buttons first, and skip
    // sidebar/nav links (Inbox, Marketplace activity) that would navigate away.
    const cands = [...document.querySelectorAll('button,[role="button"],a[href]')];
    const target = cands.find((el) => {
      const label = (el.getAttribute('aria-label') || '').trim();
      const text = (el.textContent || '').trim();
      const href = el.getAttribute('href') || '';
      if (/inbox|marketplace\/you|notifications|help/i.test(href)) return false;
      return /^(message|msg|ask|buy|make offer|send message)\b/i.test(`${label} ${text}`);
    });
    if (target) { target.click(); return true; }
    return false;
  });
  if (!clicked) console.log('> no Message/Ask CTA found.');

  // The CTA may navigate to a Messenger thread (a new document) or open an
  // in-page modal. Wait for navigation/rendering, then locate the input on the
  // current page and screenshot for inspection.
  await new Promise((r) => setTimeout(r, 6000));
  await page.screenshot({ path: '/tmp/fb-interact.png', fullPage: false }).catch(() => {});
  console.log('> URL after click:', await page.url());

  let box = await page
    .waitForSelector('textarea, [contenteditable="true"]', { timeout: 10000 })
    .catch(() => null);

  if (box) {
    // Target ONLY the composer (message input) by its container marker (a
    // placeholder / lexical editor). Never click the quick-reply chips, which
    // send immediately.
    await page.evaluate(() => {
      const els = [...document.querySelectorAll('div[contenteditable="true"], textarea')].filter(
        (n) => n.offsetWidth > 0 && n.offsetHeight > 0
      );
      const composer =
        els.find((n) => (n.getAttribute('placeholder') || '').length > 0) ||
        els.find((n) => n.hasAttribute('data-lexical-editor') || n.hasAttribute('data-contents')) ||
        els.find((n) => n.tagName === 'TEXTAREA') ||
        els[0];
      if (composer) composer.focus();
    });
    await new Promise((r) => setTimeout(r, 400));
    try {
      await page.keyboard.type(MESSAGE);
    } catch (e) {
      console.log('> typing issue (best-effort):', String(e).slice(0, 80));
    }

    // Read back the composer content to confirm the text went into the box
    // (and no preset chip was triggered).
    const composed = await page.evaluate(() => {
      const el = [...document.querySelectorAll('div[contenteditable="true"], textarea')].find(
        (n) => n.offsetWidth > 0 && n.offsetHeight > 0
      );
      return el ? (el.textContent || el.value || '').trim() : '';
    });
    console.log('> composer now has:', JSON.stringify(composed));
    console.log('> message intended:', JSON.stringify(MESSAGE));

    if (SEND) {
      // Send button: aria-label/role button matching send/enviar, inside the modal.
      const sent = await page.evaluate(() => {
        const cands = [
          ...document.querySelectorAll('[role="dialog"] [aria-label*="send" i], [role="dialog"] button, [aria-label*="send" i], button, [role="button"]'),
        ];
        const target = cands.find((el) => {
          const label = `${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`;
          return /send|enviar|(press enter to send)/i.test(label) && el.offsetWidth > 0 && el.offsetHeight > 0;
        });
        if (target) { target.click(); return true; }
        return false;
      });
      await new Promise((r) => setTimeout(r, 1500));
      if (!sent) {
        try { await page.keyboard.press('Enter'); console.log('> pressed Enter in the input.'); } catch {}
      }
      console.log(sent ? '> SENT (clicked send button).' : '> attempted send (no explicit send button found; pressed Enter).');
    } else {
      console.log('> draft typed into the modal input (NOT sent).');
    }
  } else {
    console.log('> message box not found after opening the modal; check /tmp/fb-interact.png');
  }
}

await browser.close();
console.log('> done (read-only).');
