/**
 * markdownLite.test.jsx — Unit tests for markdownLite renderer.
 *
 * Covers (team-view-frontend):
 *   - AC5: renderMarkdown produces correct React elements for:
 *          Headings (#..######), unordered lists (ul/li), ordered lists (ol/li),
 *          inline code, fenced code blocks, bold, italic, links.
 *   - AC5/AC10: No dangerouslySetInnerHTML; embedded <script>/HTML in body is NOT
 *               executed — rendered as escaped text.
 *
 * @jest-environment jsdom
 */

import { describe, it, expect } from '@jest/globals';
import { act } from '@testing-library/react';

const { render }        = await import('@testing-library/react');
const React             = (await import('react')).default;
const { renderMarkdown, MarkdownLite } = await import('../markdownLite.jsx');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Normalise React children to array (React may store a single child as a scalar). */
function childrenArray(node) {
  const c = node.props.children;
  if (c === undefined || c === null) return [];
  return Array.isArray(c) ? c : [c];
}

// ── renderMarkdown — unit tests ───────────────────────────────────────────────

describe('renderMarkdown — headings', () => {
  it('renders # as <h1>', () => {
    const nodes = renderMarkdown('# Hello');
    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe('h1');
    expect(childrenArray(nodes[0])[0]).toBe('Hello');
  });

  it('renders ## as <h2>', () => {
    const nodes = renderMarkdown('## Section');
    expect(nodes[0].type).toBe('h2');
  });

  it('renders ### as <h3>', () => {
    const nodes = renderMarkdown('### Sub');
    expect(nodes[0].type).toBe('h3');
  });

  it('renders #### as <h4>', () => {
    const nodes = renderMarkdown('#### Deep');
    expect(nodes[0].type).toBe('h4');
  });

  it('renders ##### as <h5>', () => {
    const nodes = renderMarkdown('##### Deeper');
    expect(nodes[0].type).toBe('h5');
  });

  it('renders ###### as <h6>', () => {
    const nodes = renderMarkdown('###### Deepest');
    expect(nodes[0].type).toBe('h6');
  });

  it('heading text is correct', () => {
    const nodes = renderMarkdown('# My Heading');
    // Inline parse: no inline tokens → single text child
    expect(childrenArray(nodes[0])[0]).toBe('My Heading');
  });
});

describe('renderMarkdown — unordered lists', () => {
  it('renders - items as <ul><li>', () => {
    const nodes = renderMarkdown('- alpha\n- beta');
    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe('ul');
    const items = nodes[0].props.children;
    expect(items).toHaveLength(2);
    expect(items[0].type).toBe('li');
    expect(items[1].type).toBe('li');
  });

  it('renders * items as <ul><li>', () => {
    const nodes = renderMarkdown('* one\n* two');
    expect(nodes[0].type).toBe('ul');
    expect(nodes[0].props.children).toHaveLength(2);
  });

  it('renders + items as <ul><li>', () => {
    const nodes = renderMarkdown('+ first\n+ second');
    expect(nodes[0].type).toBe('ul');
  });

  it('li text content is correct', () => {
    const nodes = renderMarkdown('- foo');
    const li = childrenArray(nodes[0])[0];
    expect(childrenArray(li)[0]).toBe('foo');
  });
});

describe('renderMarkdown — ordered lists', () => {
  it('renders 1. 2. as <ol><li>', () => {
    const nodes = renderMarkdown('1. first\n2. second');
    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe('ol');
    expect(nodes[0].props.children).toHaveLength(2);
    expect(nodes[0].props.children[0].type).toBe('li');
    expect(nodes[0].props.children[1].type).toBe('li');
  });

  it('li text content for ordered list', () => {
    const nodes = renderMarkdown('1. item one');
    const li = childrenArray(nodes[0])[0];
    expect(childrenArray(li)[0]).toBe('item one');
  });
});

describe('renderMarkdown — inline code', () => {
  it('renders `code` as <code>', () => {
    const nodes = renderMarkdown('Use `npm install` here.');
    expect(nodes[0].type).toBe('p');
    // children: ['Use ', <code>npm install</code>, ' here.']
    const codeEl = childrenArray(nodes[0]).find(
      (c) => c && typeof c === 'object' && c.type === 'code',
    );
    expect(codeEl).toBeTruthy();
    expect(codeEl.props.children).toBe('npm install');
  });

  it('returns text for content outside backticks unchanged', () => {
    const nodes = renderMarkdown('plain text');
    expect(nodes[0].type).toBe('p');
    expect(childrenArray(nodes[0])[0]).toBe('plain text');
  });
});

describe('renderMarkdown — fenced code blocks', () => {
  it('renders fenced code block as <pre><code>', () => {
    const md = '```\nconst x = 1;\n```';
    const nodes = renderMarkdown(md);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe('pre');
    const code = nodes[0].props.children;
    expect(code.type).toBe('code');
    expect(code.props.children).toBe('const x = 1;');
  });

  it('multi-line code block preserves newlines', () => {
    const md = '```\nline1\nline2\n```';
    const nodes = renderMarkdown(md);
    expect(nodes[0].props.children.props.children).toBe('line1\nline2');
  });

  it('fenced block with language hint is still rendered as pre/code', () => {
    const md = '```js\nlet y = 2;\n```';
    const nodes = renderMarkdown(md);
    expect(nodes[0].type).toBe('pre');
  });
});

describe('renderMarkdown — bold', () => {
  it('renders **text** as <strong>', () => {
    const nodes = renderMarkdown('**bold** word');
    const strongEl = childrenArray(nodes[0]).find(
      (c) => c && typeof c === 'object' && c.type === 'strong',
    );
    expect(strongEl).toBeTruthy();
    expect(strongEl.props.children).toBe('bold');
  });

  it('renders __text__ as <strong>', () => {
    const nodes = renderMarkdown('__also bold__');
    const strongEl = childrenArray(nodes[0]).find(
      (c) => c && typeof c === 'object' && c.type === 'strong',
    );
    expect(strongEl).toBeTruthy();
    expect(strongEl.props.children).toBe('also bold');
  });
});

describe('renderMarkdown — italic', () => {
  it('renders *text* as <em>', () => {
    const nodes = renderMarkdown('*italic* word');
    const emEl = childrenArray(nodes[0]).find(
      (c) => c && typeof c === 'object' && c.type === 'em',
    );
    expect(emEl).toBeTruthy();
    expect(emEl.props.children).toBe('italic');
  });

  it('renders _text_ as <em>', () => {
    const nodes = renderMarkdown('_also italic_');
    const emEl = childrenArray(nodes[0]).find(
      (c) => c && typeof c === 'object' && c.type === 'em',
    );
    expect(emEl).toBeTruthy();
    expect(emEl.props.children).toBe('also italic');
  });
});

describe('renderMarkdown — links', () => {
  it('renders [text](https://…) as <a> with href', () => {
    const nodes = renderMarkdown('[Click here](https://example.com)');
    const anchor = childrenArray(nodes[0]).find(
      (c) => c && typeof c === 'object' && c.type === 'a',
    );
    expect(anchor).toBeTruthy();
    expect(anchor.props.href).toBe('https://example.com');
    expect(anchor.props.children).toBe('Click here');
  });

  it('link has rel="noopener noreferrer"', () => {
    const nodes = renderMarkdown('[X](https://x.com)');
    const anchor = childrenArray(nodes[0]).find(
      (c) => c && typeof c === 'object' && c.type === 'a',
    );
    expect(anchor.props.rel).toBe('noopener noreferrer');
  });

  it('unsafe URL (javascript:) is rendered as plain text, not <a>', () => {
    const nodes = renderMarkdown('[bad](javascript:alert(1))');
    // Should contain no <a> elements
    const containsAnchor = childrenArray(nodes[0]).some(
      (c) => c && typeof c === 'object' && c.type === 'a',
    );
    expect(containsAnchor).toBe(false);
  });

  it('unsafe URL (data:) is blocked by isSafeUrl — rendered as plain text, not <a>', () => {
    const nodes = renderMarkdown('[x](data:text/html,<h1>XSS)');
    // data: URLs can execute arbitrary HTML/JS — must be blocked
    const containsAnchor = childrenArray(nodes[0]).some(
      (c) => c && typeof c === 'object' && c.type === 'a',
    );
    expect(containsAnchor).toBe(false);
  });

  it('http:// URL is rendered as <a>', () => {
    const nodes = renderMarkdown('[HTTP](http://example.com)');
    const anchor = childrenArray(nodes[0]).find(
      (c) => c && typeof c === 'object' && c.type === 'a',
    );
    expect(anchor).toBeTruthy();
  });

  it('mailto: URL is rendered as <a>', () => {
    const nodes = renderMarkdown('[Mail](mailto:test@example.com)');
    const anchor = childrenArray(nodes[0]).find(
      (c) => c && typeof c === 'object' && c.type === 'a',
    );
    expect(anchor).toBeTruthy();
  });
});

describe('renderMarkdown — paragraphs', () => {
  it('renders plain text as <p>', () => {
    const nodes = renderMarkdown('Hello world');
    expect(nodes[0].type).toBe('p');
  });

  it('blank lines separate paragraphs', () => {
    const nodes = renderMarkdown('first\n\nsecond');
    expect(nodes).toHaveLength(2);
    expect(nodes[0].type).toBe('p');
    expect(nodes[1].type).toBe('p');
  });

  it('returns empty array for empty input', () => {
    expect(renderMarkdown('')).toEqual([]);
    expect(renderMarkdown(null)).toEqual([]);
  });
});

// ── Security: no dangerouslySetInnerHTML / XSS ────────────────────────────────

describe('renderMarkdown — AC5/AC10: no HTML injection', () => {
  it('embedded <script> tag is rendered as text, NOT executed', async () => {
    const scriptMd = '<script>window.__XSS__ = true;</script>\n\nSafe text';
    const { container } = render(
      React.createElement(MarkdownLite, { markdown: scriptMd }),
    );

    // No <script> element in the DOM
    expect(container.querySelector('script')).toBeNull();

    // window.__XSS__ must NOT be set
    expect(window.__XSS__).toBeUndefined();

    // The raw text should appear as text content somewhere in the container
    expect(container.textContent).toContain('<script>');
  });

  it('embedded HTML tags are not parsed as DOM elements', async () => {
    const htmlMd = '<b>not bold</b> plain text';
    const { container } = render(
      React.createElement(MarkdownLite, { markdown: htmlMd }),
    );
    // No <b> element rendered (the angle-bracket text appears as plain text in <p>)
    // It may appear as text, but not as a DOM element
    const paragraphs = container.querySelectorAll('p');
    expect(paragraphs.length).toBeGreaterThan(0);
    // The text content should contain the raw string, not parsed HTML
    expect(container.textContent).toContain('<b>not bold</b>');
    // No actual <b> element
    expect(container.querySelector('b')).toBeNull();
  });

  it('does not use dangerouslySetInnerHTML in any rendered element', () => {
    const md = '# Heading\n\n**bold** and _italic_\n\n- item1\n- item2';
    const nodes = renderMarkdown(md);

    function checkNoDangerousHTML(node) {
      if (!node || typeof node !== 'object') return;
      expect(node.props?.dangerouslySetInnerHTML).toBeUndefined();
      const children = node.props?.children;
      if (Array.isArray(children)) {
        children.forEach(checkNoDangerousHTML);
      } else if (children) {
        checkNoDangerousHTML(children);
      }
    }

    nodes.forEach(checkNoDangerousHTML);
  });
});

// ── MarkdownLite component ────────────────────────────────────────────────────

describe('MarkdownLite component', () => {
  it('renders markdown into DOM elements', async () => {
    const { getByRole } = render(
      React.createElement(MarkdownLite, { markdown: '# Title\n\n- a\n- b' }),
    );
    await act(async () => {});
    expect(getByRole('heading', { level: 1 })).toBeTruthy();
  });

  it('renders nothing for empty markdown', () => {
    const { container } = render(
      React.createElement(MarkdownLite, { markdown: '' }),
    );
    // Outer div is empty
    expect(container.firstChild.childNodes).toHaveLength(0);
  });
});
