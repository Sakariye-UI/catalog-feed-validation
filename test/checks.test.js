// Run with: npm test   (Node 18 or later, no dependencies)
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Checks = require('../src/checks.js');
const UI = require('../src/panel.js');
const samples = require('../demo/samples.js');

const ids = (result) => result.findings.map((f) => f.id);
const find = (result, id) => result.findings.find((f) => f.id === id);

function item(i, extra) {
  return Object.assign({
    $id: 'P' + i,
    $title: 'Product ' + i,
    $description: 'A product.',
    $link: 'https://shop.example.com/p/' + i,
    $image_link: 'https://cdn.example.com/p/' + i + '.jpg',
    $price: 10 + i,
  }, extra || {});
}
const json = (items) => JSON.stringify(items);
const ok = (body, extra) => Object.assign({ body: body, httpStatus: 200 }, extra || {});

// ── Samples ------------------------------------------------------------------------------------

test('every sample produces the expected verdict', () => {
  const expected = {
    'first-item': 'syncs_with_issues',
    healthy: 'ok',
    webpage: 'will_not_sync',
    truncated: 'will_not_sync',
    blocked: 'will_not_sync',
  };
  samples.forEach((s) => {
    assert.equal(Checks.validateCatalogFeed(s.response, s.context).verdict, expected[s.key], s.key);
  });
});

test('a healthy feed has no findings', () => {
  const s = samples.find((x) => x.key === 'healthy');
  const r = Checks.validateCatalogFeed(s.response, s.context);
  assert.deepEqual(r.findings, []);
  assert.equal(r.itemCount, 4);
  assert.deepEqual(r.summary, { errors: 0, warnings: 0, notices: 0 });
});

// ── First item ---------------------------------------------------------------------------------

test('fields missing from the first item are listed with counts', () => {
  const r = Checks.validateCatalogFeed(ok(json([item(1), item(2, { original_price: 20 }), item(3, { original_price: 21, brand: 'B' })])));
  const f = find(r, 'first_item_missing_fields');
  assert.ok(f);
  assert.equal(f.severity, 'error');
  assert.equal(f.blocking, false);
  assert.deepEqual(f.fields, [{ name: 'original_price', count: 2 }, { name: 'brand', count: 1 }]);
  assert.equal(f.fix.length, 2);
  assert.match(f.fix[0], /`original_price` can fall back to `price`/);
});

test('the re-add note depends on how many catalog sources the account has', () => {
  const body = json([item(1), item(2, { brand: 'B' })]);
  const note = (ctx) => find(Checks.validateCatalogFeed(ok(body), ctx), 'first_item_missing_fields').note;
  assert.match(note({ catalogSourceCount: 1 }), /one catalog source, so its products stay in place/);
  assert.match(note({ catalogSourceCount: 3 }), /3 catalog sources\. Deleting this one removes its products/);
  assert.match(note({}), /If the account has other catalog sources/);
});

// ── Required fields ----------------------------------------------------------------------------

test('a required field missing from the whole feed blocks the sync', () => {
  const r = Checks.validateCatalogFeed(ok(json([{ $id: '1', $title: 'T', $description: 'D', $link: 'https://x.test/1' }])));
  const f = find(r, 'required_fields_missing');
  assert.equal(f.blocking, true);
  assert.deepEqual(f.fields, [{ name: '$image_link' }]);
  assert.equal(r.verdict, 'will_not_sync');
});

test('common alternative field names are recognised', () => {
  const r = Checks.validateCatalogFeed(ok(json([{ sku: '1', name: 'T', body_html: 'D', url: 'https://x.test/1', imageLink: 'https://x.test/1.jpg' }])));
  assert.equal(find(r, 'required_fields_missing'), undefined);
  assert.equal(r.fieldMap.image_link, 'imageLink');
});

test('blank required values are grouped into one finding with examples', () => {
  const items = [];
  for (let i = 1; i <= 8; i++) items.push(item(i, i > 1 ? { $description: '' } : {}));
  const f = find(Checks.validateCatalogFeed(ok(json(items))), 'required_field_blank');
  assert.equal(f.title, '$description is blank on 7 items');
  assert.equal(f.affectedCount, 7);
  assert.equal(f.items.length, 5);
  assert.deepEqual(f.items[0], { index: 2, id: 'P2' });
});

test('duplicate IDs report how many items are skipped', () => {
  const f = find(Checks.validateCatalogFeed(ok(json([item(1), item(2, { $id: 'P1' }), item(3, { $id: 'P1' })]))), 'duplicate_ids');
  assert.equal(f.affectedCount, 2);
  assert.deepEqual(f.items, [{ index: 1, id: 'P1', alsoAt: [2, 3] }]);
});

// ── Values ------------------------------------------------------------------------------------

test('image URL problems', () => {
  const r = Checks.validateCatalogFeed(ok(json([
    item(1, { $image_link: 'http://cdn.example.com/1.jpg' }),
    item(2, { $image_link: 'data:image/png;base64,AAAA' }),
    item(3, { $image_link: 'cdn.example.com/3.jpg' }),
  ])));
  assert.ok(find(r, 'image_not_https'));
  assert.ok(find(r, 'image_data_uri'));
  assert.ok(find(r, 'image_invalid'));
});

test('prices: quoted strings in JSON, currency text, and a clean sibling field', () => {
  const r = Checks.validateCatalogFeed(ok(json([item(1, { $price: '24.95' }), item(2, { $price: '249 DKK', price_amount: '249' })])));
  assert.ok(find(r, 'price_is_string'));
  const f = find(r, 'price_invalid');
  assert.equal(f.affectedCount, 1);
  assert.match(f.fix[1], /map `price_amount` to \$price/);
});

test('quoted prices are fine in XML, where every value is text', () => {
  const xml = '<?xml version="1.0"?><rss><channel>'
    + [1, 2].map((i) => '<item><id>' + i + '</id><title>T</title><description>D</description><link>https://x.test/' + i + '</link><image_link>https://x.test/' + i + '.jpg</image_link><price>9.99</price></item>').join('')
    + '</channel></rss>';
  const r = Checks.validateCatalogFeed(ok(xml));
  assert.equal(r.format, 'xml');
  assert.deepEqual(r.findings, []);
});

test('every price being zero is a warning', () => {
  const r = Checks.validateCatalogFeed(ok(json([item(1, { $price: 0 }), item(2, { $price: 0 })])));
  assert.equal(find(r, 'all_prices_zero').severity, 'warning');
});

test('inventory that is not a number, or is negative', () => {
  const r = Checks.validateCatalogFeed(ok(json([item(1, { $inventory_quantity: '5 left' }), item(2, { $inventory_quantity: -3 })])));
  assert.ok(find(r, 'inventory_invalid'));
  assert.ok(find(r, 'inventory_negative'));
});

test('categories using ">" or a name containing a comma', () => {
  const r = Checks.validateCatalogFeed(ok(json([
    item(1, { $categories: 'Home > Lighting' }),
    item(2, { $categories: 'Candles, Wax & Wicks' }),
    item(3, { $categories: 'Kitchen, Mugs' }),
  ])));
  assert.equal(find(r, 'categories_wrong_delimiter').affectedCount, 1);
  assert.equal(find(r, 'categories_comma_in_name').affectedCount, 1);
});

test('empty arrays, placeholder text and garbled characters are warnings', () => {
  const r = Checks.validateCatalogFeed(ok(json([
    item(1, { $categories: [] }),
    item(2, { $description: 'n/a' }),
    item(3, { $title: 'CafÃ© table' }),
  ])));
  assert.equal(find(r, 'empty_array').severity, 'warning');
  assert.equal(find(r, 'placeholder_text').severity, 'warning');
  assert.equal(find(r, 'encoding_corrupted').severity, 'warning');
});

// ── Feed shape ---------------------------------------------------------------------------------

test('a webpage is reported as a webpage, not as broken XML', () => {
  const r = Checks.validateCatalogFeed(ok('<!DOCTYPE html><html><body><ul><li>a</li><li>b</li></ul></body></html>'));
  assert.deepEqual(ids(r), ['html_page']);
});

test('JSON with stray characters around it is named, and the items are still checked', () => {
  const r = Checks.validateCatalogFeed(ok('--' + json([item(1), item(2, { $id: 'P1' })]) + '--'));
  assert.equal(r.findings[0].id, 'wrapped_json');
  assert.ok(find(r, 'duplicate_ids'));
});

test('JSON wrapped in an object is found', () => {
  const r = Checks.validateCatalogFeed(ok(JSON.stringify({ products: [item(1), item(2)] })));
  assert.equal(r.itemCount, 2);
  assert.deepEqual(r.findings, []);
});

test('an empty feed and a feed with no products', () => {
  assert.deepEqual(ids(Checks.validateCatalogFeed(ok('   '))), ['empty_response']);
  assert.deepEqual(ids(Checks.validateCatalogFeed(ok('[]'))), ['no_items']);
});

test('XML problems: truncated, stray closing tags, two declarations, nested fields', () => {
  const truncated = samples.find((s) => s.key === 'truncated');
  assert.equal(Checks.validateCatalogFeed(truncated.response).findings[0].id, 'xml_unclosed_elements');

  const fields = '<id>1</id><title>T</title><description>D</description><link>https://x.test/1</link><image_link>https://x.test/1.jpg</image_link>';
  const stray = '<?xml version="1.0"?><rss><channel><item>' + fields + '</item><item>' + fields + '</item></channel></channel></rss>';
  assert.ok(find(Checks.validateCatalogFeed(ok(stray)), 'xml_stray_closing_tags'));

  const doubled = '<?xml version="1.0"?><rss><item>' + fields + '</item></rss>\n<?xml version="1.0"?><rss><item>' + fields + '</item></rss>';
  assert.ok(find(Checks.validateCatalogFeed(ok(doubled)), 'xml_multiple_declarations'));

  const nested = '<?xml version="1.0"?><rss><item>' + fields + '<categories><category>A</category></categories></item><item>' + fields + '</item></rss>';
  assert.deepEqual(find(Checks.validateCatalogFeed(ok(nested)), 'xml_nested_fields').fields, [{ name: 'categories' }]);
});

test('an RSS channel with no products is not mistaken for a one-item feed', () => {
  const r = Checks.validateCatalogFeed(ok('<?xml version="1.0"?><rss><channel><title>Shop</title></channel></rss>'));
  assert.deepEqual(ids(r), ['unreadable_feed']);
  assert.match(r.findings[0].description, /closest match was <channel>/);
});

test('a single-product XML feed is read', () => {
  const r = Checks.validateCatalogFeed(ok('<?xml version="1.0"?><rss><item><id>1</id><title>T</title><description>D</description><link>https://x.test/1</link><image_link>https://x.test/1.jpg</image_link></item></rss>'));
  assert.equal(r.itemCount, 1);
  assert.equal(r.verdict, 'ok');
});

// ── Response ----------------------------------------------------------------------------------

test('HTTP errors block the sync and skip the content checks', () => {
  assert.deepEqual(ids(Checks.validateCatalogFeed({ body: '', httpStatus: 401 })), ['http_401']);
  assert.deepEqual(ids(Checks.validateCatalogFeed({ body: '<html></html>', httpStatus: 403 })), ['http_403']);
  assert.deepEqual(ids(Checks.validateCatalogFeed({ body: '<Error><Code>AccessDenied</Code></Error>', httpStatus: 403 })), ['s3_access_denied']);
  assert.deepEqual(ids(Checks.validateCatalogFeed({ body: '', httpStatus: 500 })), ['http_error']);
  assert.deepEqual(ids(Checks.validateCatalogFeed({ fetchError: 'getaddrinfo ENOTFOUND' })), ['fetch_failed']);
});

test('feed size thresholds', () => {
  const body = json([item(1)]);
  assert.ok(find(Checks.validateCatalogFeed(ok(body, { byteSize: 61 * 1024 * 1024 })), 'feed_large'));
  const big = Checks.validateCatalogFeed(ok(body, { byteSize: 101 * 1024 * 1024 }));
  assert.equal(find(big, 'feed_too_large').blocking, true);
});

test('redirects, slow responses, missing Cache-Control and URLs without an extension', () => {
  const r = Checks.validateCatalogFeed(ok(json([item(1)]), {
    redirected: true, finalUrl: 'https://cdn.example.com/feed.json', responseTimeMs: 22600, cacheControl: '',
    feedUrl: 'https://shop.example.com/api/catalog',
  }));
  assert.deepEqual(ids(r).sort(), ['no_cache_control', 'no_file_extension', 'redirected', 'slow_response']);
  assert.equal(find(r, 'no_cache_control').severity, 'notice');
});

test('Cache-Control is only reported when it was checked', () => {
  assert.equal(find(Checks.validateCatalogFeed(ok(json([item(1)]))), 'no_cache_control'), undefined);
});

test('credentials on a feed that loads without them', () => {
  const resp = ok(json([item(1)]), { requestedWithoutCredentials: true });
  assert.ok(find(Checks.validateCatalogFeed(resp, { sourceHasCredentials: true }), 'credentials_not_needed'));
  assert.equal(find(Checks.validateCatalogFeed(resp, {}), 'credentials_not_needed'), undefined);
});

test('item limit: a warning against the default, an error against a known account limit', () => {
  const items = [];
  for (let i = 0; i < 25001; i++) items.push(item(i));
  const body = json(items);
  assert.equal(find(Checks.validateCatalogFeed(ok(body)), 'over_item_limit').severity, 'warning');
  assert.equal(find(Checks.validateCatalogFeed(ok(body), { accountItemLimit: 25000 }), 'over_item_limit').severity, 'error');
  assert.equal(find(Checks.validateCatalogFeed(ok(body), { accountItemLimit: 100000 }), 'over_item_limit'), undefined);
});

// ── Result shape -------------------------------------------------------------------------------

test('blocking findings come first, then errors, warnings and notices', () => {
  const r = Checks.validateCatalogFeed(ok('--' + json([item(1, { $description: 'n/a' }), item(2, { $id: 'P1' })]) + '--', { cacheControl: '' }));
  const order = r.findings.map((f) => (f.blocking ? 'blocking' : f.severity));
  assert.deepEqual(order, ['blocking', 'error', 'warning', 'notice']);
});

test('every finding has the documented fields', () => {
  samples.forEach((s) => {
    Checks.validateCatalogFeed(s.response, s.context).findings.forEach((f) => {
      assert.equal(typeof f.id, 'string');
      assert.ok(['error', 'warning', 'notice'].includes(f.severity));
      assert.equal(typeof f.blocking, 'boolean');
      assert.ok(f.title.length > 0);
      assert.ok(Array.isArray(f.fix) && f.fix.length > 0, f.id + ' has fix steps');
    });
  });
});

test('the plain-text report lists every finding', () => {
  const s = samples.find((x) => x.key === 'first-item');
  const r = Checks.validateCatalogFeed(s.response, s.context);
  const report = UI.formatReport(r, { feedUrl: s.response.feedUrl });
  assert.match(report, /This source will sync with issues/);
  r.findings.forEach((f) => assert.ok(report.includes(f.title), f.id));
  assert.ok(!report.includes('`'));
});
