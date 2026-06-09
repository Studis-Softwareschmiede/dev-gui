/**
 * markdownLite.jsx — Leichter eigener Markdown-Renderer (AC5/AC10).
 *
 * Reine Funktion: Markdown-String → Array von React-Elementen.
 *
 * Unterstützte Syntax:
 *   - Überschriften: # .. ###### → <h1>..<h6>
 *   - Ungeordnete Listen: - / * / + → <ul><li>
 *   - Geordnete Listen: 1. 2. … → <ol><li>
 *   - Absätze: zusammenhängende Textzeilen → <p>
 *   - Code-Blöcke (```…```) → <pre><code>
 *   - Inline: **bold** → <strong>, _em_ / *em* → <em>,
 *             `code` → <code>, [text](url) → <a>
 *
 * Security (AC5/AC10):
 *   - Kein dangerouslySetInnerHTML / kein innerHTML.
 *   - Eingebettetes HTML im Body wird als Text ausgegeben — NICHT ausgeführt.
 *   - Links: nur http(s)/mailto-URLs werden als <a> gerendert; andere als Text.
 *
 * @module markdownLite
 */

import React from 'react';

// ── URL-Whitelist ─────────────────────────────────────────────────────────────

/**
 * Allow only safe URL schemes to prevent javascript: / data: injection.
 *
 * @param {string} url
 * @returns {boolean}
 */
function isSafeUrl(url) {
  return /^(https?:|mailto:)/i.test(url.trim());
}

// ── Inline parser ─────────────────────────────────────────────────────────────

/**
 * Parse a single line of text and return an array of React nodes.
 * Handles: **bold**, _italic_, *italic*, `code`, [text](url).
 * Everything else is emitted as a plain text node.
 *
 * The regex below scans left-to-right in a single pass; no HTML round-trip.
 *
 * @param {string} text
 * @param {string} keyPrefix  Unique prefix for stable React keys.
 * @returns {Array<React.ReactNode>}
 */
function parseInline(text, keyPrefix) {
  // Pattern priority: code > bold > italic-star > italic-underscore > link
  // Each capturing group must be mutually exclusive in the match.
  const INLINE_RE =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*]+\*)|(_[^_]+_)|(\[([^\]]+)\]\(([^)]+)\))/g;

  const nodes = [];
  let lastIndex = 0;
  let idx = 0;
  let m;

  while ((m = INLINE_RE.exec(text)) !== null) {
    // Emit any plain text before this match
    if (m.index > lastIndex) {
      nodes.push(text.slice(lastIndex, m.index));
    }

    const key = `${keyPrefix}-i${idx++}`;

    if (m[1]) {
      // `code`
      nodes.push(React.createElement('code', { key }, m[1].slice(1, -1)));
    } else if (m[2]) {
      // **bold**
      nodes.push(React.createElement('strong', { key }, m[2].slice(2, -2)));
    } else if (m[3]) {
      // __bold__
      nodes.push(React.createElement('strong', { key }, m[3].slice(2, -2)));
    } else if (m[4]) {
      // *italic*
      nodes.push(React.createElement('em', { key }, m[4].slice(1, -1)));
    } else if (m[5]) {
      // _italic_
      nodes.push(React.createElement('em', { key }, m[5].slice(1, -1)));
    } else if (m[6]) {
      // [text](url)
      const linkText = m[7];
      const href = m[8];
      if (isSafeUrl(href)) {
        nodes.push(
          React.createElement(
            'a',
            { key, href, target: '_blank', rel: 'noopener noreferrer' },
            linkText,
          ),
        );
      } else {
        // Unsafe URL → render as plain text (no anchor)
        nodes.push(`[${linkText}](${href})`);
      }
    }

    lastIndex = INLINE_RE.lastIndex;
  }

  // Trailing plain text
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

// ── Block parser ──────────────────────────────────────────────────────────────

/**
 * Parse a Markdown string into an array of React elements.
 *
 * Block-level elements: headings, fenced code blocks, unordered lists,
 * ordered lists, and paragraphs. Inline elements are parsed inside
 * paragraph and list-item text.
 *
 * @param {string} markdown  Raw Markdown string.
 * @returns {Array<React.ReactElement>}
 */
export function renderMarkdown(markdown) {
  if (!markdown || typeof markdown !== 'string') return [];

  const lines = markdown.split('\n');
  const elements = [];
  let i = 0;
  let blockIdx = 0;

  while (i < lines.length) {
    const line = lines[i];

    // ── Fenced code block (```[lang])
    if (line.trimStart().startsWith('```')) {
      const codeLines = [];
      i++; // skip opening fence
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      elements.push(
        React.createElement(
          'pre',
          { key: `b${blockIdx++}` },
          React.createElement('code', null, codeLines.join('\n')),
        ),
      );
      continue;
    }

    // ── Heading (# … ######)
    const headingMatch = line.match(/^(#{1,6})\s+(.*)/);
    if (headingMatch) {
      const level = headingMatch[1].length; // 1–6
      const tag = `h${level}`;
      const content = parseInline(headingMatch[2], `b${blockIdx}`);
      elements.push(React.createElement(tag, { key: `b${blockIdx++}` }, ...content));
      i++;
      continue;
    }

    // ── Unordered list (lines starting with - / * / +)
    if (/^[ \t]*[-*+]\s/.test(line)) {
      const items = [];
      let liIdx = 0;
      while (i < lines.length && /^[ \t]*[-*+]\s/.test(lines[i])) {
        const itemText = lines[i].replace(/^[ \t]*[-*+]\s+/, '');
        const inlineNodes = parseInline(itemText, `b${blockIdx}-li${liIdx}`);
        items.push(React.createElement('li', { key: `li${liIdx++}` }, ...inlineNodes));
        i++;
      }
      elements.push(React.createElement('ul', { key: `b${blockIdx++}` }, ...items));
      continue;
    }

    // ── Ordered list (lines starting with N.)
    if (/^[ \t]*\d+\.\s/.test(line)) {
      const items = [];
      let liIdx = 0;
      while (i < lines.length && /^[ \t]*\d+\.\s/.test(lines[i])) {
        const itemText = lines[i].replace(/^[ \t]*\d+\.\s+/, '');
        const inlineNodes = parseInline(itemText, `b${blockIdx}-li${liIdx}`);
        items.push(React.createElement('li', { key: `li${liIdx++}` }, ...inlineNodes));
        i++;
      }
      elements.push(React.createElement('ol', { key: `b${blockIdx++}` }, ...items));
      continue;
    }

    // ── Blank line — skip
    if (line.trim() === '') {
      i++;
      continue;
    }

    // ── Paragraph — collect non-blank, non-special lines
    const paraLines = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].trimStart().startsWith('```') &&
      !/^(#{1,6})\s/.test(lines[i]) &&
      !/^[ \t]*[-*+]\s/.test(lines[i]) &&
      !/^[ \t]*\d+\.\s/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      const paraText = paraLines.join(' ');
      const inlineNodes = parseInline(paraText, `b${blockIdx}`);
      elements.push(React.createElement('p', { key: `b${blockIdx++}` }, ...inlineNodes));
    }
  }

  return elements;
}

/**
 * MarkdownLite — React component wrapper around renderMarkdown().
 *
 * @param {{ markdown: string, style?: React.CSSProperties }} props
 */
export function MarkdownLite({ markdown, style }) {
  const nodes = renderMarkdown(markdown);
  return React.createElement('div', { style }, ...nodes);
}
