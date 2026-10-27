// Custom catalog feed checks.
//
// Pure functions: no network access and no DOM. The caller fetches the feed (in Klaviyo, the
// same fetch the catalog sync already makes) and passes in the body plus what it knows about
// how the fetch went. Everything here works the same in a browser and in Node.
//
// Entry points:
//   validateCatalogFeed(response, context)  — the one the UI calls. Response-level checks
//     (HTTP status, size, redirects, timing) run here, then the content checks below.
//   validateCatalogFeedText(body, options)  — parse and check a payload with no HTTP context.
//   validateCatalogFeedItems(items, options) — the per-item rules, on already-parsed items.
//
// The result shape is documented in README.md. In short, every finding is
//   { id, severity: 'error' | 'warning' | 'notice', blocking, title, description, fix[],
//     note, fields, items, affectedCount }
// where `blocking` means Klaviyo will not read any products from the feed until it is fixed.

(function (global) {
  'use strict';

  const REQUIRED_FIELDS = ['id', 'title', 'description', 'link', 'image_link'];
  const OPTIONAL_FIELDS = ['price', 'categories', 'inventory_quantity', 'inventory_policy'];

  // Most custom feeds use the documented names exactly. The aliases cover the next most common
  // naming choices (Shopify and Google Shopping style feeds especially). Matching is exact after
  // normalising, never fuzzy: a field that matches nothing is reported as missing rather than
  // silently mapped to the wrong column.
  const FIELD_ALIASES = {
    id: ['id', 'sku', 'product_id', 'item_id', 'g:id'],
    title: ['title', 'name', 'product_title', 'product_name', 'g:title'],
    description: ['description', 'desc', 'body', 'body_html', 'product_description', 'g:description'],
    link: ['link', 'url', 'product_url', 'product_link', 'g:link'],
    image_link: ['image_link', 'image', 'image_url', 'img', 'img_url', 'imgurl', 'g:image_link'],
    price: ['price', 'cost', 'g:price'],
    categories: ['categories', 'category', 'product_type', 'g:product_type', 'g:google_product_category'],
    inventory_quantity: ['inventory_quantity', 'quantity', 'stock', 'inventory', 'qty'],
    inventory_policy: ['inventory_policy'],
  };

  // Values that are technically non-empty, so the sync accepts them, but carry no content.
  const PLACEHOLDER_VALUES = new Set([
    'n/a', 'na', 'n.a.', 'none', 'null', 'nil', 'undefined', '-', '--', 'tbd',
    'to be determined', 'todo', 'test', 'testing', 'xxx', 'placeholder', 'coming soon',
  ]);

  // Limits. These come from support research rather than from the sync code, so they should be
  // checked against the real backend values before this ships (see README.md).
  const DEFAULT_ITEM_LIMIT = 25000;              // per account, raisable on request
  const RECOMMENDED_FEED_BYTES = 50 * 1024 * 1024;
  const MAX_FEED_BYTES = 100 * 1024 * 1024;      // "FeedTooLarge" above this
  const SLOW_RESPONSE_MS = 15000;                // "Feed Inaccessible" risk above this

  // How many example items a finding carries. affectedCount always has the full total.
  const EXAMPLE_LIMIT = 5;

  const FEED_EXTENSIONS = ['.xml', '.json', '.rss', '.atom', '.txt', '.csv', '.tsv', '.gz', '.zip'];

  const SEVERITY_RANK = { error: 0, warning: 1, notice: 2 };

  // ── Helpers ---------------------------------------------------------------------------------

  // Strips a leading "$" (Klaviyo's own documented JSON shape uses $id, $title, ...) and the
  // Google Shopping "g:" prefix, splits camelCase (API-generated feeds send imageLink,
  // productId), then lowercases. The camelCase split has to run before lowercasing, because the
  // word boundary is gone afterwards.
  function normalizeFieldKey(name) {
    return String(name || '').trim()
      .replace(/^\$/, '').replace(/^g:/i, '')
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .toLowerCase()
      .replace(/[\s-]+/g, '_');
  }

  // Finds the feed key used for each Klaviyo field, given every key seen anywhere in the feed.
  function mapCatalogFields(rawKeys) {
    const normalizedToRaw = new Map();
    (rawKeys || []).forEach(function (k) {
      const norm = normalizeFieldKey(k);
      if (!normalizedToRaw.has(norm)) normalizedToRaw.set(norm, k);
    });
    const map = {};
    REQUIRED_FIELDS.concat(OPTIONAL_FIELDS).forEach(function (canonical) {
      const aliases = FIELD_ALIASES[canonical] || [canonical];
      let found = null;
      for (const alias of aliases) {
        const norm = normalizeFieldKey(alias);
        if (normalizedToRaw.has(norm)) { found = normalizedToRaw.get(norm); break; }
      }
      map[canonical] = found;
    });
    return map;
  }

  // The reverse lookup: which Klaviyo field (if any) a raw feed key maps to.
  const CANONICAL_BY_ALIAS = (function () {
    const m = new Map();
    Object.keys(FIELD_ALIASES).forEach(function (canonical) {
      FIELD_ALIASES[canonical].forEach(function (alias) {
        const n = normalizeFieldKey(alias);
        if (!m.has(n)) m.set(n, canonical);
      });
    });
    return m;
  })();

  function canonicalFieldFor(name) {
    return CANONICAL_BY_ALIAS.get(normalizeFieldKey(name)) || null;
  }

  function looksLikePlaceholder(value) {
    return PLACEHOLDER_VALUES.has(String(value || '').trim().toLowerCase());
  }

  // parseFloat("249 DKK") is 249, so a lenient check passes values the sync rejects. This
  // requires the whole trimmed string to be a plain number.
  function isStrictNumeric(str) {
    return /^-?\d+(\.\d+)?$/.test(String(str).trim());
  }

  // When $price fails isStrictNumeric, the same item sometimes carries a clean version of it in
  // a sibling field (Google Shopping's g:price alongside g:price_amount). Named in the fix, but
  // never mapped automatically: preferring one field over another would be guessing.
  function findNumericSibling(raw, chosenRawKey) {
    for (const key of Object.keys(raw || {})) {
      if (key === chosenRawKey) continue;
      if (/amount/.test(normalizeFieldKey(key)) && isStrictNumeric(raw[key])) return key;
    }
    return null;
  }

  // UTF-8 text decoded as Latin-1/Windows-1252. Every UTF-8 encoding of an accented Latin-1
  // letter is 0xC3 followed by a continuation byte (0x80-0xBF); decoded the wrong way it shows as
  // U+00C3 plus one more character. U+00C2 + U+00A0-U+00BF is the same mistake one level up (for
  // example a double-encoded non-breaking space). Deliberately narrow: this one mechanical
  // signature only. Written with \u escapes so the source stays plain ASCII.
  const MOJIBAKE_PATTERN = /\u00C3[\u0080-\u00BF]|\u00C2[\u00A0-\u00BF]/;
  function looksLikeMojibake(value) {
    return MOJIBAKE_PATTERN.test(String(value || ''));
  }

  function plural(n, one, many) {
    return n.toLocaleString('en-US') + ' ' + (n === 1 ? one : (many || one + 's'));
  }

  function snippet(value, max) {
    const s = String(value);
    return s.length > max ? s.slice(0, max) + '\u2026' : s;
  }

  function finding(id, severity, props) {
    return Object.assign({
      id: id,
      severity: severity,
      blocking: false,
      title: '',
      description: '',
      fix: [],
      note: null,
      fields: null,
      items: null,
      affectedCount: null,
    }, props);
  }

  // hits are { idx (0-based), itemId, value? }. The UI shows positions 1-based.
  function exampleItems(hits) {
    return hits.slice(0, EXAMPLE_LIMIT).map(function (h) {
      const item = { index: h.idx + 1, id: h.itemId || null };
      if (h.value !== undefined && h.value !== null) item.value = snippet(h.value, 80);
      return item;
    });
  }

  function onItems(hits, extra) {
    return Object.assign({ items: exampleItems(hits), affectedCount: hits.length }, extra);
  }

  // ── JSON parsing ------------------------------------------------------------------------------

  // Klaviyo's documented shape is a bare top-level array. Some feeds wrap it in an object
  // ({"products": [...]}): a short list of common wrapper keys is tried first, then the first
  // array of objects found within three levels.
  function parseJsonCatalogFeed(rawText) {
    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      return { items: null, error: 'It isn\u2019t valid JSON: ' + e.message + '.' };
    }
    function firstArrayOfObjects(value, depth) {
      if (Array.isArray(value)) {
        if (value.length === 0) return value;
        return value.every(function (v) { return v && typeof v === 'object' && !Array.isArray(v); }) ? value : null;
      }
      if (value && typeof value === 'object' && depth < 3) {
        const preferredKeys = ['products', 'items', 'catalog', 'data', 'feed', 'results'];
        for (const key of preferredKeys) {
          if (Array.isArray(value[key])) {
            const found = firstArrayOfObjects(value[key], depth + 1);
            if (found) return found;
          }
        }
        for (const key of Object.keys(value)) {
          const found = firstArrayOfObjects(value[key], depth + 1);
          if (found) return found;
        }
      }
      return null;
    }
    const items = firstArrayOfObjects(data, 0);
    if (!items) {
      return { items: null, error: 'It is valid JSON, but contains no list of products. Klaviyo expects a top-level array of products, or an object with a "products" or "items" array.' };
    }
    return { items: items, error: null };
  }

  // A JSON feed served with stray characters around it, for example --[ {...} ]--. Both parsers
  // reject it; this finds the outermost bracketed payload so the real problem can be named and
  // the item checks can still run on what is inside.
  function recoverWrappedJson(rawText) {
    const first = rawText.search(/[[{]/);
    if (first === -1) return null;
    const last = Math.max(rawText.lastIndexOf(']'), rawText.lastIndexOf('}'));
    if (last <= first) return null;
    const before = rawText.slice(0, first);
    const after = rawText.slice(last + 1);
    if (!before.trim() && !after.trim()) return null;
    let data;
    try { data = JSON.parse(rawText.slice(first, last + 1)); } catch (e) { return null; }
    const describe = function (str, where) {
      const t = str.trim();
      return t ? '\u201c' + snippet(t, 24) + '\u201d ' + where : null;
    };
    const bits = [describe(before, 'before'), describe(after, 'after')].filter(Boolean);
    return { data: data, strayDescription: bits.join(' and ') };
  }

  // ── XML parsing -------------------------------------------------------------------------------

  // A small, non-validating tokenizer rather than DOMParser, so it behaves identically in Node
  // and the browser. It targets the flat, RSS / Google Shopping shaped feeds custom catalogs use
  // (root > optional wrapper > repeated item > leaf fields). A field repeated inside one item
  // keeps the last value, and attributes are ignored: values always come from element text.
  function extractCdataPlaceholders(rawText) {
    const cdataStore = [];
    const replaced = String(rawText || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, function (m, inner) {
      const idx = cdataStore.length;
      cdataStore.push(inner);
      return '\u0000CDATA' + idx + '\u0000';
    });
    return { replaced: replaced, cdataStore: cdataStore };
  }

  function decodeXmlEntities(s) {
    return String(s || '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, '\'')
      .replace(/&#(\d+);/g, function (_, n) { return String.fromCodePoint(parseInt(n, 10)); })
      .replace(/&#x([0-9a-fA-F]+);/g, function (_, n) { return String.fromCodePoint(parseInt(n, 16)); })
      .replace(/&amp;/g, '&'); // last, so "&amp;lt;" is not double-decoded into "<"
  }

  // The sync rejects a feed whose <?xml ?> declaration is not at the very start, with "XML or
  // text declaration not at start of entity". The usual cause is several exports concatenated
  // into one file, so a second declaration appears partway down.
  function xmlDeclarationProblem(rawText) {
    const raw = String(rawText || '');
    const decls = raw.match(/<\?xml[\s\S]*?\?>/gi) || [];
    if (!decls.length) return null;
    if (decls.length > 1) {
      return finding('xml_multiple_declarations', 'error', {
        blocking: true,
        title: 'The feed contains ' + decls.length + ' XML declarations',
        description: 'An XML file can only have one <?xml \u2026?> declaration, at the very start. Klaviyo rejects the feed with \u201cXML or text declaration not at start of entity\u201d. This usually means several exports were joined into one file.',
        fix: ['Generate a single feed, or split the exports into separate catalog sources.'],
      });
    }
    if (raw.trimStart().slice(0, 5).toLowerCase() !== '<?xml') {
      return finding('xml_declaration_not_first', 'error', {
        blocking: true,
        title: 'The XML declaration isn\u2019t at the start of the feed',
        description: 'Something comes before the <?xml \u2026?> declaration. Klaviyo rejects the feed with \u201cXML or text declaration not at start of entity\u201d.',
        fix: ['Remove anything before the declaration, such as whitespace, a byte order mark, HTML or a second export.'],
      });
    }
    return null;
  }

  function tokenizeXml(rawText) {
    const src = String(rawText || '')
      .replace(/<\?xml[\s\S]*?\?>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<!DOCTYPE[\s\S]*?>/i, '');
    const tokens = [];
    const re = /<(\/?)([A-Za-z_][\w:.-]*)([^>]*?)(\/?)>|([^<]+)/g;
    let m;
    while ((m = re.exec(src))) {
      if (m[5] !== undefined) {
        if (m[5].trim()) tokens.push({ type: 'text', text: m[5] });
      } else if (m[1] === '/') {
        tokens.push({ type: 'close', name: m[2] });
      } else {
        tokens.push({ type: 'open', name: m[2], selfClose: m[4] === '/' });
      }
    }
    return tokens;
  }

  // Tolerant, so one stray "<" in a description does not abort the scan, but it records what it
  // tolerated: an unclosed element (a truncated file) or a closing tag with no opening tag (a
  // duplicated closing tag) both make the sync reject the whole feed.
  function buildXmlTree(tokens) {
    const root = { name: '#root', children: [], text: '' };
    const stack = [root];
    const strayCloses = [];
    tokens.forEach(function (tok) {
      const parent = stack[stack.length - 1];
      if (tok.type === 'open') {
        const node = { name: tok.name, children: [], text: '' };
        parent.children.push(node);
        if (!tok.selfClose) stack.push(node);
      } else if (tok.type === 'close') {
        let matched = false;
        for (let i = stack.length - 1; i > 0; i--) {
          if (stack[i].name === tok.name) { stack.length = i; matched = true; break; }
        }
        if (!matched) strayCloses.push(tok.name);
      } else {
        parent.text += tok.text;
      }
    });
    const unclosed = stack.slice(1).map(function (n) { return n.name; });
    return { root: root, unclosed: unclosed, strayCloses: strayCloses };
  }

  // A lone candidate element must carry at least this many recognisable Klaviyo fields to count
  // as a product. A real one-item feed carries five; an RSS <channel> wrapper carries <title>.
  const CANDIDATE_MIN_CANONICAL = 2;

  function countCanonicalLeaves(node) {
    if (!node || !node.children) return 0;
    let n = 0;
    node.children.forEach(function (child) {
      if (child.children.length === 0 && canonicalFieldFor(child.name)) n++;
    });
    return n;
  }

  // The product element is the most repeated element that directly holds leaf (text-only)
  // children. Plain frequency is not enough: every leaf field repeats exactly as often as the
  // item wrapper. Requiring leaf children separates the item from its own fields and from an
  // outer wrapper (such as <items>) that only contains items.
  function findRepeatedContainerNode(root) {
    const counts = new Map();
    (function walk(node) {
      node.children.forEach(function (child) {
        let entry = counts.get(child.name);
        if (!entry) { entry = { count: 0, totalLeafChildren: 0, nodes: [] }; counts.set(child.name, entry); }
        entry.count++;
        entry.totalLeafChildren += child.children.filter(function (c) { return c.children.length === 0; }).length;
        entry.nodes.push(child);
        walk(child);
      });
    })(root);

    let best = null;
    counts.forEach(function (entry, name) {
      if (entry.count >= 2 && entry.totalLeafChildren > 0 && (!best || entry.count > best.entry.count)) {
        best = { name: name, entry: entry };
      }
    });
    if (best) return best;

    // A feed with exactly one product has no repeated element. Accept a single element only
    // when it looks like a product, so <rss><channel><title>x</title></channel></rss> is not
    // mistaken for a one-item feed with four missing required fields.
    counts.forEach(function (entry, name) {
      if (entry.count !== 1 || entry.totalLeafChildren <= 0) return;
      if (countCanonicalLeaves(entry.nodes[0]) < CANDIDATE_MIN_CANONICAL) return;
      if (!best || entry.totalLeafChildren > best.entry.totalLeafChildren) best = { name: name, entry: entry };
    });
    if (best) return best;

    // Nothing believable: hand back the closest element so the finding can name it.
    let closest = null;
    counts.forEach(function (entry, name) {
      if (entry.totalLeafChildren > 0 && (!closest || entry.totalLeafChildren > closest.entry.totalLeafChildren)) {
        closest = { name: name, entry: entry };
      }
    });
    return closest ? { rejectedCandidate: closest } : null;
  }

  function xmlNodeToFieldMap(node, cdataStore) {
    const fields = {};
    node.children.forEach(function (child) {
      if (child.children.length === 0) {
        const withCdata = child.text.replace(/\u0000CDATA(\d+)\u0000/g, function (_, n) { return cdataStore[Number(n)] || ''; });
        fields[child.name] = decodeXmlEntities(withCdata).trim();
      }
    });
    return fields;
  }

  function parseXmlCatalogFeed(rawText) {
    const structural = [];
    const declProblem = xmlDeclarationProblem(rawText);
    if (declProblem) structural.push(declProblem);

    const extracted = extractCdataPlaceholders(rawText);
    const built = buildXmlTree(tokenizeXml(extracted.replaced));

    if (built.unclosed.length) {
      structural.push(finding('xml_unclosed_elements', 'error', {
        blocking: true,
        title: 'The XML is incomplete',
        description: plural(built.unclosed.length, 'element') + ' never close' + (built.unclosed.length === 1 ? 's' : '') + ': <'
          + built.unclosed.slice(0, 3).join('>, <') + '>' + (built.unclosed.length > 3 ? ', \u2026' : '')
          + '. Klaviyo rejects the whole feed with \u201cno element found\u201d.',
        fix: ['Check the feed file is complete. If it is valid when you download it yourself, the export may be stopping early or the transfer is being cut off.'],
      }));
    }
    if (built.strayCloses.length) {
      structural.push(finding('xml_stray_closing_tags', 'error', {
        blocking: true,
        title: 'The XML has closing tags with no opening tag',
        description: plural(built.strayCloses.length, 'closing tag') + ' have no matching opening tag: </'
          + built.strayCloses.slice(0, 3).join('>, </') + '>' + (built.strayCloses.length > 3 ? ', \u2026' : '')
          + '. A duplicated closing tag is the usual cause.',
        fix: ['Remove the extra closing tags so every element opens and closes once.'],
        note: 'Klaviyo can report this as \u201cfeed URL did not return items\u201d rather than as an XML error.',
      }));
    }

    const best = findRepeatedContainerNode(built.root);
    if (!best || best.rejectedCandidate) {
      let detail = '';
      if (best && best.rejectedCandidate) {
        const c = best.rejectedCandidate;
        const leafNames = (c.entry.nodes[0].children || [])
          .filter(function (ch) { return ch.children.length === 0; })
          .map(function (ch) { return ch.name; });
        detail = ' The closest match was <' + c.name + '>'
          + (leafNames.length ? ', which only contains ' + leafNames.slice(0, 5).join(', ') + (leafNames.length > 5 ? ', \u2026' : '') : '')
          + '. None of those are product fields, so it looks like a wrapper rather than a product.';
      }
      return { items: null, structural: structural,
        error: 'No repeated product element was found. Klaviyo expects one element per product, such as <item> or <Product>, containing plain fields like id and title.' + detail };
    }

    // Values more than one level deep are dropped, as they are by the sync: product data has to
    // be one level deep to be mappable.
    const nestedNames = [];
    best.entry.nodes.forEach(function (node) {
      node.children.forEach(function (child) {
        if (child.children.length > 0 && nestedNames.indexOf(child.name) === -1) nestedNames.push(child.name);
      });
    });
    if (nestedNames.length) {
      structural.push(finding('xml_nested_fields', 'warning', {
        title: plural(nestedNames.length, 'field') + ' can\u2019t be mapped because ' + (nestedNames.length === 1 ? 'it is' : 'they are') + ' nested',
        description: 'Inside each <' + best.name + '>, ' + (nestedNames.length === 1 ? 'this element contains' : 'these elements contain') + ' further elements rather than a plain value. Klaviyo only reads product data one level deep, so these values are dropped.',
        fields: nestedNames.map(function (n) { return { name: n }; }),
        fix: ['Flatten them into single elements. For example, use one comma-separated <categories> element instead of <categories><category>\u2026</category></categories>.'],
      }));
    }

    const items = best.entry.nodes.map(function (node) { return xmlNodeToFieldMap(node, extracted.cdataStore); });
    return { items: items, error: null, itemTagName: best.name, structural: structural };
  }

  // ── Item checks -------------------------------------------------------------------------------

  const BLANK_FIX = {
    id: 'Give every item a unique ID.',
    title: 'Add a title to these items, or exclude them from the feed.',
    description: 'Add a description to these items, or exclude them from the feed.',
    link: 'Add the product page URL to these items, or exclude them from the feed.',
    image_link: 'Add an image URL to these items, or exclude them from the feed.',
  };

  // context.catalogSourceCount changes what deleting a source does. With another source still
  // active, the deleted source's products are removed until the re-added source syncs them back
  // (same IDs). When it is the only source, products stay.
  function reAddNote(context) {
    const n = context && typeof context.catalogSourceCount === 'number' ? context.catalogSourceCount : null;
    const lead = 'Refresh sync and Update source won\u2019t pick these fields up. ';
    if (n === 1) return lead + 'This account has one catalog source, so its products stay in place while the source is re-added.';
    if (n && n > 1) return lead + 'This account has ' + n + ' catalog sources. Deleting this one removes its products until the re-added source syncs them back, so re-add it straight away.';
    return lead + 'If the account has other catalog sources, deleting this one removes its products until the re-added source syncs them back. If it is the only source, its products stay in place.';
  }

  function validateCatalogFeedItems(rawItems, options) {
    options = options || {};
    const format = options.format || 'json';
    const context = options.context || {};
    const findings = [];
    const itemCount = rawItems.length;

    if (itemCount === 0) {
      findings.push(finding('no_items', 'error', {
        blocking: true,
        title: 'The feed contains no products',
        description: 'The feed was read successfully, but it has no items in it.',
        fix: ['Check the feed export includes your products. A filter in your feed tool can leave it empty.'],
      }));
      return { itemCount: 0, fieldMap: {}, findings: findings };
    }

    const unionKeys = new Set();
    rawItems.forEach(function (item) { Object.keys(item || {}).forEach(function (k) { unionKeys.add(k); }); });
    const fieldMap = mapCatalogFields(Array.from(unionKeys));

    const missingRequired = REQUIRED_FIELDS.filter(function (f) { return !fieldMap[f]; });
    if (missingRequired.length) {
      findings.push(finding('required_fields_missing', 'error', {
        blocking: true,
        title: missingRequired.length === 1
          ? 'Required field $' + missingRequired[0] + ' is missing'
          : missingRequired.length + ' required fields are missing',
        description: 'No field in the feed matches ' + (missingRequired.length === 1 ? 'this required Klaviyo field' : 'these required Klaviyo fields') + ', so the source can\u2019t be mapped.',
        fields: missingRequired.map(function (f) { return { name: '$' + f }; }),
        fix: ['Add ' + (missingRequired.length === 1 ? 'the field' : 'each field') + ' to every item, or rename an existing field to match. Common alternative names are recognised too, such as sku for $id and image_url for $image_link.'],
      }));
    }

    // Mappable fields are read from the first item only, and only when the source is first
    // added. Update and Refresh never re-read them. So the fix is two steps, feed first.
    const firstItemKeys = new Set(Object.keys(rawItems[0] || {}));
    const missingFromFirst = Array.from(unionKeys).filter(function (k) { return !firstItemKeys.has(k); });
    if (missingFromFirst.length) {
      const fields = missingFromFirst.map(function (k) {
        let n = 0;
        for (let i = 0; i < itemCount; i++) {
          if (rawItems[i] && Object.prototype.hasOwnProperty.call(rawItems[i], k)) n++;
        }
        return { name: k, count: n };
      });
      const example = fields.find(function (f) { return /original|compare|was|old/i.test(f.name) && /price/i.test(f.name); });
      findings.push(finding('first_item_missing_fields', 'error', {
        title: plural(fields.length, 'field') + ' in your feed can\u2019t be mapped',
        description: (fields.length === 1 ? 'This field appears' : 'These fields appear') + ' on later items but not on the first one. Klaviyo detects mappable fields from the first item when a source is added, so '
          + (fields.length === 1 ? 'it doesn\u2019t' : 'they don\u2019t') + ' appear in Configure field mapping.',
        fields: fields,
        fix: [
          'Output ' + (fields.length === 1 ? 'this field' : 'these fields') + ' on every item in your feed, with a fallback where an item has none. For example, '
            + (example ? '`' + example.name + '`' : 'an original price') + ' can fall back to `price`.',
          'Delete this source and add it again with the same Source URL and the same field mapped to `$id`, then map the new fields. Existing field mappings need to be set up again, and product feeds that filter by category won\u2019t work until they are.',
        ],
        note: reAddNote(context),
      }));
    }

    const seenIds = new Map();
    const priceValues = [];
    const blankHits = {};
    REQUIRED_FIELDS.forEach(function (f) { blankHits[f] = []; });
    const placeholderHits = { title: [], description: [], categories: [] };
    const mojibakeHits = { title: [], description: [], categories: [] };
    const linkInvalidHits = [];
    const imageHttpHits = [];
    const imageInvalidHits = [];
    const imageDataUriHits = [];
    const emptyArrayHits = [];
    const emptyArrayFields = [];
    const priceStringHits = [];
    const priceInvalidHits = [];
    const inventoryInvalidHits = [];
    const inventoryNegativeHits = [];
    const categoriesDelimiterHits = [];
    const categoriesCommaNameHits = [];

    rawItems.forEach(function (raw, idx) {
      raw = raw || {};
      const get = function (canonical) { return fieldMap[canonical] ? raw[fieldMap[canonical]] : undefined; };
      const idVal = get('id');
      const idStr = (idVal === undefined || idVal === null) ? '' : String(idVal).trim();

      REQUIRED_FIELDS.forEach(function (f) {
        if (!fieldMap[f]) return;
        const v = get(f);
        if (v === undefined || v === null || String(v).trim() === '') blankHits[f].push({ idx: idx, itemId: idStr });
      });

      if (idStr) {
        if (!seenIds.has(idStr)) seenIds.set(idStr, []);
        seenIds.get(idStr).push(idx);
      }

      const linkVal = get('link');
      if (linkVal && !/^https?:\/\//i.test(String(linkVal).trim())) {
        linkInvalidHits.push({ idx: idx, itemId: idStr, value: String(linkVal).trim() });
      }

      const imgVal = get('image_link');
      if (imgVal && String(imgVal).trim()) {
        const imgStr = String(imgVal).trim();
        // A data: URI is a non-empty, parseable URL, so the item syncs and then renders blank.
        if (/^data:/i.test(imgStr)) imageDataUriHits.push({ idx: idx, itemId: idStr });
        else if (/^http:\/\//i.test(imgStr)) imageHttpHits.push({ idx: idx, itemId: idStr, value: imgStr });
        else if (!/^https:\/\//i.test(imgStr)) imageInvalidHits.push({ idx: idx, itemId: idStr, value: imgStr });
      }

      // An empty array reads as "no data", so the sync skips the write instead of clearing the
      // field, and the previously synced value stays on the product.
      REQUIRED_FIELDS.concat(OPTIONAL_FIELDS).forEach(function (f) {
        if (!fieldMap[f]) return;
        const av = raw[fieldMap[f]];
        if (Array.isArray(av) && av.length === 0) {
          emptyArrayHits.push({ idx: idx, itemId: idStr });
          if (emptyArrayFields.indexOf('$' + f) === -1) emptyArrayFields.push('$' + f);
        }
      });

      ['title', 'description', 'categories'].forEach(function (f) {
        if (!fieldMap[f]) return;
        const v = get(f);
        if (v === undefined || v === null || String(v).trim() === '') return;
        const vStr = String(v).trim();
        if (looksLikePlaceholder(v)) placeholderHits[f].push({ idx: idx, itemId: idStr, value: vStr });
        if (looksLikeMojibake(v)) mojibakeHits[f].push({ idx: idx, itemId: idStr, value: vStr });
      });

      if (fieldMap.price) {
        const rawPriceVal = raw[fieldMap.price];
        if (rawPriceVal !== undefined && rawPriceVal !== null && String(rawPriceVal).trim() !== '') {
          // XML text can't distinguish "29.99" the number from "29.99" the string, so this one
          // check only applies to JSON.
          if (format === 'json' && typeof rawPriceVal === 'string') {
            priceStringHits.push({ idx: idx, itemId: idStr, value: rawPriceVal });
          }
          const priceStr = String(rawPriceVal).trim();
          if (isStrictNumeric(priceStr)) {
            priceValues.push(parseFloat(priceStr));
          } else {
            priceInvalidHits.push({ idx: idx, itemId: idStr, value: priceStr, sibling: findNumericSibling(raw, fieldMap.price) });
          }
        }
      }

      if (fieldMap.categories) {
        const catVal = get('categories');
        if (catVal && String(catVal).includes('>')) {
          categoriesDelimiterHits.push({ idx: idx, itemId: idStr, value: String(catVal).trim() });
        }
        // A category whose name contains a comma is split into two categories, and the comma
        // form has no escape. Deliberately narrow: only a segment carrying a conjunction, which
        // is what half of a split name looks like, so plain lists don't trip it.
        if (catVal && typeof catVal === 'string' && catVal.indexOf(',') !== -1) {
          const suspect = catVal.split(',').map(function (x) { return x.trim(); })
            .filter(function (seg) { return /(^|\s)(&|and)(\s|$)/i.test(seg); });
          if (suspect.length) categoriesCommaNameHits.push({ idx: idx, itemId: idStr, value: catVal.trim() });
        }
      }

      if (fieldMap.inventory_quantity) {
        const invVal = get('inventory_quantity');
        if (invVal !== undefined && invVal !== null && String(invVal).trim() !== '') {
          const invStr = String(invVal).trim();
          if (isStrictNumeric(invStr)) {
            if (parseFloat(invStr) < 0) inventoryNegativeHits.push({ idx: idx, itemId: idStr, value: invStr });
          } else {
            inventoryInvalidHits.push({ idx: idx, itemId: idStr, value: invStr });
          }
        }
      }
    });

    REQUIRED_FIELDS.forEach(function (f) {
      const hits = blankHits[f];
      if (!hits.length) return;
      findings.push(finding('required_field_blank', 'error', onItems(hits, {
        title: '$' + f + ' is blank on ' + plural(hits.length, 'item'),
        description: 'Products with a blank $' + f + ' may fail to sync.',
        fields: [{ name: '$' + f }],
        fix: [BLANK_FIX[f]],
      })));
    });

    if (linkInvalidHits.length) {
      findings.push(finding('link_not_url', 'error', onItems(linkInvalidHits, {
        title: '$link isn\u2019t a URL on ' + plural(linkInvalidHits.length, 'item'),
        description: 'These values don\u2019t start with https:// or http://.',
        fields: [{ name: '$link' }],
        fix: ['Use the full product page URL, starting with https://.'],
      })));
    }

    if (imageHttpHits.length) {
      findings.push(finding('image_not_https', 'error', onItems(imageHttpHits, {
        title: '$image_link uses http:// on ' + plural(imageHttpHits.length, 'item'),
        description: 'Klaviyo requires image URLs to use HTTPS.',
        fields: [{ name: '$image_link' }],
        fix: ['Change these image URLs to https://.'],
      })));
    }

    if (imageDataUriHits.length) {
      findings.push(finding('image_data_uri', 'error', onItems(imageDataUriHits, {
        title: '$image_link is an embedded image on ' + plural(imageDataUriHits.length, 'item'),
        description: 'These are inline data: URIs rather than hosted image URLs. The products sync, but show a blank image, and no error appears.',
        fields: [{ name: '$image_link' }],
        fix: ['Host the images and use their https:// URLs.'],
      })));
    }

    if (imageInvalidHits.length) {
      findings.push(finding('image_invalid', 'error', onItems(imageInvalidHits, {
        title: '$image_link isn\u2019t a valid URL on ' + plural(imageInvalidHits.length, 'item'),
        description: 'These values aren\u2019t full image URLs.',
        fields: [{ name: '$image_link' }],
        fix: ['Use a full image URL starting with https://.'],
      })));
    }

    if (emptyArrayHits.length) {
      findings.push(finding('empty_array', 'warning', onItems(emptyArrayHits, {
        title: 'Empty lists are sent on ' + plural(emptyArrayHits.length, 'item'),
        description: 'Klaviyo treats an empty list as \u201cno data\u201d and skips updating the field, so the value from an earlier sync stays on the product.',
        fields: emptyArrayFields.map(function (n) { return { name: n }; }),
        fix: ['Leave the field out, or send an explicit value.'],
      })));
    }

    ['title', 'description', 'categories'].forEach(function (f) {
      const hits = placeholderHits[f];
      if (!hits.length) return;
      findings.push(finding('placeholder_text', 'warning', onItems(hits, {
        title: '$' + f + ' looks like placeholder text on ' + plural(hits.length, 'item'),
        description: 'Values such as \u201c' + snippet(hits[0].value, 30) + '\u201d are accepted, but appear as-is in emails and product blocks.',
        fields: [{ name: '$' + f }],
        fix: ['Replace them with real product content.'],
      })));
    });

    ['title', 'description', 'categories'].forEach(function (f) {
      const hits = mojibakeHits[f];
      if (!hits.length) return;
      findings.push(finding('encoding_corrupted', 'warning', onItems(hits, {
        title: '$' + f + ' has garbled characters on ' + plural(hits.length, 'item'),
        description: 'Text such as \u201c\u00C3\u00A9\u201d in place of \u201c\u00E9\u201d usually means UTF-8 text was read with the wrong character set.',
        fields: [{ name: '$' + f }],
        fix: ['Save and serve the feed as UTF-8, with a matching encoding declaration or Content-Type header.'],
      })));
    });

    if (priceStringHits.length) {
      findings.push(finding('price_is_string', 'error', onItems(priceStringHits, {
        title: '$price is text instead of a number on ' + plural(priceStringHits.length, 'item'),
        description: 'In a JSON feed, $price has to be a number value, not a quoted string.',
        fields: [{ name: '$price' }],
        fix: ['Send price as a JSON number, for example 29.99 rather than "29.99".'],
      })));
    }

    if (priceInvalidHits.length) {
      const sibling = (priceInvalidHits.find(function (h) { return h.sibling; }) || {}).sibling;
      const withSuffix = priceInvalidHits.some(function (h) { return /^-?\d/.test(h.value); });
      const fix = [withSuffix
        ? 'Remove currency symbols, codes and other text, so $price holds a plain number such as 249.00.'
        : 'Make sure $price holds a plain number such as 249.00.'];
      if (sibling) fix.push('Or map `' + sibling + '` to $price instead. It already holds a plain number.');
      findings.push(finding('price_invalid', 'error', onItems(priceInvalidHits, {
        title: '$price isn\u2019t a plain number on ' + plural(priceInvalidHits.length, 'item'),
        description: 'Klaviyo needs $price to be a number with nothing attached, for example \u201c' + snippet(priceInvalidHits[0].value, 30) + '\u201d won\u2019t work.',
        fields: [{ name: '$price' }],
        fix: fix,
      })));
    }

    if (inventoryInvalidHits.length) {
      findings.push(finding('inventory_invalid', 'error', onItems(inventoryInvalidHits, {
        title: '$inventory_quantity isn\u2019t a number on ' + plural(inventoryInvalidHits.length, 'item'),
        description: 'Klaviyo needs $inventory_quantity to be a whole number with no extra text.',
        fields: [{ name: '$inventory_quantity' }],
        fix: ['Send stock levels as plain numbers, such as 12.'],
      })));
    }

    if (inventoryNegativeHits.length) {
      findings.push(finding('inventory_negative', 'warning', onItems(inventoryNegativeHits, {
        title: '$inventory_quantity is negative on ' + plural(inventoryNegativeHits.length, 'item'),
        description: 'Negative stock levels can hide products from back-in-stock and low-inventory features.',
        fields: [{ name: '$inventory_quantity' }],
        fix: ['Check whether these values are intentional. If not, send 0 instead.'],
      })));
    }

    if (categoriesCommaNameHits.length) {
      findings.push(finding('categories_comma_in_name', 'warning', onItems(categoriesCommaNameHits, {
        title: 'A category name may contain a comma on ' + plural(categoriesCommaNameHits.length, 'item'),
        description: 'Klaviyo splits $categories on commas, so a name such as \u201cCandles, Wax & Wicks\u201d becomes separate categories. A comma-separated list has no way to escape it.',
        fields: [{ name: '$categories' }],
        fix: ['Send categories as a JSON array, with each category name as its own value.'],
      })));
    }

    if (categoriesDelimiterHits.length) {
      findings.push(finding('categories_wrong_delimiter', 'warning', onItems(categoriesDelimiterHits, {
        title: '$categories uses \u201c>\u201d on ' + plural(categoriesDelimiterHits.length, 'item'),
        description: 'Klaviyo expects categories separated by commas, so a path such as \u201cHome > Lighting\u201d becomes one long category.',
        fields: [{ name: '$categories' }],
        fix: ['Separate categories with commas, or send them as a JSON array.'],
      })));
    }

    const duplicates = [];
    seenIds.forEach(function (indexes, idVal) { if (indexes.length > 1) duplicates.push({ id: idVal, indexes: indexes }); });
    if (duplicates.length) {
      const affected = duplicates.reduce(function (n, d) { return n + d.indexes.length - 1; }, 0);
      findings.push(finding('duplicate_ids', 'error', {
        title: plural(duplicates.length, 'ID') + ' ' + (duplicates.length === 1 ? 'is' : 'are') + ' used by more than one item',
        description: 'Klaviyo syncs only the first item with each $id and skips the rest, without showing an error. ' + plural(affected, 'item') + ' will be skipped.',
        fields: [{ name: '$id' }],
        items: duplicates.slice(0, EXAMPLE_LIMIT).map(function (d) {
          return { index: d.indexes[0] + 1, id: d.id, alsoAt: d.indexes.slice(1, 6).map(function (i) { return i + 1; }) };
        }),
        affectedCount: affected,
        fix: ['Give every item a unique $id.'],
      }));
    }

    if (fieldMap.price && priceValues.length > 0 && priceValues.every(function (p) { return p === 0; })) {
      findings.push(finding('all_prices_zero', 'warning', {
        title: 'Every price is 0',
        description: 'All ' + plural(priceValues.length, 'item') + ' with a $price have it set to 0.',
        fields: [{ name: '$price' }],
        fix: ['Check that the price field in your feed is mapped to the right value.'],
      }));
    }

    // The item limit covers the whole account, not each source, so splitting the feed does not
    // help. When the caller knows the account's actual limit, exceeding it is an error; against
    // the default it is a warning, because the limit may already have been raised.
    const limitKnown = typeof context.accountItemLimit === 'number';
    const limit = limitKnown ? context.accountItemLimit : DEFAULT_ITEM_LIMIT;
    if (itemCount > limit) {
      findings.push(finding('over_item_limit', limitKnown ? 'error' : 'warning', {
        title: itemCount.toLocaleString('en-US') + ' items, over ' + (limitKnown ? 'this account\u2019s ' : 'the default ') + limit.toLocaleString('en-US') + '-item limit',
        description: 'The catalog limit applies to the whole account, not each source. '
          + (limitKnown ? 'The sync will stop with a \u201cHit Item Limit\u201d error.' : 'If it hasn\u2019t been raised, the sync stops with a \u201cHit Item Limit\u201d error.'),
        fix: ['Contact Klaviyo Support to raise the limit, or reduce the number of items in the feed. Splitting the feed across sources won\u2019t help.'],
      }));
    }

    return { itemCount: itemCount, fieldMap: fieldMap, findings: findings };
  }

  // ── Payload entry point ---------------------------------------------------------------------

  function validateCatalogFeedText(rawText, options) {
    return finish(checkText(rawText, options), {});
  }

  function checkText(rawText, options) {
    options = options || {};
    const trimmed = String(rawText || '').trim();
    if (!trimmed) {
      return { ok: false, format: null, itemCount: 0, fieldMap: {}, findings: [finding('empty_response', 'error', {
        blocking: true,
        title: 'The Source URL returned an empty response',
        description: 'Klaviyo received no content from the Source URL.',
        fix: ['Check that the Source URL opens the feed file in a browser, and that the export isn\u2019t empty.'],
      })] };
    }

    // A webpage instead of the feed file. Caught before parsing so repeated <div> or <li>
    // markup is never mistaken for products.
    if (/^<!doctype\s+html/i.test(trimmed) || /<html[\s>]/i.test(trimmed.slice(0, 500))) {
      return { ok: false, format: null, itemCount: 0, fieldMap: {}, findings: [finding('html_page', 'error', {
        blocking: true,
        title: 'The Source URL returns a webpage, not a feed',
        description: 'Klaviyo needs the direct URL of the XML or JSON feed file, not a page that displays or links to it.',
        fix: ['Use the feed\u2019s export URL from your ecommerce platform or feed tool. It usually ends in .xml or .json.'],
      })] };
    }

    const hints = [];
    if (options.format === 'json' || options.format === 'xml') hints.push(options.format);
    if (trimmed[0] === '<') hints.push('xml');
    if (trimmed[0] === '[' || trimmed[0] === '{') hints.push('json');
    const tryOrder = hints.length ? Array.from(new Set(hints)) : ['json', 'xml'];

    let parsed = null; let format = null; let lastError = null; let lastStructural = null;
    for (const fmt of tryOrder) {
      const result = fmt === 'json' ? parseJsonCatalogFeed(trimmed) : parseXmlCatalogFeed(trimmed);
      if (result.items) { parsed = result; format = fmt; break; }
      lastError = result.error;
      if (result.structural && result.structural.length) lastStructural = result.structural;
    }

    if (!parsed) {
      const rec = recoverWrappedJson(trimmed);
      if (rec) {
        const inner = parseJsonCatalogFeed(JSON.stringify(rec.data));
        if (inner.items) {
          parsed = { items: inner.items, structural: [finding('wrapped_json', 'error', {
            blocking: true,
            title: 'There are extra characters around the JSON',
            description: 'The feed is valid JSON, but has ' + rec.strayDescription + ' it. Klaviyo reads the response exactly as served, so it rejects the whole feed before reading any product.',
            fix: ['Serve only the JSON array, with nothing before or after it.'],
            note: 'The other checks ran on the JSON inside, so they still apply once this is fixed.',
          })] };
          format = 'json';
        }
      }
    }

    if (!parsed) {
      // A structural problem (a truncated file, a misplaced declaration) is the cause, so it
      // leads; "no product element found" is only its effect.
      const triedBoth = tryOrder.length > 1;
      return { ok: false, format: null, itemCount: 0, fieldMap: {},
        findings: (lastStructural || []).concat([finding('unreadable_feed', 'error', {
          blocking: true,
          title: triedBoth ? 'The feed can\u2019t be read as JSON or XML' : 'The feed can\u2019t be read as ' + tryOrder[0].toUpperCase(),
          description: lastError || '',
          fix: ['Check the feed in a JSON or XML validator and fix the errors it reports.'],
        })]) };
    }

    const core = validateCatalogFeedItems(parsed.items, { format: format, context: options.context });
    return { ok: true, format: format, itemCount: core.itemCount, fieldMap: core.fieldMap,
      findings: (parsed.structural || []).concat(core.findings) };
  }

  // ── Response entry point --------------------------------------------------------------------

  // response: { body, httpStatus, feedUrl, finalUrl, redirected, byteSize, responseTimeMs,
  //             cacheControl, formatHint, fetchError, requestedWithoutCredentials }
  // context:  { catalogSourceCount, accountItemLimit, sourceHasCredentials }
  // Every property is optional; a check whose input is missing simply doesn't run.
  function validateCatalogFeed(response, context) {
    response = response || {};
    context = context || {};
    const findings = [];
    const MB = 1024 * 1024;

    if (response.fetchError) {
      return finish({ ok: false, format: null, itemCount: 0, fieldMap: {}, findings: [finding('fetch_failed', 'error', {
        blocking: true,
        title: 'Klaviyo couldn\u2019t reach the Source URL',
        description: 'The request failed: ' + response.fetchError + '.',
        fix: ['Check that the Source URL is correct and opens in a browser.', 'If the feed needs a username and password, add them to the source.'],
      })] }, response);
    }

    // Amazon S3 answers a revoked public-read grant with an AccessDenied XML document and a 403.
    const bodyHead = String(response.body || '').slice(0, 600);
    const isS3AccessDenied = /<Code>\s*AccessDenied\s*<\/Code>/i.test(bodyHead);
    const status = typeof response.httpStatus === 'number' ? response.httpStatus : null;

    if (status === 401) {
      findings.push(finding('http_401', 'error', {
        blocking: true,
        title: 'The feed is asking for a username and password',
        description: 'The Source URL responded with HTTP 401.',
        fix: [
          'If the feed isn\u2019t meant to be password protected, clear Username and Password on this source. Browsers sometimes fill these in automatically.',
          'If it is protected, add the correct credentials, and make sure the feed URL is only in the Source URL field.',
        ],
      }));
    } else if (status === 403) {
      findings.push(isS3AccessDenied
        ? finding('s3_access_denied', 'error', {
          blocking: true,
          title: 'The feed file has lost its public access',
          description: 'The feed is hosted on Amazon S3, which returned \u201cAccess Denied\u201d (HTTP 403) instead of the feed.',
          fix: ['Re-enable public read access on the file, or on the bucket policy that covers it.'],
        })
        : finding('http_403', 'error', {
          blocking: true,
          title: 'The feed\u2019s host is blocking Klaviyo',
          description: 'The Source URL responded with HTTP 403. This is almost always a firewall or bot-protection rule rather than a problem with the feed itself.',
          fix: ['Allow requests with the user agent Klaviyo/1.0 (and KlaviyoBot) for this URL. Allowing by user agent is more reliable than allowing by IP address.'],
        }));
    } else if (status !== null && status >= 400) {
      findings.push(finding('http_error', 'error', {
        blocking: true,
        title: 'The Source URL responded with an error',
        description: 'The response was HTTP ' + status + ' instead of the feed.',
        fix: ['Check that the Source URL is correct and opens the feed in a browser.'],
      }));
    }

    if (response.feedUrl) {
      let path = '';
      try { path = new URL(String(response.feedUrl)).pathname.toLowerCase(); } catch (e) { path = ''; }
      if (path && path !== '/' && !FEED_EXTENSIONS.some(function (ext) { return path.endsWith(ext); })) {
        findings.push(finding('no_file_extension', 'warning', {
          title: 'The Source URL has no file extension',
          description: 'The URL path doesn\u2019t end in a recognised file extension such as .xml or .json. Klaviyo can refuse a feed on file type alone, even when its content is valid.',
          fix: ['If your host can serve the same feed at a URL ending in .xml or .json, use that address instead.'],
        }));
      }
    }

    if (response.redirected) {
      findings.push(finding('redirected', 'error', {
        blocking: true,
        title: 'The Source URL redirects to another address',
        description: 'Klaviyo needs the feed to be returned directly, without a redirect.' + (response.finalUrl ? ' It currently redirects to ' + response.finalUrl + '.' : ''),
        fix: ['Use the final address as the Source URL.'],
      }));
    }

    if (typeof response.responseTimeMs === 'number' && response.responseTimeMs > SLOW_RESPONSE_MS) {
      findings.push(finding('slow_response', 'warning', {
        title: 'The feed took ' + (response.responseTimeMs / 1000).toFixed(1) + ' seconds to respond',
        description: 'Responses slower than about ' + (SLOW_RESPONSE_MS / 1000) + ' seconds risk \u201cFeed Inaccessible\u201d or \u201cFeed Temporarily Unavailable\u201d errors, even when the feed itself is fine.',
        fix: ['Serve the feed from faster hosting, or from a dedicated, pre-generated feed file.'],
      }));
    }

    // Only when the header was checked and found absent (''), never when it wasn't collected.
    if (response.cacheControl === '') {
      findings.push(finding('no_cache_control', 'notice', {
        title: 'The feed has no Cache-Control header',
        description: 'If the feed sits behind a CDN, the CDN may keep serving an old copy after the feed changes. \u201cSync Complete\u201d means the sync ran, not that it saw the newest data.',
        fix: ['Set a short max-age, or clear the CDN cache whenever the feed changes.'],
      }));
    }

    if (typeof response.byteSize === 'number' && response.byteSize > MAX_FEED_BYTES) {
      findings.push(finding('feed_too_large', 'error', {
        blocking: true,
        title: 'The feed is ' + (response.byteSize / MB).toFixed(1) + ' MB, over the ' + (MAX_FEED_BYTES / MB) + ' MB limit',
        description: 'Klaviyo rejects it with \u201cFeedTooLarge: The feed exceeds the maximum feed size\u201d.',
        fix: ['Split the feed across multiple catalog sources.'],
      }));
    } else if (typeof response.byteSize === 'number' && response.byteSize > RECOMMENDED_FEED_BYTES) {
      findings.push(finding('feed_large', 'warning', {
        title: 'The feed is ' + (response.byteSize / MB).toFixed(1) + ' MB, over the recommended ' + (RECOMMENDED_FEED_BYTES / MB) + ' MB',
        description: 'It will still sync (the limit is ' + (MAX_FEED_BYTES / MB) + ' MB), but large feeds are more likely to time out as they grow.',
        fix: ['Split the feed across multiple sources before it approaches ' + (MAX_FEED_BYTES / MB) + ' MB.'],
      }));
    }

    // Credentials are stored on the source but the feed loaded without them.
    if (context.sourceHasCredentials && response.requestedWithoutCredentials && status !== null && status < 400) {
      findings.push(finding('credentials_not_needed', 'notice', {
        title: 'Username is set on a public feed',
        description: 'The Source URL loads without a username or password, so they aren\u2019t needed. Browsers sometimes fill these in automatically.',
        fix: ['Clear Username and Password unless your feed host requires them.'],
      }));
    }

    // An error status means the body is an error page, not the feed, so its content isn't checked.
    if (status !== null && status >= 400) {
      return finish({ ok: false, format: null, itemCount: 0, fieldMap: {}, findings: findings }, response);
    }

    const content = checkText(response.body, { format: response.formatHint, context: context });
    return finish({
      ok: content.ok,
      format: content.format,
      itemCount: content.itemCount,
      fieldMap: content.fieldMap,
      findings: findings.concat(content.findings),
    }, response);
  }

  // Orders findings (blocking first, then by severity, keeping check order within each group)
  // and adds the summary the UI headline is built from.
  function finish(result, response) {
    const ordered = result.findings
      .map(function (f, i) { return { f: f, i: i }; })
      .sort(function (a, b) {
        if (a.f.blocking !== b.f.blocking) return a.f.blocking ? -1 : 1;
        const s = SEVERITY_RANK[a.f.severity] - SEVERITY_RANK[b.f.severity];
        return s || a.i - b.i;
      })
      .map(function (x) { return x.f; });
    const count = function (sev) { return ordered.filter(function (f) { return f.severity === sev; }).length; };
    const summary = { errors: count('error'), warnings: count('warning'), notices: count('notice') };
    let verdict = 'ok';
    if (ordered.some(function (f) { return f.blocking; })) verdict = 'will_not_sync';
    else if (summary.errors) verdict = 'syncs_with_issues';
    else if (summary.warnings) verdict = 'syncs_with_warnings';
    return Object.assign(result, {
      findings: ordered,
      summary: summary,
      verdict: verdict,
      byteSize: typeof response.byteSize === 'number' ? response.byteSize : null,
    });
  }

  const api = {
    validateCatalogFeed: validateCatalogFeed,
    validateCatalogFeedText: validateCatalogFeedText,
    validateCatalogFeedItems: validateCatalogFeedItems,
    parseJsonCatalogFeed: parseJsonCatalogFeed,
    parseXmlCatalogFeed: parseXmlCatalogFeed,
    mapCatalogFields: mapCatalogFields,
    limits: {
      DEFAULT_ITEM_LIMIT: DEFAULT_ITEM_LIMIT,
      RECOMMENDED_FEED_BYTES: RECOMMENDED_FEED_BYTES,
      MAX_FEED_BYTES: MAX_FEED_BYTES,
      SLOW_RESPONSE_MS: SLOW_RESPONSE_MS,
    },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.CatalogFeedChecks = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
