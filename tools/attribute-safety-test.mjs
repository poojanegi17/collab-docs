/**
 * The sanitisers that stand between a collaborator's attribute values and the
 * DOM.
 *
 * WHY THIS FILE EXISTS. `bold: true` renders as a class name and carries no
 * information out of the document. The attributes added for the full toolbar
 * do: `color` and `size` end up inside a `style` attribute, `link` ends up in
 * an `href`, and every one of those values was written by whoever was editing
 * the document -- which, in a product whose whole point is that you share
 * documents with people, is not a trusted source.
 *
 * So these are the checks that matter, and they are all negative:
 *
 *   - `javascript:` in a link is script execution in the reader's page, which
 *     is what turns "someone shared a document with me" into an attack
 *   - a CSS value carrying `;` escapes the property it was meant to set and
 *     can write any other one
 *   - an unbounded font size is a denial of service on everyone who opens the
 *     document, not just the author
 *
 * They run in Node with no browser and no server: these are pure functions,
 * and that is exactly why they are worth testing directly rather than through
 * a rendered page where a passing result might only mean the value never
 * arrived.
 *
 *   node tools/attribute-safety-test.mjs
 */
import {
  safeColor, safeFont, safeIndent, safeLink, safeList, safeSize, safeSpacing,
  safeAlign, normaliseLinkInput, MAX_SIZE, MIN_SIZE,
} from '../frontend/src/ui/attribute-values.js';
import { MAX_INDENT } from '../shared/ot/src/index.js';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
  ok ? pass++ : fail++;
};

console.log('\nAttribute value safety\n');

// ---- links ------------------------------------------------------------------

check('1. an ordinary https link survives',
  safeLink('https://example.com/a?b=c#d') === 'https://example.com/a?b=c#d');
check('1b. http and mailto survive',
  safeLink('http://example.com/') === 'http://example.com/'
  && safeLink('mailto:ada@example.com') === 'mailto:ada@example.com');

// The one that matters. Each of these is a real bypass of a naive check.
const HOSTILE_LINKS = [
  'javascript:alert(1)',
  'JavaScript:alert(1)',                  // scheme is case-insensitive
  ' javascript:alert(1)',                 // leading space, trimmed by the parser
  'java\tscript:alert(1)',                // embedded tab, stripped by the parser
  'java\nscript:alert(1)',
  'data:text/html;base64,PHNjcmlwdD4=',   // data: renders as a document
  'vbscript:msgbox(1)',
  'file:///etc/passwd',
  'blob:https://example.com/x',
];
const survived = HOSTILE_LINKS.filter((u) => safeLink(u) !== null);
check('2. no scheme outside http/https/mailto survives',
  survived.length === 0, survived.join(' ; ') || 'all refused');

check('2b. refusal is null, so the renderer drops the mark rather than guessing',
  safeLink('javascript:alert(1)') === null);
check('2c. an absurdly long URL is refused rather than stored',
  safeLink('https://example.com/' + 'a'.repeat(4000)) === null);
check('2d. nonsense is refused', safeLink('not a url') === null && safeLink('') === null);
check('2e. non-strings are refused',
  safeLink(null) === null && safeLink({}) === null && safeLink(12) === null);

// What people actually type into a link box.
check('3. a bare domain is assumed to be https',
  normaliseLinkInput('example.com') === 'https://example.com/');
check('3b. a typed scheme is respected',
  normaliseLinkInput('http://example.com') === 'http://example.com/');
check('3c. a hostile scheme is NOT rescued by the assumption',
  normaliseLinkInput('javascript:alert(1)') === '');
check('3d. blank input clears rather than linking to nothing',
  normaliseLinkInput('   ') === '');

// ---- colours ----------------------------------------------------------------

check('4. a six-digit hex colour survives', safeColor('#A1B2C3') === '#a1b2c3');

const HOSTILE_COLORS = [
  'red;position:fixed;inset:0;z-index:9999',
  '#fff;background:url(javascript:alert(1))',
  'url(https://evil.example/track)',
  'expression(alert(1))',
  '#fff /* */ ;color:red',
  'var(--anything)',
  '#ffff',            // wrong length -- accepting it means the regex is loose
  '#gggggg',          // not hex
];
const colorsThrough = HOSTILE_COLORS.filter((c) => safeColor(c) !== null);
check('5. nothing but #rrggbb survives, so no value can escape the property',
  colorsThrough.length === 0, colorsThrough.join(' ; ') || 'all refused');

check('5b. named colours are refused too -- harmless, but the check stays a regex',
  safeColor('red') === null);

// ---- sizes ------------------------------------------------------------------

check('6. a normal size survives', safeSize(14) === 14 && safeSize('18') === 18);
check('6b. a size out of range is refused, not clamped silently to something odd',
  safeSize(MAX_SIZE + 1) === null && safeSize(MIN_SIZE - 1) === null);
check('6c. a size that would break the document for everyone is refused',
  safeSize(40000) === null && safeSize(-5) === null);
check('6d. non-numbers are refused',
  safeSize('14px') === null && safeSize('1e9') === null && safeSize(NaN) === null
  && safeSize(Infinity) === null);
check('6e. fractional sizes round rather than reaching CSS raw', safeSize(13.6) === 14);

// ---- fonts, lists, alignment, spacing --------------------------------------

check('7. a known font key resolves to a stack this code owns',
  typeof safeFont('serif') === 'string' && safeFont('serif').includes('Georgia'));
check('7b. an unknown key is refused rather than passed through',
  safeFont('Comic Sans') === null && safeFont('') === null);
check('7c. a font stack cannot be smuggled in as the key',
  safeFont('Georgia; background: red') === null);

check('8. list kinds are exactly the two that render',
  safeList('bullet') === 'bullet' && safeList('number') === 'number'
  && safeList('roman') === null && safeList(true) === null);

check('9. alignment refuses anything that is not one of three values',
  safeAlign('center') === 'center' && safeAlign('middle') === null
  && safeAlign('center; float: left') === null);

check('10. spacing refuses anything unexpected',
  safeSpacing('150') === '150' && safeSpacing(150) === '150'
  && safeSpacing('151') === null && safeSpacing('1.5') === null);

// ---- indent -----------------------------------------------------------------

// Indent clamps rather than refusing, because it is a magnitude: a value of 40
// from a buggy client should indent as far as allowed, not lose the indent.
check('11. indent clamps to the maximum instead of dropping',
  safeIndent(40, MAX_INDENT) === MAX_INDENT);
check('11b. negative and nonsense indents become zero',
  safeIndent(-3, MAX_INDENT) === 0 && safeIndent('deep', MAX_INDENT) === 0
  && safeIndent(null, MAX_INDENT) === 0);
check('11c. a normal indent is untouched', safeIndent(3, MAX_INDENT) === 3);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
