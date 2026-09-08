import { FacebookMarketplace } from '/Users/mateh/projects/secondhand-mcp/dist/marketplaces/facebook.js';

const QUERY = 'iphone';
const LOCATION = 'Santo Domingo, Dominican Republic';
const RADIUS = 25;
const MIN_PRICE = 100;
const MAX_PRICE = 1000;
const LIMIT = 10;

const fb = new FacebookMarketplace();

console.log('=================================');
console.log('Phase 3: Direct Facebook adapter test');
console.log(`  query     : ${QUERY}`);
console.log(`  location  : ${LOCATION}`);
console.log(`  radius    : ${RADIUS} miles`);
console.log(`  minPrice  : ${MIN_PRICE}`);
console.log(`  maxPrice  : ${MAX_PRICE}`);
console.log(`  limit     : ${LIMIT}`);
console.log('=================================');

console.log('\n--- getLocation() (resolved by Facebook) ---');
const coords = await fb.getLocation(LOCATION);
if (coords) {
  console.log(`  name      : ${coords.name}`);
  console.log(`  latitude  : ${coords.latitude}`);
  console.log(`  longitude : ${coords.longitude}`);
} else {
  console.log('  (Facebook returned no coordinates)');
}

console.log('\n--- search() ---');
const result = await fb.search({
  query: QUERY,
  location: LOCATION,
  radius: RADIUS,
  minPrice: MIN_PRICE,
  maxPrice: MAX_PRICE,
  limit: LIMIT,
});

console.log(`  success       : ${result.success}`);
console.log(`  totalFound    : ${result.totalFound}`);
console.log(`  listings count: ${result.listings.length}`);
formatter(result);

function formatter(r) {
  if (!r.success) {
    console.log(`  error: ${r.error}`);
    return;
  }
  for (const l of r.listings) {
    console.log('  ----------------------------------------');
    console.log(`  title    : ${l.title}`);
    console.log(`  price    : ${l.price} (${l.priceNumeric} ${l.currency})`);
    console.log(`  location : ${l.location}`);
    console.log(`  url      : ${l.url}`);
  }
  if (r.listings.length === 0 && r.note) {
    console.log(`  note: ${r.note}`);
  }
}
