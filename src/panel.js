// Reference UI for catalog feed validation results.
//
// Renders the result of CatalogFeedChecks.validateCatalogFeed() in the two places it appears on
// the Edit Catalog Source page:
//   createSourceCard()  — an inline card under "Define feed source", opened by "Validate source".
//   createSyncPanel()   — a side panel docked beside the page, opened by "Validate sync".
// Both share renderResults(), so the findings look the same in either place.
//
// This is a framework-free reference for the layout and behaviour. In the app, build it from
// the design-system components named in README.md rather than from this file's markup.
//
// Every string from a finding is written with textContent. Field names, item IDs and values
// come from the customer's feed, so none of it may ever be inserted as HTML. The one
// formatting convention is `backticks`, which render as code.

(function (global) {
  'use strict';

  const ICONS = {
    error: 'M12 1.7c5.689 0 10.3 4.611 10.3 10.3S17.689 22.3 12 22.3 1.7 17.689 1.7 12 6.311 1.7 12 1.7m0 13.8a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2m0-9a.9.9 0 0 0-.9.9v6a.9.9 0 1 0 1.8 0v-6a.9.9 0 0 0-.9-.9',
    warning: 'M10.27 3.1a2 2 0 0 1 3.46 0l8.5 14.7a2 2 0 0 1-1.73 3h-17a2 2 0 0 1-1.73-3zM12 15.6a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2m0-7.5a.9.9 0 0 0-.9.9v4.5a.9.9 0 1 0 1.8 0V9a.9.9 0 0 0-.9-.9',
    notice: 'M12 1.7c5.689 0 10.3 4.611 10.3 10.3S17.689 22.3 12 22.3 1.7 17.689 1.7 12 6.311 1.7 12 1.7m0 8.6a.9.9 0 0 0-.9.9v5.5a.9.9 0 1 0 1.8 0v-5.5a.9.9 0 0 0-.9-.9m0-3.8a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2',
    ok: 'M12 1.7c5.689 0 10.3 4.611 10.3 10.3S17.689 22.3 12 22.3 1.7 17.689 1.7 12 6.311 1.7 12 1.7m5.136 7.163a.9.9 0 0 0-1.272 0L11 13.727l-2.363-2.364a.9.9 0 0 0-1.274 1.274l2.824 2.823c.449.449 1.178.449 1.627 0l5.323-5.323a.9.9 0 0 0-.001-1.274',
    close: 'M16.685 6.185a.8.8 0 1 1 1.13 1.13L13.131 12l4.685 4.685a.8.8 0 1 1-1.131 1.13L12 13.131l-4.685 4.685a.8.8 0 1 1-1.13-1.131L10.869 12 6.185 7.315a.8.8 0 1 1 1.13-1.13L12 10.869z',
  };

  const SEVERITY_LABEL = { error: 'Error', warning: 'Warning', notice: 'Notice' };

  const VERDICT = {
    will_not_sync: { tone: 'error', title: 'This source won’t sync',
      text: 'Klaviyo can’t read products from this feed until the issues marked Blocking are fixed.' },
    syncs_with_issues: { tone: 'error', title: 'This source will sync with issues',
      text: 'Products will sync, but some data will be missing or skipped until the errors below are fixed.' },
    syncs_with_warnings: { tone: 'warning', title: 'This source will sync',
      text: 'Nothing blocks the sync, but the warnings below are worth a look.' },
    ok: { tone: 'ok', title: 'No issues found',
      text: 'This feed meets Klaviyo’s custom catalog requirements.' },
  };

  // Where a finding's field list adds something the title doesn't already say.
  const FIELDS_LABEL = {
    first_item_missing_fields: 'Fields not offered for mapping',
    required_fields_missing: 'Missing fields',
    xml_nested_fields: 'Nested fields',
    empty_array: 'Fields sent as empty lists',
  };

  // ── DOM helpers -------------------------------------------------------------------------------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function icon(name, className) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    if (className) svg.setAttribute('class', className);
    const path = document.createElementNS(NS, 'path');
    if (name === 'chevron') {
      path.setAttribute('d', 'm6.5 9.5 5.5 5.5 5.5-5.5');
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', '1.6');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
    } else {
      path.setAttribute('d', ICONS[name]);
      path.setAttribute('fill', 'currentColor');
      path.setAttribute('fill-rule', 'evenodd');
      path.setAttribute('clip-rule', 'evenodd');
    }
    svg.appendChild(path);
    return svg;
  }

  // Plain text with `backtick` spans rendered as <code>. Everything goes in as text nodes.
  function richText(tag, className, str) {
    const node = el(tag, className);
    String(str || '').split(/(`[^`]+`)/).forEach(function (part) {
      if (/^`[^`]+`$/.test(part)) node.appendChild(el('code', 'cfv-code', part.slice(1, -1)));
      else if (part) node.appendChild(document.createTextNode(part));
    });
    return node;
  }

  function button(variant, label, onClick) {
    const b = el('button', 'cfv-button cfv-button--' + variant, label);
    b.type = 'button';
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  function closeButton(onClick) {
    const b = el('button', 'cfv-icon-button');
    b.type = 'button';
    b.setAttribute('aria-label', 'Close');
    b.appendChild(icon('close'));
    b.addEventListener('click', onClick);
    return b;
  }

  function badge(tone, label) {
    const b = el('span', 'cfv-badge cfv-badge--' + tone);
    b.setAttribute('role', 'status');
    b.appendChild(icon(tone === 'ok' ? 'ok' : tone));
    b.appendChild(el('span', null, label));
    return b;
  }

  function pill(tone, label) {
    return el('span', 'cfv-pill cfv-pill--' + tone, label);
  }

  function count(n, one, many) {
    return n.toLocaleString('en-US') + ' ' + (n === 1 ? one : many);
  }

  function formatBytes(bytes) {
    if (typeof bytes !== 'number') return null;
    if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
    return bytes + ' bytes';
  }

  // ── Results -----------------------------------------------------------------------------------

  function renderSummary(result, options) {
    const row = el('div', 'cfv-summary');
    const s = result.summary || { errors: 0, warnings: 0, notices: 0 };
    if (s.errors) row.appendChild(badge('error', count(s.errors, 'error', 'errors')));
    if (s.warnings) row.appendChild(badge('warning', count(s.warnings, 'warning', 'warnings')));
    if (s.notices) row.appendChild(badge('notice', count(s.notices, 'notice', 'notices')));
    if (!s.errors && !s.warnings && !s.notices) row.appendChild(badge('ok', 'No issues'));
    const meta = [];
    if (result.itemCount) meta.push(count(result.itemCount, 'item', 'items'));
    const size = formatBytes(result.byteSize);
    if (size) meta.push(size);
    meta.push(options.checkedAt ? 'checked at ' + options.checkedAt : 'checked just now');
    row.appendChild(el('span', 'cfv-meta', meta.join(' · ')));
    return row;
  }

  function renderVerdict(result) {
    const v = VERDICT[result.verdict] || VERDICT.ok;
    const box = el('div', 'cfv-alert cfv-alert--' + v.tone);
    box.appendChild(icon(v.tone === 'ok' ? 'ok' : v.tone, 'cfv-alert__icon'));
    const text = el('div');
    text.appendChild(el('div', 'cfv-alert__title', v.title));
    text.appendChild(el('div', null, v.text));
    box.appendChild(text);
    return box;
  }

  function renderItems(f) {
    const list = el('ul', 'cfv-items');
    f.items.forEach(function (item) {
      const li = el('li');
      li.appendChild(el('span', 'cfv-items__index', '#' + item.index));
      const detail = el('span', 'cfv-items__detail');
      if (item.id) detail.appendChild(el('span', 'cfv-items__id', item.id));
      if (item.value) detail.appendChild(el('span', 'cfv-items__value', item.value));
      if (item.alsoAt && item.alsoAt.length) detail.appendChild(el('span', 'cfv-items__value', 'also #' + item.alsoAt.join(', #')));
      li.appendChild(detail);
      list.appendChild(li);
    });
    const more = (f.affectedCount || 0) - f.items.length;
    if (more > 0 && f.id !== 'duplicate_ids') {
      const li = el('li');
      li.appendChild(el('span', 'cfv-items__index'));
      li.appendChild(el('span', 'cfv-meta', count(more, 'more item', 'more items')));
      list.appendChild(li);
    }
    return list;
  }

  function renderFinding(f, open) {
    const row = el('div', 'cfv-finding' + (open ? ' is-open' : ''));
    const bodyId = 'cfv-' + Math.random().toString(36).slice(2, 10);

    const head = el('button', 'cfv-finding__head');
    head.type = 'button';
    head.setAttribute('aria-expanded', String(!!open));
    head.setAttribute('aria-controls', bodyId);
    head.appendChild(icon(f.severity, 'cfv-finding__icon cfv-tone--' + f.severity));
    head.appendChild(el('span', 'cfv-finding__title', f.title));
    head.appendChild(pill(f.severity, f.blocking ? 'Blocking' : SEVERITY_LABEL[f.severity]));
    head.appendChild(icon('chevron', 'cfv-finding__chevron'));
    row.appendChild(head);

    const body = el('div', 'cfv-finding__body');
    body.id = bodyId;
    if (f.description) body.appendChild(richText('p', 'cfv-muted', f.description));

    if (f.fields && f.fields.length && FIELDS_LABEL[f.id]) {
      body.appendChild(el('div', 'cfv-label', FIELDS_LABEL[f.id]));
      const tags = el('div', 'cfv-tags');
      f.fields.forEach(function (field) {
        const tag = el('span', 'cfv-tag');
        tag.appendChild(el('span', 'cfv-tag__name', field.name));
        if (typeof field.count === 'number') tag.appendChild(el('span', 'cfv-tag__count', 'on ' + count(field.count, 'item', 'items')));
        tags.appendChild(tag);
      });
      body.appendChild(tags);
    }

    if (f.items && f.items.length) {
      body.appendChild(el('div', 'cfv-label', f.id === 'duplicate_ids' ? 'Duplicated IDs' : 'Affected items'));
      body.appendChild(renderItems(f));
    }

    if (f.fix && f.fix.length) {
      body.appendChild(el('div', 'cfv-label', 'How to fix'));
      if (f.fix.length === 1) {
        body.appendChild(richText('p', null, f.fix[0]));
      } else {
        const ol = el('ol', 'cfv-steps');
        f.fix.forEach(function (step) { ol.appendChild(richText('li', null, step)); });
        body.appendChild(ol);
      }
    }

    if (f.note) body.appendChild(richText('div', 'cfv-note', f.note));
    row.appendChild(body);

    head.addEventListener('click', function () {
      const isOpen = row.classList.toggle('is-open');
      head.setAttribute('aria-expanded', String(isOpen));
    });
    return row;
  }

  // The summary badges, the verdict and the list of findings. The first finding starts open,
  // because it is the one to fix first.
  function renderResults(result, options) {
    options = options || {};
    const root = el('div', 'cfv-results');
    root.appendChild(renderSummary(result, options));
    root.appendChild(renderVerdict(result));
    if (result.findings && result.findings.length) {
      const list = el('div', 'cfv-findings');
      result.findings.forEach(function (f, i) { list.appendChild(renderFinding(f, i === 0)); });
      root.appendChild(list);
    }
    return root;
  }

  function renderLoading(text) {
    const box = el('div', 'cfv-loading');
    box.setAttribute('role', 'status');
    box.appendChild(el('span', 'cfv-muted', text || 'Reading the feed from the Source URL…'));
    const bar = el('div', 'cfv-progress');
    bar.appendChild(el('div', 'cfv-progress__bar'));
    box.appendChild(bar);
    return box;
  }

  function renderError(message) {
    const box = el('div', 'cfv-alert cfv-alert--error');
    box.appendChild(icon('error', 'cfv-alert__icon'));
    const text = el('div');
    text.appendChild(el('div', 'cfv-alert__title', 'Validation couldn’t finish'));
    text.appendChild(el('div', null, message || 'Something went wrong while checking the feed. Try again.'));
    box.appendChild(text);
    return box;
  }

  function stateApi(slot, footer) {
    return {
      showLoading: function (text) { slot.replaceChildren(renderLoading(text)); if (footer) footer.hidden = true; },
      showResult: function (result, options) { slot.replaceChildren(renderResults(result, options)); if (footer) footer.hidden = false; },
      showError: function (message) { slot.replaceChildren(renderError(message)); if (footer) footer.hidden = false; },
    };
  }

  // ── Validate source: inline card ------------------------------------------------------------

  // options: { onClose, onRevalidate }
  function createSourceCard(options) {
    options = options || {};
    const card = el('section', 'cfv-card');
    card.setAttribute('aria-label', 'Source validation');

    const header = el('div', 'cfv-card__header');
    const heading = el('div', 'cfv-card__heading');
    heading.appendChild(el('h3', 'cfv-card__title', 'Source validation'));
    heading.appendChild(el('p', 'cfv-card__description', 'Checks the feed at the Source URL against Klaviyo’s custom catalog requirements. Nothing is changed.'));
    header.appendChild(heading);
    header.appendChild(closeButton(function () { if (options.onClose) options.onClose(); }));
    card.appendChild(header);

    const body = el('div', 'cfv-card__body');
    const slot = el('div');
    body.appendChild(slot);
    const footer = el('div', 'cfv-card__footer');
    footer.appendChild(el('span', 'cfv-meta', 'Fix these in your feed, then validate again.'));
    if (options.onRevalidate) footer.appendChild(button('secondary', 'Validate again', options.onRevalidate));
    body.appendChild(footer);
    card.appendChild(body);

    return Object.assign({ element: card }, stateApi(slot, footer));
  }

  // ── Validate sync: docked side panel --------------------------------------------------------

  // options: { onClose, onRefreshSync, onCopyReport }
  // The panel is position: fixed on the right. Opening it should also narrow the page so the
  // panel sits beside the content rather than over it, the way the Composer panel does; that
  // belongs to the app shell, so it is left to the caller (see demo/index.html).
  function createSyncPanel(options) {
    options = options || {};
    const panel = el('aside', 'cfv-dock');
    panel.setAttribute('aria-label', 'Validate sync');

    const header = el('div', 'cfv-dock__header');
    header.appendChild(el('h2', 'cfv-dock__title', 'Validate sync'));
    header.appendChild(closeButton(function () { if (options.onClose) options.onClose(); }));
    panel.appendChild(header);

    const body = el('div', 'cfv-dock__body');
    body.appendChild(el('p', 'cfv-muted cfv-dock__intro', 'Checks the feed at the Source URL before you sync. Nothing is changed.'));
    const slot = el('div');
    body.appendChild(slot);
    panel.appendChild(body);

    const footer = el('div', 'cfv-dock__footer');
    if (options.onCopyReport) {
      const copy = button('secondary', 'Copy report', function () {
        options.onCopyReport();
        copy.textContent = 'Copied';
        setTimeout(function () { copy.textContent = 'Copy report'; }, 1500);
      });
      footer.appendChild(copy);
    }
    if (options.onRefreshSync) footer.appendChild(button('primary', 'Refresh sync', options.onRefreshSync));
    panel.appendChild(footer);

    return Object.assign({
      element: panel,
      open: function () { panel.classList.add('is-open'); },
      close: function () { panel.classList.remove('is-open'); },
      isOpen: function () { return panel.classList.contains('is-open'); },
    }, stateApi(slot, footer));
  }

  // ── Plain-text report (Copy report) ---------------------------------------------------------

  function formatReport(result, options) {
    options = options || {};
    const v = VERDICT[result.verdict] || VERDICT.ok;
    const lines = ['Catalog feed validation'];
    if (options.feedUrl) lines.push('Source URL: ' + options.feedUrl);
    const meta = [];
    if (result.itemCount) meta.push(count(result.itemCount, 'item', 'items'));
    const size = formatBytes(result.byteSize);
    if (size) meta.push(size);
    if (meta.length) lines.push(meta.join(', '));
    lines.push('', v.title + '. ' + v.text);
    (result.findings || []).forEach(function (f, i) {
      lines.push('', (i + 1) + '. [' + (f.blocking ? 'Blocking' : SEVERITY_LABEL[f.severity]) + '] ' + f.title);
      if (f.description) lines.push('   ' + f.description);
      if (f.fields && f.fields.length && FIELDS_LABEL[f.id]) {
        lines.push('   ' + FIELDS_LABEL[f.id] + ': ' + f.fields.map(function (x) {
          return x.name + (typeof x.count === 'number' ? ' (on ' + count(x.count, 'item', 'items') + ')' : '');
        }).join(', '));
      }
      if (f.items && f.items.length) {
        lines.push('   Examples: ' + f.items.map(function (it) { return '#' + it.index + (it.id ? ' ' + it.id : ''); }).join(', '));
      }
      (f.fix || []).forEach(function (step, n) {
        lines.push('   ' + (f.fix.length > 1 ? 'Fix ' + (n + 1) + ': ' : 'Fix: ') + step.replace(/`/g, ''));
      });
      if (f.note) lines.push('   Note: ' + f.note.replace(/`/g, ''));
    });
    return lines.join('\n');
  }

  const api = {
    createSourceCard: createSourceCard,
    createSyncPanel: createSyncPanel,
    renderResults: renderResults,
    formatReport: formatReport,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.CatalogFeedValidationUI = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
