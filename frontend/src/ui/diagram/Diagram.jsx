/**
 * The shapes a decision comes in.
 *
 * Eighteen ADRs, and drawing eighteen bespoke pictures would produce eighteen
 * different visual languages -- which is worse than no pictures, because the
 * reader has to learn each one before it says anything. Nearly every decision
 * in this repository turns out to be one of six shapes, so those are drawn
 * once and given labels:
 *
 *   choice   two options, one taken          "we picked this over that"
 *   split    one thing, two consequences     "same seam, different cost"
 *   seam     an interface with sides         "neither side knows the other"
 *   flow     steps in order                  "this happens, then this"
 *   strip    a sequence of records           "a log, and what marks it"
 *   cells    a row of labelled boxes         "this is the data model"
 *
 * Inline SVG rather than an image: it inherits the page's colours through CSS
 * custom properties, stays sharp at any size, costs no request, and the labels
 * are real text that can be selected and read by a screen reader.
 *
 * Every diagram carries a `<title>`, which is what a screen reader announces.
 * A picture whose whole content is visual has to say in words what it shows,
 * or it is decoration wearing the clothes of information.
 */
import React from 'react';
import './diagram.css';

const W = 320;
const H = 92;

/** Shared frame: one viewBox, one title, one set of classes. */
function Frame({ title, children }) {
  return (
    <svg
      className="dia"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={title}
      preserveAspectRatio="xMidYMid meet"
    >
      <title>{title}</title>
      {children}
    </svg>
  );
}

/**
 * Wrap a label to the width of its box.
 *
 * SVG text does not wrap, so a four-step flow -- where each box is about
 * sixty pixels wide -- rendered "one merged frame" straight through its own
 * border and out over the arrow beside it. There is no measuring API in
 * static SVG, so this estimates from character count: at 9.5px in the display
 * face an average glyph is a little over five pixels.
 *
 * Two lines maximum. A label needing three is not a label, and the fix for it
 * belongs in briefs.js rather than here.
 */
function wrap(label, maxChars) {
  if (label.length <= maxChars) return [label];
  const out = [];
  let line = '';
  for (const word of label.split(' ')) {
    if (!line) line = word;
    else if ((line + ' ' + word).length <= maxChars) line += ' ' + word;
    else { out.push(line); line = word; }
  }
  if (line) out.push(line);
  return out.slice(0, 2);
}

/** A rounded box with a label, and optionally a second line under it. */
function Box({ x, y, w, h, label, sub, tone = '' }) {
  const lines = wrap(label, Math.floor(w / 5.1));
  const lineH = 10.5;
  // Centred as a block: with two lines and a sub-label the old fixed offsets
  // put the text through the bottom border.
  const top = y + (h - (lines.length * lineH + (sub ? 9 : 0))) / 2 + 8;
  const cx = x + w / 2;
  return (
    <g className={`dia-box ${tone}`}>
      <rect x={x} y={y} width={w} height={h} rx="7" />
      {lines.map((t, i) => (
        <text key={t} x={cx} y={top + i * lineH} className="dia-t">{t}</text>
      ))}
      {sub && <text x={cx} y={top + lines.length * lineH} className="dia-sub">{sub}</text>}
    </g>
  );
}

function Arrow({ x1, y1, x2, y2 }) {
  return <line className="dia-arrow" x1={x1} y1={y1} x2={x2} y2={y2} markerEnd="url(#dia-tip)" />;
}

/** One marker definition for every arrow on the page. */
export function DiagramDefs() {
  return (
    <svg width="0" height="0" aria-hidden="true" focusable="false" style={{ position: 'absolute' }}>
      <defs>
        <marker id="dia-tip" viewBox="0 0 8 8" refX="7" refY="4"
          markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path className="dia-tip" d="M0 0 L8 4 L0 8 z" />
        </marker>
      </defs>
    </svg>
  );
}

/* ---- the six shapes ------------------------------------------------------ */

/** Two options, one taken. The rejected one stays visible: it is the argument. */
function Choice({ a, b, pick = 'b', note }) {
  const boxes = [
    { x: 8, label: a, tone: pick === 'a' ? 'is-pick' : 'is-drop' },
    { x: 168, label: b, tone: pick === 'b' ? 'is-pick' : 'is-drop' },
  ];
  return (
    <>
      {boxes.map((box) => (
        <Box key={box.label} x={box.x} y={16} w={144} h={38} label={box.label} tone={box.tone} />
      ))}
      <text x={W / 2} y={72} className="dia-note">{note}</text>
      <text x={W / 2} y={12} className="dia-cap">
        {pick === 'a' ? '◀ taken' : 'taken ▶'}
      </text>
    </>
  );
}

/**
 * One thing, two consequences -- the shape of most of this project's seams.
 *
 * `neutral` when the two branches are merely DIFFERENT rather than better and
 * worse. The default tones say "this one, not that one", which is right for an
 * asymmetry the project has an opinion about (authorship is free under the
 * CRDT and hand-built under OT) and wrong for a question like "who breaks a
 * tie", where both answers are correct and only the mechanism differs.
 */
function Split({ from, left, right, leftSub, rightSub, neutral = false }) {
  return (
    <>
      <Box x={92} y={4} w={136} h={26} label={from} tone="is-src" />
      <Arrow x1={130} y1={32} x2={78} y2={46} />
      <Arrow x1={190} y1={32} x2={242} y2={46} />
      <Box x={4} y={48} w={148} h={38} label={left} sub={leftSub} tone={neutral ? 'is-plain' : 'is-pick'} />
      <Box x={168} y={48} w={148} h={38} label={right} sub={rightSub} tone={neutral ? 'is-plain' : 'is-alt'} />
    </>
  );
}

/** An interface, with what sits on each side of it. */
function Seam({ above, line, below = [] }) {
  const w = below.length ? (W - 16 - (below.length - 1) * 8) / below.length : 0;
  return (
    <>
      <Box x={8} y={2} w={W - 16} h={24} label={above} tone="is-plain" />
      <line className="dia-seam" x1="8" y1="40" x2={W - 8} y2="40" />
      <text x={W / 2} y={37} className="dia-cap dia-seam-t">{line}</text>
      {below.map((b, i) => (
        <Box key={b} x={8 + i * (w + 8)} y={52} w={w} h={34} label={b} tone="is-alt" />
      ))}
    </>
  );
}

/** Steps, in order. */
function Flow({ steps = [], accent = -1 }) {
  const gap = 10;
  const w = (W - 16 - gap * (steps.length - 1)) / steps.length;
  return (
    <>
      {steps.map((s, i) => (
        <React.Fragment key={s}>
          <Box
            x={8 + i * (w + gap)} y={28} w={w} h={36}
            label={s}
            tone={i === accent ? 'is-pick' : 'is-plain'}
          />
          {i < steps.length - 1 && (
            <Arrow
              x1={8 + i * (w + gap) + w + 1}
              y1={46}
              x2={8 + (i + 1) * (w + gap) - 1}
              y2={46}
            />
          )}
        </React.Fragment>
      ))}
    </>
  );
}

/** A log: a run of records, some of them marked. */
function Strip({ blocks = 9, marks = [], label, tail }) {
  const gap = 4;
  const w = (W - 16 - gap * (blocks - 1)) / blocks;
  return (
    <>
      <text x="8" y="18" className="dia-cap dia-left">{label}</text>
      {Array.from({ length: blocks }, (_, i) => (
        <rect
          key={i}
          className={`dia-rec${marks.includes(i) ? ' is-mark' : ''}`}
          x={8 + i * (w + gap)} y={28} width={w} height={30} rx="3"
        />
      ))}
      <text x={W / 2} y={78} className="dia-note">{tail}</text>
    </>
  );
}

/** A row of labelled boxes: the data model, as it is actually stored. */
function Cells({ cells = [], caption }) {
  const gap = 6;
  const w = (W - 16 - gap * (cells.length - 1)) / cells.length;
  return (
    <>
      {cells.map((c, i) => (
        <g key={`${c.v}-${i}`} className={`dia-box ${c.tone ?? 'is-plain'}`}>
          <rect x={8 + i * (w + gap)} y={20} width={w} height={34} rx="6" />
          <text x={8 + i * (w + gap) + w / 2} y={41} className="dia-mono">{c.v}</text>
          {c.label && (
            <text x={8 + i * (w + gap) + w / 2} y={68} className="dia-sub">{c.label}</text>
          )}
        </g>
      ))}
      {caption && <text x={W / 2} y={84} className="dia-note">{caption}</text>}
    </>
  );
}

const SHAPES = { choice: Choice, split: Split, seam: Seam, flow: Flow, strip: Strip, cells: Cells };

export function Diagram({ spec }) {
  if (!spec) return null;
  const Shape = SHAPES[spec.kind];
  if (!Shape) return null;
  const { kind, alt, ...props } = spec;
  return (
    <Frame title={alt}>
      <Shape {...props} />
    </Frame>
  );
}
