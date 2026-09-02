import React, { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_INDENT } from '@collab/ot';
import {
  adjustIndent, applyLine, clearFormatting, copyFormatting, currentAttributes,
  pasteFormatting, setInline, setLink, toggleInline,
  insertImage, insertTable, addTableRow,
} from './format-commands.js';
import {
  FONTS, SIZES, TEXT_COLORS, HIGHLIGHT_COLORS, SPACINGS, safeIndent,
} from './attribute-values.js';

/**
 * Formatting controls.
 *
 * Every button ends up in the same place: `sync.format(from, to, attributes)`.
 * The toolbar does not know which engine is mounted, and neither engine gets a
 * special case here -- that is the seam paying off in the one place a user can
 * actually see it. The commands themselves live in format-commands.js so the
 * keyboard shortcuts run exactly the same code.
 *
 * Laid out in the groups and the order a word processor uses, because that
 * arrangement is the thing people already know and there is nothing to gain
 * from arranging familiar controls unfamiliarly.
 *
 * WHAT IS NOT HERE, and why -- these are not oversights, they are a different
 * KIND of change:
 *
 *   drawings, equations, charts
 *     Not formatting, and not text either. An attribute describes a range of
 *     characters that already exists, and the two block things that ARE here
 *     -- images and tables -- get in as characters that stand for a block, so
 *     both engines' transforms carry on being defined over character offsets
 *     (ADR-013). A drawing surface is a document of its own with its own
 *     concurrency question: a real piece of design, not a button.
 *
 *   page setup, margins, headers/footers, manual page breaks
 *     The pages are a rendering. `pagination.js` measures where the text runs
 *     off a sheet and draws the break there, over one continuous document.
 *     Page SETUP is the other direction -- geometry a person chooses, stored
 *     on the document and seen by everyone reading it -- which is a change to
 *     the document model rather than to this row of buttons.
 *
 *   suggestion mode
 *     An edit that is proposed rather than applied is a second document state
 *     beside the real one, and each engine would have to answer what happens
 *     when two people suggest into the same range. Comments are the part of
 *     that question this project does answer (ADR-012), and the Comment button
 *     at the end of this toolbar is where it surfaces.
 *
 *   zoom, spellcheck
 *     View-level, not document-level. The browser already spellchecks the
 *     content; zoom would be a local CSS scale that no collaborator sees, and
 *     a control that looks shared but is not is worse than its absence.
 */

const FLAG_BUTTONS = [
  { attr: 'bold', label: 'B', title: 'Bold  (Ctrl+B)', style: { fontWeight: 700 } },
  { attr: 'italic', label: 'I', title: 'Italic  (Ctrl+I)', style: { fontStyle: 'italic' } },
  { attr: 'underline', label: 'U', title: 'Underline  (Ctrl+U)', style: { textDecoration: 'underline' } },
  { attr: 'strike', label: 'S', title: 'Strikethrough  (Ctrl+Shift+X)', style: { textDecoration: 'line-through' } },
  { attr: 'code', label: '</>', title: 'Inline code  (Ctrl+E)', style: { fontFamily: 'var(--mono)' } },
];

const SCRIPT_BUTTONS = [
  { attr: 'sup', label: 'x²', title: 'Superscript' },
  { attr: 'sub', label: 'x₂', title: 'Subscript' },
];

/**
 * Paragraph style as a dropdown rather than one button per heading.
 *
 * Headings are mutually exclusive -- a line is H1 or H2, never both -- and a
 * row of toggles models them as independent when they are not: pressing H2 on
 * an H1 line leaves two buttons lit and the reader guessing which one won.
 */
const STYLES = [
  { value: '', label: 'Normal text' },
  { value: '1', label: 'Heading 1' },
  { value: '2', label: 'Heading 2' },
  { value: '3', label: 'Heading 3' },
];

const ALIGN_BUTTONS = [
  { value: null, title: 'Align left  (Ctrl+Shift+L)', lines: [10, 7, 10, 6] },
  { value: 'center', title: 'Center  (Ctrl+Shift+E)', lines: [10, 7, 10, 7] },
  { value: 'right', title: 'Align right  (Ctrl+Shift+R)', lines: [10, 7, 10, 6] },
  { value: 'justify', title: 'Justify  (Ctrl+Shift+J)', lines: [10, 10, 10, 10] },
];

/** The alignment glyph, drawn rather than fetched -- no icon dependency. */
function AlignIcon({ kind, lines }) {
  const offset = (w) => (kind === 'center' ? (10 - w) / 2 : kind === 'right' ? 10 - w : 0);
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      {lines.map((w, i) => (
        <rect key={i} x={2 + offset(w)} y={2.5 + i * 2.6} width={w} height="1.2" rx="0.6" fill="currentColor" />
      ))}
    </svg>
  );
}

/**
 * A panel hanging off a toolbar button.
 *
 * Closes on an outside click and on Escape. Both matter: this sits above a
 * text editor, and a colour grid that stays open while you type is a panel
 * covering the words you are trying to format.
 */
function Popover({ open, onClose, children, label }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
    const esc = (e) => { if (e.key === 'Escape') onClose(); };
    // `mousedown`, not `click`: the editor takes focus back on mouseup, and a
    // click listener fires after that -- closing the panel a frame after the
    // selection it was about to format has already been collapsed.
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fmt-popover" ref={ref} role="dialog" aria-label={label}
      onMouseDown={(e) => e.stopPropagation()}>
      {children}
    </div>
  );
}

function Swatches({ colors, onPick, onClear, clearLabel }) {
  return (
    <>
      <div className="swatch-grid">
        {colors.map((c) => (
          <button
            key={c}
            className="swatch"
            style={{ background: c }}
            title={c}
            aria-label={c}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(c)}
          />
        ))}
      </div>
      <button className="link-btn" onMouseDown={(e) => e.preventDefault()} onClick={onClear}>
        {clearLabel}
      </button>
    </>
  );
}

export function Toolbar({ sync, viewRef, version, linkRequestRef, onComment }) {
  const view = viewRef.current;
  // `version` is bumped by the editor on every selection or document change;
  // it exists only to make this component re-read the caret's formatting.
  void version;
  const active = view ? currentAttributes(view) : {};
  // Re-read per render for the same reason `active` is: the selection lives in
  // CodeMirror, and `version` is what tells React it moved.
  const hasSelection = !!view && !view.state.selection.main.empty;

  const [panel, setPanel] = useState(null);       // 'color' | 'highlight' | 'link' | null
  const [linkDraft, setLinkDraft] = useState('');
  const [imageDraft, setImageDraft] = useState('');
  const [tableSize, setTableSize] = useState({ rows: 3, columns: 3 });
  const [brush, setBrush] = useState(null);        // captured formatting, or null
  const closePanel = useCallback(() => setPanel(null), []);

  // Undo is the sync layer's, not CodeMirror's -- undoing a change that
  // arrived from a peer is not undo. The CRDT client owns a Y.UndoManager; the
  // OT client has no equivalent yet, so the buttons are absent there rather
  // than present and dead.
  const undoable = typeof sync.undo === 'function' && sync.canUndo !== false;

  const openLink = useCallback(() => {
    setLinkDraft(typeof active.link === 'string' ? active.link : '');
    setPanel('link');
  }, [active.link]);

  // Ctrl+K is bound in the editor's keymap, which has no way to open a panel
  // that lives here. The ref is the handshake: the editor calls whatever is in
  // it, and this component keeps it pointed at the current handler.
  useEffect(() => {
    if (!linkRequestRef) return undefined;
    linkRequestRef.current = openLink;
    return () => { linkRequestRef.current = null; };
  }, [linkRequestRef, openLink]);

  const run = (fn) => () => { fn(viewRef.current); closePanel(); };
  const noBlur = (e) => e.preventDefault();   // keep the selection alive

  const indent = safeIndent(active.indent, MAX_INDENT);

  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting">
      {/* ---- history and the brush ---- */}
      {undoable && (
        <>
          <button className="fmt-btn fmt-btn-glyph" title="Undo  (Ctrl+Z)" onMouseDown={noBlur}
            onClick={() => { sync.undo(); viewRef.current?.focus(); }}>&#8630;</button>
          <button className="fmt-btn fmt-btn-glyph" title="Redo  (Ctrl+Y)" onMouseDown={noBlur}
            onClick={() => { sync.redo(); viewRef.current?.focus(); }}>&#8631;</button>
        </>
      )}

      <button className="fmt-btn fmt-btn-glyph" title="Print" onMouseDown={noBlur}
        onClick={() => window.print()}>&#9113;</button>

      {/* Two clicks, like every other paint-format control: the first captures
          what is under the caret, the second applies it to a new selection. */}
      <button
        className={`fmt-btn fmt-btn-glyph${brush ? ' fmt-btn-on' : ''}`}
        title={brush ? 'Apply the copied formatting to the selection' : 'Copy formatting from the caret'}
        aria-pressed={!!brush}
        onMouseDown={noBlur}
        onClick={() => {
          if (brush) { pasteFormatting(sync, viewRef.current, brush); setBrush(null); }
          else setBrush(copyFormatting(viewRef.current));
        }}
      >&#9986;</button>

      <span className="toolbar-sep" />

      {/* ---- paragraph style, font, size ---- */}
      <select
        className="fmt-select" aria-label="Paragraph style" title="Paragraph style"
        value={String(active.header ?? '')}
        onChange={(e) => {
          const next = e.target.value;
          // `toggle: false` because a dropdown states an absolute choice.
          // Toggling would make picking Heading 2 while already on Heading 2 a
          // no-op that clears it -- a select that undoes its own selection.
          applyLine(sync, viewRef.current, 'header', next ? Number(next) : null, { toggle: false });
        }}
      >
        {STYLES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
      </select>

      <select
        className="fmt-select" aria-label="Font" title="Font"
        value={typeof active.font === 'string' ? active.font : ''}
        onChange={(e) => setInline(sync, viewRef.current, 'font', e.target.value || null)}
      >
        <option value="">Default</option>
        {Object.entries(FONTS).map(([key, f]) => (
          <option key={key} value={key} style={{ fontFamily: f.css }}>{f.label}</option>
        ))}
      </select>

      <select
        className="fmt-select fmt-select-narrow" aria-label="Font size" title="Font size"
        value={String(active.size ?? '')}
        onChange={(e) => setInline(sync, viewRef.current, 'size',
          e.target.value ? Number(e.target.value) : null)}
      >
        <option value="">--</option>
        {SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>

      <span className="toolbar-sep" />

      {/* ---- character marks ---- */}
      {FLAG_BUTTONS.map((b) => (
        <button
          key={b.attr}
          className={`fmt-btn${active[b.attr] ? ' fmt-btn-on' : ''}`}
          style={b.style}
          title={b.title}
          aria-pressed={!!active[b.attr]}
          onMouseDown={noBlur}
          onClick={() => toggleInline(sync, viewRef.current, b.attr)}
        >
          {b.label}
        </button>
      ))}

      {/* ---- colour ---- */}
      <span className="fmt-anchor">
        <button
          className={`fmt-btn fmt-btn-color${active.color ? ' fmt-btn-on' : ''}`}
          title="Text colour" aria-haspopup="dialog" aria-expanded={panel === 'color'}
          onMouseDown={noBlur}
          onClick={() => setPanel((p) => (p === 'color' ? null : 'color'))}
        >
          A
          <span className="fmt-color-bar"
            style={{ background: typeof active.color === 'string' ? active.color : 'currentColor' }} />
        </button>
        <Popover open={panel === 'color'} onClose={closePanel} label="Text colour">
          <Swatches
            colors={TEXT_COLORS}
            clearLabel="Default colour"
            onPick={(c) => run((v) => setInline(sync, v, 'color', c))()}
            onClear={run((v) => setInline(sync, v, 'color', null))}
          />
        </Popover>
      </span>

      <span className="fmt-anchor">
        <button
          className={`fmt-btn fmt-btn-color${active.highlight ? ' fmt-btn-on' : ''}`}
          title="Highlight" aria-haspopup="dialog" aria-expanded={panel === 'highlight'}
          onMouseDown={noBlur}
          onClick={() => setPanel((p) => (p === 'highlight' ? null : 'highlight'))}
        >
          &#9639;
          <span className="fmt-color-bar"
            style={{ background: typeof active.highlight === 'string' ? active.highlight : '#fef08a' }} />
        </button>
        <Popover open={panel === 'highlight'} onClose={closePanel} label="Highlight colour">
          <Swatches
            colors={HIGHLIGHT_COLORS}
            clearLabel="No highlight"
            onPick={(c) => run((v) => setInline(sync, v, 'highlight', c))()}
            onClear={run((v) => setInline(sync, v, 'highlight', null))}
          />
        </Popover>
      </span>

      {/* ---- link ---- */}
      <span className="fmt-anchor">
        <button
          className={`fmt-btn${active.link ? ' fmt-btn-on' : ''}`}
          title="Insert link  (Ctrl+K)" aria-haspopup="dialog" aria-expanded={panel === 'link'}
          onMouseDown={noBlur}
          onClick={() => (panel === 'link' ? closePanel() : openLink())}
        >&#128279;</button>
        <Popover open={panel === 'link'} onClose={closePanel} label="Link">
          <form
            className="link-form"
            onSubmit={(e) => {
              e.preventDefault();
              setLink(sync, viewRef.current, linkDraft);
              closePanel();
            }}
          >
            <input
              type="text" placeholder="example.com" autoFocus value={linkDraft}
              onChange={(e) => setLinkDraft(e.target.value)}
            />
            <div className="link-form-actions">
              <button type="submit" className="primary-btn">Apply</button>
              <button type="button" className="link-btn"
                onMouseDown={noBlur}
                onClick={run((v) => setInline(sync, v, 'link', null))}>Remove</button>
            </div>
            <p className="fmt-hint">Ctrl-click a link in the document to open it.</p>
          </form>
        </Popover>
      </span>

      {/* ---- image ---- */}
      <span className="fmt-anchor">
        <button
          className="fmt-btn"
          title="Insert image" aria-haspopup="dialog" aria-expanded={panel === 'image'}
          onMouseDown={noBlur}
          onClick={() => setPanel(panel === 'image' ? null : 'image')}
        >&#128247;</button>
        <Popover open={panel === 'image'} onClose={closePanel} label="Image">
          <form
            className="link-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (insertImage(sync, viewRef.current, imageDraft)) {
                setImageDraft('');
                closePanel();
              }
            }}
          >
            <input
              type="text" placeholder="https://example.com/photo.jpg" autoFocus
              value={imageDraft}
              onChange={(e) => setImageDraft(e.target.value)}
            />
            <div className="link-form-actions">
              <button type="submit" className="primary-btn">Insert</button>
            </div>
            {/* Said up front rather than after a failed paste. Refusing data:
                URIs is about the update log, not about safety -- see ADR-013. */}
            <p className="fmt-hint">
              A web address, http or https. Pasted image data is not accepted:
              it would be stored in the document&rsquo;s history forever.
            </p>
          </form>
        </Popover>
      </span>

      {/* ---- table ---- */}
      <span className="fmt-anchor">
        <button
          className={`fmt-btn${active.table ? ' fmt-btn-on' : ''}`}
          title="Insert table" aria-haspopup="dialog" aria-expanded={panel === 'table'}
          onMouseDown={noBlur}
          onClick={() => setPanel(panel === 'table' ? null : 'table')}
        >&#9638;</button>
        <Popover open={panel === 'table'} onClose={closePanel} label="Table">
          <form
            className="link-form table-form"
            onSubmit={(e) => {
              e.preventDefault();
              insertTable(sync, viewRef.current, tableSize.rows, tableSize.columns);
              closePanel();
            }}
          >
            <div className="table-size">
              <label>
                Rows
                <input
                  type="number" min="1" max="20" value={tableSize.rows}
                  onChange={(e) => setTableSize((v) => ({ ...v, rows: Number(e.target.value) }))}
                />
              </label>
              <label>
                Columns
                <input
                  type="number" min="1" max="10" value={tableSize.columns}
                  onChange={(e) => setTableSize((v) => ({ ...v, columns: Number(e.target.value) }))}
                />
              </label>
            </div>
            <div className="link-form-actions">
              <button type="submit" className="primary-btn">Insert</button>
              {/* Only offered inside a table, because outside one it would do
                  nothing and a button that does nothing is a bug report. */}
              {active.table && (
                <button
                  type="button" className="link-btn"
                  onMouseDown={noBlur}
                  onClick={() => { addTableRow(sync, viewRef.current); closePanel(); }}
                >Add row below</button>
              )}
            </div>
          </form>
        </Popover>
      </span>

      {SCRIPT_BUTTONS.map((b) => (
        <button
          key={b.attr}
          className={`fmt-btn${active[b.attr] ? ' fmt-btn-on' : ''}`}
          title={b.title}
          aria-pressed={!!active[b.attr]}
          onMouseDown={noBlur}
          onClick={() => toggleInline(sync, viewRef.current, b.attr)}
        >
          {b.label}
        </button>
      ))}

      <span className="toolbar-sep" />

      {/* ---- paragraph shape ---- */}
      {ALIGN_BUTTONS.map((b) => (
        <button
          key={b.value ?? 'left'}
          className={`fmt-btn${(active.align ?? null) === b.value ? ' fmt-btn-on' : ''}`}
          title={b.title}
          aria-pressed={(active.align ?? null) === b.value}
          onMouseDown={noBlur}
          onClick={() => applyLine(sync, viewRef.current, 'align', b.value, { toggle: false })}
        >
          <AlignIcon kind={b.value ?? 'left'} lines={b.lines} />
        </button>
      ))}

      <select
        className="fmt-select fmt-select-narrow" aria-label="Line spacing" title="Line spacing"
        value={String(active.spacing ?? '')}
        onChange={(e) => applyLine(sync, viewRef.current, 'spacing', e.target.value || null,
          { toggle: false })}
      >
        {SPACINGS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
      </select>

      <button
        className={`fmt-btn fmt-btn-glyph${active.list === 'bullet' || active.bullet ? ' fmt-btn-on' : ''}`}
        title="Bulleted list  (Ctrl+Shift+8)"
        aria-pressed={active.list === 'bullet' || !!active.bullet}
        onMouseDown={noBlur}
        onClick={() => applyLine(sync, viewRef.current, 'list', 'bullet')}
      >&bull;</button>

      <button
        className={`fmt-btn fmt-btn-glyph${active.list === 'number' ? ' fmt-btn-on' : ''}`}
        title="Numbered list  (Ctrl+Shift+7)"
        aria-pressed={active.list === 'number'}
        onMouseDown={noBlur}
        onClick={() => applyLine(sync, viewRef.current, 'list', 'number')}
      >1.</button>

      <button
        className={`fmt-btn fmt-btn-glyph${active.quote ? ' fmt-btn-on' : ''}`}
        title="Blockquote  (Ctrl+Shift+9)"
        aria-pressed={!!active.quote}
        onMouseDown={noBlur}
        onClick={() => applyLine(sync, viewRef.current, 'quote', true)}
      >&rdquo;</button>

      <button className="fmt-btn fmt-btn-glyph" title="Decrease indent  (Ctrl+[)" disabled={indent === 0}
        onMouseDown={noBlur} onClick={() => adjustIndent(sync, viewRef.current, -1)}>&#8676;</button>
      <button className="fmt-btn fmt-btn-glyph" title="Increase indent  (Ctrl+])" disabled={indent >= MAX_INDENT}
        onMouseDown={noBlur} onClick={() => adjustIndent(sync, viewRef.current, +1)}>&#8677;</button>

      <span className="toolbar-sep" />

      <button
        className="fmt-btn fmt-btn-wide"
        title="Remove all formatting from the selection  (Ctrl+\)"
        onMouseDown={noBlur}
        onClick={() => clearFormatting(sync, viewRef.current)}
      >
        Clear
      </button>

      {onComment && (
        <>
          <span className="toolbar-sep" />
          {/*
            Disabled on an empty selection rather than hidden. A comment needs
            text to be about: a zero-width anchor has nothing to survive, so
            the next keystroke that touched it would orphan it (ADR-012).
          */}
          <button
            className="fmt-btn fmt-btn-wide"
            title="Comment on the selection  (Ctrl+Alt+M)"
            disabled={!hasSelection}
            onMouseDown={noBlur}
            onClick={onComment}
          >
            Comment
          </button>
        </>
      )}
    </div>
  );
}
