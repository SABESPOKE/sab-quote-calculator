/**
 * WRP Timber Mouldings — Price & Image Scraper (Simple Version)
 * =============================================================
 * Uses plain HTTPS fetch + cheerio. No browser required.
 * Extracts: image_url, dimensions, description from static HTML.
 * Attempts to find prices from WRP's internal pricing API.
 *
 * USAGE
 *   node scrape_wrp_prices.js
 *
 * Reads:  data/wrp_catalogue.json
 * Writes: data/wrp_catalogue_enriched.json (review, then copy over wrp_catalogue.json)
 */

const https = require('https');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const INPUT_FILE  = path.join(__dirname, 'data', 'wrp_catalogue.json');
const OUTPUT_FILE = path.join(__dirname, 'data', 'wrp_catalogue_enriched.json');
const DELAY_MS    = 1200; // polite delay between requests

// ─── Fetch a URL as text ─────────────────────────────────────────────────────

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.9',
      },
      timeout: 15000,
    };
    https.get(url, options, (res) => {
      // Follow redirects
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject).on('timeout', () => reject(new Error('Timeout')));
  });
}

// ─── Try WRP's internal bulk-savings API ─────────────────────────────────────
// WRP loads prices via an AngularJS app. The app calls an endpoint for pricing.
// We try a few likely patterns to find a price.

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
        'Accept': 'application/json, text/javascript, */*',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': 'https://www.wrp-timber-mouldings.co.uk/',
      },
      timeout: 10000,
    };
    https.get(url, options, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Not valid JSON')); }
      });
    }).on('error', reject).on('timeout', () => reject(new Error('Timeout')));
  });
}

async function tryGetPrice(productId) {
  // Try likely WRP API endpoints for pricing data
  const endpoints = [
    `https://www.wrp-timber-mouldings.co.uk/api/products/${productId}`,
    `https://www.wrp-timber-mouldings.co.uk/api/bulk-savings/${productId}`,
    `https://www.wrp-timber-mouldings.co.uk/pricer/${productId}.json`,
    `https://www.wrp-timber-mouldings.co.uk/products/${productId}.json`,
  ];

  for (const endpoint of endpoints) {
    try {
      const data = await fetchJson(endpoint);
      // Look for a price field in whatever shape comes back
      const price = data.price_per_metre || data.pricePerMetre ||
                    data.base_price_per_metre || data.price ||
                    (data.product && data.product.price_per_metre) ||
                    (Array.isArray(data) && data[0] && data[0].price_per_metre);
      if (price && !isNaN(parseFloat(price))) {
        return parseFloat(price);
      }
    } catch (_) {
      // try next endpoint
    }
  }
  return null;
}

// ─── Scrape a single product page ────────────────────────────────────────────

async function scrapePage(profile) {
  const url = profile.product_url;
  let html;
  try {
    html = await fetchUrl(url);
  } catch (e) {
    console.log(`  ✗ Could not load page: ${e.message}`);
    return {};
  }

  const $ = cheerio.load(html);

  // Image: first <img itemprop="image"> in the product images section
  let image_url = profile.image_url;
  if (!image_url) {
    const imgSrc = $('#product-images img[itemprop="image"]').first().attr('src')
                || $('img[itemprop="image"]').first().attr('src');
    if (imgSrc) {
      image_url = imgSrc.startsWith('http')
        ? imgSrc
        : 'https://www.wrp-timber-mouldings.co.uk' + imgSrc;
    }
  }

  // Description
  let description = profile.description;
  if (!description) {
    description = $('p[itemprop="description"]').first().text().trim() || null;
  }

  // Dimensions — look for "NNmm x NNmm" pattern in <dd> elements
  let dimensions = profile.dimensions;
  if (!dimensions) {
    $('dl dd').each((_, el) => {
      const t = $(el).text().trim();
      if (/^\d+mm\s*x\s*\d+mm/i.test(t)) {
        dimensions = t;
        return false;
      }
    });
  }

  // Price — try API endpoints first, then look in static HTML
  let price_per_metre_gbp = profile.price_per_metre_gbp;
  if (!price_per_metre_gbp && !profile.is_compound) {
    // Try API
    price_per_metre_gbp = await tryGetPrice(profile.id);

    // Fallback: look in page's inline script tags for price data
    if (!price_per_metre_gbp) {
      $('script').each((_, el) => {
        const src = $(el).html() || '';
        // Look for patterns like price_per_metre: 4.03 or "price":"4.03"
        const match = src.match(/"?price_per_metre"?\s*[:=]\s*([\d.]+)/i)
                   || src.match(/"?base_price"?\s*[:=]\s*([\d.]+)/i);
        if (match) {
          price_per_metre_gbp = parseFloat(match[1]);
          return false;
        }
      });
    }

    // Fallback: look for £X.XX/m pattern in page text (may appear in bulk savings static render)
    if (!price_per_metre_gbp) {
      const bodyText = $('body').text();
      const match = bodyText.match(/£([\d.]+)\s*\/\s*m/);
      if (match) {
        price_per_metre_gbp = parseFloat(match[1]);
      }
    }
  }

  return { image_url, description, dimensions, price_per_metre_gbp };
}

// ─── Sleep helper ─────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`\n❌ Cannot find ${INPUT_FILE}`);
    console.error('Make sure wrp_catalogue.json is in the same folder as this script.\n');
    process.exit(1);
  }

  const catalogue = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
  const profiles = catalogue.profiles.filter(p => !p.is_compound);

  console.log(`\nWRP Scraper — Simple Mode (no browser needed)`);
  console.log(`Found ${profiles.length} profiles to process\n`);

  let pricesFound = 0;
  let imagesFound = 0;

  for (let i = 0; i < profiles.length; i++) {
    const profile = profiles[i];
    process.stdout.write(`[${String(i + 1).padStart(3)}/${profiles.length}] ${profile.sku.padEnd(12)}`);

    const result = await scrapePage(profile);

    // Merge results back
    const target = catalogue.profiles.find(p => p.sku === profile.sku);
    if (target) {
      if (result.image_url)           { target.image_url = result.image_url; }
      if (result.description)         { target.description = result.description; }
      if (result.dimensions)          { target.dimensions = result.dimensions; }
      if (result.price_per_metre_gbp) {
        target.price_per_metre_gbp = result.price_per_metre_gbp;
        target.price_last_updated = new Date().toISOString().split('T')[0];
        pricesFound++;
      }
      if (result.image_url) imagesFound++;
    }

    const priceStr = result.price_per_metre_gbp ? `£${result.price_per_metre_gbp}/m` : 'no price';
    const imgStr   = result.image_url ? '📷' : '  ';
    console.log(` ${imgStr}  ${priceStr}`);

    // Save every 10 profiles
    if ((i + 1) % 10 === 0) {
      fs.writeFileSync(OUTPUT_FILE, JSON.stringify(catalogue, null, 2));
      console.log(`     💾 Saved progress\n`);
    }

    if (i < profiles.length - 1) await sleep(DELAY_MS);
  }

  // Final save
  catalogue.metadata.prices_last_scraped = new Date().toISOString().split('T')[0];
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(catalogue, null, 2));

  console.log(`\n✅ Done!`);
  console.log(`   Prices found:  ${pricesFound}/${profiles.length}`);
  console.log(`   Images found:  ${imagesFound}/${profiles.length}`);
  console.log(`   Output file:   ${OUTPUT_FILE}`);

  if (pricesFound < profiles.length * 0.5) {
    console.log(`\n⚠️  Fewer than half the prices were found from static HTML.`);
    console.log(`   WRP renders prices dynamically — they may need to be entered manually.`);
    console.log(`   All images and dimensions have been captured.\n`);
  }
}

main().catch(err => {
  console.error('\n❌ Error:', err.message);
  process.exit(1);
});
