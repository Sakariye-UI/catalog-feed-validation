// Example feeds for the demo page and the tests. All made up.
//
// Each sample is { key, label, response, context }, where response and context are exactly what
// validateCatalogFeed() takes. byteSize is filled in from the body when it isn't given.
(function (global) {
  'use strict';

  function xmlItem(fields) {
    return '    <item>\n' + Object.keys(fields).map(function (k) {
      return '      <' + k + '>' + fields[k] + '</' + k + '>';
    }).join('\n') + '\n    </item>';
  }

  function base(i, extra) {
    return Object.assign({
      'g:id': 'LAMP-' + (1000 + i),
      'g:title': 'Table lamp ' + i,
      'g:description': 'Hand-finished ceramic table lamp, model ' + i + '.',
      'g:link': 'https://shop.example.com/products/lamp-' + i,
      'g:image_link': 'https://cdn.example.com/images/lamp-' + i + '.jpg',
      'g:price': (39 + i) + '.00',
      'g:product_type': 'Lighting, Table lamps',
    }, extra || {});
  }

  // The first item has no original_price or brand, so neither can be mapped.
  const firstItemFeed = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">\n  <channel>\n'
    + [
      xmlItem(base(1)),
      xmlItem(base(2, { original_price: '49.00', brand: 'Northlight' })),
      xmlItem(base(3)),
      xmlItem(base(4, { original_price: '59.00', brand: 'Northlight' })),
      xmlItem(base(5, { 'g:description': '' })),
      xmlItem(base(6, { brand: 'Atelier' })),
      xmlItem(base(7, { 'g:image_link': 'http://cdn.example.com/images/lamp-7.jpg' })),
      xmlItem(base(8, { 'g:price': '47.00 EUR' })),
    ].join('\n')
    + '\n  </channel>\n</rss>\n';

  const healthyFeed = JSON.stringify([1, 2, 3, 4].map(function (i) {
    return {
      $id: 'MUG-' + i,
      $title: 'Stoneware mug ' + i,
      $description: 'Glazed stoneware mug, 350 ml.',
      $link: 'https://shop.example.com/products/mug-' + i,
      $image_link: 'https://cdn.example.com/images/mug-' + i + '.jpg',
      $price: 18 + i,
      $categories: ['Kitchen', 'Mugs'],
      $inventory_quantity: 10 * i,
    };
  }), null, 2);

  const webpage = '<!DOCTYPE html>\n<html lang="en"><head><title>Table lamps | Example Shop</title></head>\n'
    + '<body><ul class="products"><li><a href="/products/lamp-1">Table lamp 1</a></li>'
    + '<li><a href="/products/lamp-2">Table lamp 2</a></li></ul></body></html>\n';

  const truncatedFeed = '<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0">\n  <channel>\n'
    + [1, 2, 3].map(function (i) {
      return xmlItem({ id: 'SKU-' + i, title: 'Linen cushion ' + i, description: 'Washed linen cushion cover.',
        link: 'https://shop.example.com/products/cushion-' + i, image_link: 'https://cdn.example.com/images/cushion-' + i + '.jpg', price: '29.00' });
    }).join('\n')
    + '\n    <item>\n      <id>SKU-4</id>\n      <title>Linen cush';

  const challengePage = '<!DOCTYPE html><html><head><title>Just a moment...</title></head>'
    + '<body>Checking your browser before accessing shop.example.com.</body></html>';

  const samples = [
    {
      key: 'first-item',
      label: 'Fields missing from the first item',
      response: { body: firstItemFeed, httpStatus: 200, feedUrl: 'https://feeds.example.com/export/catalog.xml',
        responseTimeMs: 840, cacheControl: 'public, max-age=300', requestedWithoutCredentials: true },
      context: { catalogSourceCount: 1, sourceHasCredentials: true },
    },
    {
      key: 'healthy',
      label: 'A healthy JSON feed',
      response: { body: healthyFeed, httpStatus: 200, feedUrl: 'https://shop.example.com/feeds/products.json',
        responseTimeMs: 310, cacheControl: 'max-age=600' },
      context: { catalogSourceCount: 2 },
    },
    {
      key: 'webpage',
      label: 'A webpage instead of the feed',
      response: { body: webpage, httpStatus: 200, feedUrl: 'https://shop.example.com/collections/table-lamps.xml',
        cacheControl: 'max-age=60' },
      context: {},
    },
    {
      key: 'truncated',
      label: 'An incomplete XML file',
      response: { body: truncatedFeed, httpStatus: 200, feedUrl: 'https://feeds.example.com/export/cushions.xml',
        cacheControl: 'no-cache' },
      context: {},
    },
    {
      key: 'blocked',
      label: 'Blocked by a firewall (HTTP 403)',
      response: { body: challengePage, httpStatus: 403, feedUrl: 'https://shop.example.com/feeds/catalog.xml' },
      context: {},
    },
  ];

  samples.forEach(function (s) {
    if (typeof s.response.byteSize !== 'number') {
      s.response.byteSize = typeof TextEncoder !== 'undefined'
        ? new TextEncoder().encode(s.response.body).length
        : s.response.body.length;
    }
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = samples;
  if (global) global.CatalogFeedSamples = samples;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
