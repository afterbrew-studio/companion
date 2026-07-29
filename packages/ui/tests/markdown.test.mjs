import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from './dist/markdown.js';

/**
 * Every case renders through the public component and asserts on the serialized
 * HTML, because that string is the only thing a browser ever sees. An attribute
 * that "was rejected" but appears here is not rejected, and a tag that "was
 * escaped" but appears unescaped here is markup.
 *
 * The input is whatever anyone who can comment on a watched repository chose to
 * write, so the security cases below are the contract, not decoration.
 */

const render = (text) => renderToStaticMarkup(createElement(Markdown, { text }));

/** The light/dark image idiom, verbatim from a vercel bot comment on a PR. */
const VERCEL_REQUEST_REVIEW =
  '<a href="https://vercel.com/vercel-agent/request-review?owner=moxxy-ai&amp;repo=companion&amp;pr=35" rel="noreferrer">' +
  '<picture>' +
  '<source media="(prefers-color-scheme: dark)" srcset="https://agents-vade-review.vercel.sh/request-review-dark.svg">' +
  '<source media="(prefers-color-scheme: light)" srcset="https://agents-vade-review.vercel.sh/request-review-light.svg">' +
  '<img alt="Request Review" src="https://agents-vade-review.vercel.sh/request-review-light.svg" width="150">' +
  '</picture></a>';

test('the vercel snippet is a link wrapping an image, not text', () => {
  const html = render(VERCEL_REQUEST_REVIEW);

  assert.match(html, /<a href="https:\/\/vercel\.com\/vercel-agent\/request-review\?owner=moxxy-ai&amp;repo=companion&amp;pr=35"/);
  assert.match(html, /<picture>/);
  assert.match(html, /<source media="\(prefers-color-scheme: dark\)" srcset="https:\/\/agents-vade-review\.vercel\.sh\/request-review-dark\.svg"/i);
  assert.match(html, /<img alt="Request Review" src="https:\/\/agents-vade-review\.vercel\.sh\/request-review-light\.svg" width="150"/);
  // the image is inside the anchor
  assert.match(html, /<a [^>]*>\s*<picture>[\s\S]*<\/picture>\s*<\/a>/);
  // and none of it survived as literal text
  assert.doesNotMatch(html, /&lt;(a|picture|source|img)/);
});

test('an external link opens in a tab and cannot re-enable its opener', () => {
  const html = render('<a href="https://example.com" rel="opener nofollow">go</a>');
  assert.match(html, /rel="[^"]*noreferrer/);
  assert.doesNotMatch(html, /rel="[^"]*opener/);
  assert.match(html, /target="_blank"/);
});

test('an in-app hash route stays in the app', () => {
  const html = render('<a href="#/runs/abc">run</a>');
  assert.match(html, /<a href="#\/runs\/abc">run<\/a>/);
  assert.doesNotMatch(html, /target=/);
});

// ---------- collapsible sections ----------------------------------------------------

test('a details block renders collapsed markup and is not trapped in a paragraph', () => {
  const html = render('<details>\n<summary>Build log</summary>\n\ndone\n\n</details>');
  assert.match(html, /<details><summary>Build log<\/summary>|<details>[\s\S]*<summary>Build log<\/summary>/);
  assert.doesNotMatch(html, /<p>[\s\S]*<details/);
  assert.doesNotMatch(html, /&lt;details&gt;/);
});

test('markdown inside a details block is still markdown', () => {
  const html = render('<details>\n<summary>Steps</summary>\n\n- one\n- two\n\n</details>');
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
});

test('details keeps its open attribute', () => {
  assert.match(render('<details open><summary>s</summary>b</details>'), /<details open=""/);
});

// ---------- the allowlist ------------------------------------------------------------

test('the inline formatting tags render as elements', () => {
  const html = render('<b>b</b><i>i</i><kbd>K</kbd><sub>1</sub><sup>2</sup><del>d</del><ins>n</ins><span>s</span>');
  for (const tag of ['b', 'i', 'kbd', 'sub', 'sup', 'del', 'ins', 'span']) {
    assert.match(html, new RegExp(`<${tag}>`), `${tag} should render`);
  }
});

test('an html table renders as a table', () => {
  const html = render('<table>\n<thead><tr><th align="right">n</th></tr></thead>\n<tbody><tr><td colspan="2">1</td></tr></tbody>\n</table>');
  assert.match(html, /<table>\s*<thead><tr><th align="right">n<\/th><\/tr><\/thead>/);
  assert.match(html, /<td colspan="2">1<\/td>/i);
});

test('a tag outside the allowlist is shown escaped, never as markup', () => {
  for (const tag of ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'link', 'meta']) {
    const html = render(`before <${tag} src="https://evil.example/x">payload</${tag}> after`);
    assert.doesNotMatch(html, new RegExp(`<${tag}[\\s>]`, 'i'), `${tag} must not become markup`);
    assert.match(html, new RegExp(`&lt;${tag}`), `${tag} must be visible as text`);
    assert.match(html, /before/);
    assert.match(html, /after/);
  }
});

test('div and span carry align and nothing else', () => {
  const html = render('<div class="fixed inset-0 bg-red-500" id="root" style="display:none" data-x="1" align="center">hi</div>');
  assert.match(html, /<div align="center">hi<\/div>/);
  for (const attr of ['class="fixed', 'id="root"', 'style="display', 'data-x=']) {
    assert.doesNotMatch(html, new RegExp(attr.replace(/[[\]{}()*+?.\\^$|]/g, '\\$&')), `${attr} must be dropped`);
  }
});

test('attribute values are checked, not just attribute names', () => {
  const html = render('<td align="expression(alert(1))" colspan="2x" rowspan="3">c</td>');
  assert.doesNotMatch(html, /align=/);
  assert.doesNotMatch(html, /colspan=/i);
  assert.match(html, /rowspan="3"/i);

  const img = render('<img src="https://a.example/x.png" width="100%" height="onload">');
  assert.match(img, /width="100%"/);
  assert.doesNotMatch(img, /height=/);
});

test('no event handler attribute reaches the output', () => {
  const html = render(
    '<img src="https://a.example/x.png" onerror="alert(1)" onload="alert(2)">' +
      '<a href="https://a.example" onclick="alert(3)" onmouseover="alert(4)">x</a>' +
      '<details ontoggle="alert(5)"><summary onfocus="alert(6)">s</summary></details>',
  );
  assert.doesNotMatch(html, /\son[a-z]+=/i);
  assert.doesNotMatch(html, /alert/);
});

// ---------- url schemes ---------------------------------------------------------------

/**
 * Each of these is a way a naive `startsWith('javascript:')` check is walked
 * past: case, leading space, the characters a browser strips out of a URL, a
 * numeric or hex entity, a NUL, and a scheme that is not javascript at all.
 */
const HOSTILE_URLS = [
  'javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  '   javascript:alert(1)',
  '\tjavascript:alert(1)',
  'java\tscript:alert(1)',
  'java\nscript:alert(1)',
  'java\rscript:alert(1)',
  'jav\u0000ascript:alert(1)',
  'jav&#97;script:alert(1)',
  'jav&#x61;script:alert(1)',
  '&#106;avascript:alert(1)',
  '&#x6A;avascript:alert(1)',
  'javascript&colon;alert(1)',
  'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
  'DATA:text/html,<b>x</b>',
  'vbscript:msgbox(1)',
  'VBScript:msgbox(1)',
  '//evil.example/x',
  'file:///etc/passwd',
];

for (const url of HOSTILE_URLS) {
  test(`href/src rejects ${JSON.stringify(url)}`, () => {
    const anchor = render(`<a href="${url}">click</a>`);
    assert.doesNotMatch(anchor, /href=/, 'anchor kept a href');
    assert.match(anchor, /click/, 'the link text should survive');

    const image = render(`<img src="${url}" alt="a">`);
    assert.doesNotMatch(image, /src=/, 'image kept a src');

    const sourced = render(`<picture><source srcset="${url}"></picture>`);
    assert.doesNotMatch(sourced, /srcset=/i, 'source kept a srcset');
  });
}

test('a markdown link destination goes through the same check', () => {
  for (const url of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'jav&#97;script:alert(1)', 'data:text/html,x', 'vbscript:x']) {
    const html = render(`[click](${url})`);
    assert.doesNotMatch(html, /<a /, `markdown link to ${url} must not be a link`);
    assert.match(html, /click/);
  }
});

test('the schemes that are allowed still work', () => {
  assert.match(render('<a href="https://a.example/x">x</a>'), /href="https:\/\/a\.example\/x"/);
  assert.match(render('<a href="http://a.example/x">x</a>'), /href="http:\/\/a\.example\/x"/);
  assert.match(render('<a href="mailto:dev@a.example">x</a>'), /href="mailto:dev@a\.example"/);
  assert.match(render('[x](https://a.example)'), /href="https:\/\/a\.example"/);
});

/**
 * The same normalisation that defeats the evasions above has to leave a real
 * URL usable, or it would be indistinguishable from simply rejecting more.
 */
test('a url a browser would accept is still linked after normalisation', () => {
  assert.match(render('<a href="  https://a.example/x  ">x</a>'), /href="https:\/\/a\.example\/x"/);
  assert.match(render('<a href="HTTPS://A.EXAMPLE/x">x</a>'), /href="HTTPS:\/\/A\.EXAMPLE\/x"/);
  // an href wrapped across lines by whatever generated the comment
  assert.match(render('<div>\n<a href="https://a.example/very/long\n/path">x</a>\n</div>'), /href="https:\/\/a\.example\/very\/long\/path"/);
});

test('one bad candidate drops the whole srcset', () => {
  const bad = render('<source srcset="https://a.example/x.png 1x, javascript:alert(1) 2x">');
  assert.doesNotMatch(bad, /srcset=/i);
  const good = render('<source srcset="https://a.example/x.png 1x, https://a.example/y.png 2x">');
  assert.match(good, /srcset="https:\/\/a\.example\/x\.png 1x, https:\/\/a\.example\/y\.png 2x"/i);
});

test('an attribute value cannot break out of its attribute', () => {
  const html = render('<img src="https://a.example/x.png" title="\\"><script>alert(1)</script>" alt="a">');
  assert.doesNotMatch(html, /<script/);
  assert.doesNotMatch(html, /alert\(1\)<\/script>/);
});

// ---------- malformed input ------------------------------------------------------------

test('an unterminated tag does not swallow the rest of the body', () => {
  const html = render('before\n\n<a href="never closed\n\nafter');
  assert.match(html, /before/);
  assert.match(html, /after/);
  assert.doesNotMatch(html, /<a[\s>]/);
});

/**
 * Whatever follows an unterminated tag was inside that tag's attribute, so it
 * is text, not markup. Resuming the search at the next `<` instead would re-walk
 * the same characters once per `<`, which is a hang a commenter can trigger.
 */
test('a tag that never closes ends the scan, and its contents stay text', () => {
  const html = render('<a href="oops <b>not bold</b>');
  assert.match(html, /not bold/);
  assert.doesNotMatch(html, /<b>/);
  assert.match(html, /&lt;b&gt;/);
});

test('an unterminated comment does not swallow the rest of the body', () => {
  const html = render('<!-- open forever and still here');
  assert.match(html, /still here/);
  assert.match(html, /&lt;!--/);
});

test('a closed comment is dropped, as it is on github', () => {
  const html = render('<!-- bot-marker: 1 -->visible');
  assert.match(html, /visible/);
  assert.doesNotMatch(html, /bot-marker/);
});

test('a lone angle bracket is text', () => {
  assert.match(render('a < b and 3 <4 and <3'), /a &lt; b and 3 &lt;4 and &lt;3/);
});

test('a stray close tag is ignored rather than throwing', () => {
  assert.match(render('hello</b></div>world'), /helloworld/);
});

test('nesting past the depth cap terminates and keeps the content', () => {
  const html = render('<div>'.repeat(400) + 'deep' + '</div>'.repeat(400));
  assert.match(html, /deep/);
});

test('an unclosed block tag still renders its content', () => {
  const html = render('<div>never closed');
  assert.match(html, /<div>never closed<\/div>/);
});

// ---------- entities --------------------------------------------------------------------

test('entities are decoded once, and only once', () => {
  assert.match(render('a &amp; b'), /a &amp; b/);
  assert.match(render('&#65;&#x42;'), /AB/);
  // &amp;#106; is the text "&#106;", not the letter j
  assert.match(render('&amp;#106;'), /&amp;#106;/);
  assert.doesNotMatch(render('&amp;#106;'), /[^&]j/);
  // an entity that decodes to a tag is text, not markup
  assert.match(render('&lt;script&gt;alert(1)&lt;/script&gt;'), /&lt;script&gt;/);
  assert.doesNotMatch(render('&lt;script&gt;alert(1)&lt;/script&gt;'), /<script/);
});

test('a code span keeps its source text', () => {
  assert.match(render('`&amp;`'), /<code>&amp;amp;<\/code>/);
});

// ---------- the markdown that already worked ---------------------------------------------

test('plain markdown is unchanged', () => {
  const html = render('# Title\n\nsome **bold**, *em*, ~~gone~~ and `code`\n\n- a\n- b\n\n> quote\n\n---');
  assert.match(html, /<h2>Title<\/h2>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>em<\/em>/);
  assert.match(html, /<del>gone<\/del>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<ul><li>a<\/li><li>b<\/li><\/ul>/);
  assert.match(html, /<blockquote><p>quote<\/p><\/blockquote>/);
  assert.match(html, /<hr\/>/);
});

test('a gfm table is unchanged', () => {
  const html = render('| a | b |\n|---|--:|\n| 1 | 2 |');
  assert.match(html, /<th>a<\/th>/);
  assert.match(html, /<td style="text-align:right">2<\/td>/);
});

test('a fenced code block is unchanged', () => {
  const html = render('```js\nconst x = 1;\n```');
  assert.match(html, /<pre class="md-code">/);
  assert.match(html, /const/);
});

test('html inside a list item and a table cell is rendered', () => {
  assert.match(render('- see <b>this</b>'), /<li>see <b>this<\/b><\/li>/);
  assert.match(render('| a | b |\n|---|---|\n| <kbd>X</kbd> | y |'), /<td><kbd>X<\/kbd><\/td>/);
});
