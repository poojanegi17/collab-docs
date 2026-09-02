/**
 * Each decision in a sentence or two, and the shape it takes.
 *
 * A reader who wants to know what was decided should not have to read an essay
 * to find out, so the card carries a brief and a picture and the record sits
 * one click behind it -- itself kept short, since the same argument applies
 * once it is open.
 *
 * The briefs are written from each ADR itself rather than summarised from
 * memory, and deliberately say WHAT was chosen and WHAT it cost -- a summary
 * that only records the choice is a headline, and the cost is the part that
 * makes it a decision rather than a preference.
 *
 * Plain words only, here and in the diagram labels: no identifiers, no file
 * names, no routes. A reader who has to decode a symbol to read a summary is
 * reading the code, which is the thing the summary exists to save them.
 *
 * `diagram` is a spec, not a drawing: see Diagram.jsx for the six shapes and
 * why there are only six.
 *
 */
export const BRIEFS = {
  '001': {
    brief: 'Taken because a CRDT server relays bytes it never has to understand, where OT needs a referee that parses every edit.',
    diagram: {
      kind: 'choice',
      a: 'OT — server referees',
      b: 'CRDT — merge by id',
      pick: 'b',
      note: 'the server relays bytes it never inspects',
      alt: 'Two options: OT, where the server referees every edit, and CRDT, where edits merge by character id. The CRDT was taken.',
    },
  },
  '002': {
    brief: 'One interface on each side, so everything above it is written once and cannot tell which engine is underneath.',
    diagram: {
      kind: 'seam',
      above: 'editor · formatting · cursors · comments · storage · API',
      line: 'one engine interface',
      below: ['CRDT', 'OT'],
      alt: 'A seam: the editor, formatting, cursors, comments, storage and API sit above one interface; the CRDT and OT engines sit below it.',
    },
  },
  '003': {
    brief: 'Every change is added to the end and never rewritten, with a snapshot now and then so reopening stays quick.',
    diagram: {
      kind: 'strip',
      blocks: 11,
      marks: [0, 6],
      label: 'changes, only ever appended',
      tail: 'a snapshot now and then, so reopening never replays everything',
      alt: 'A run of changes with a snapshot marked every so often, so reopening a document never replays everything.',
    },
  },
  '004': {
    brief: 'An edit is a walk across the whole document, because edits described by position cannot be combined.',
    diagram: {
      kind: 'cells',
      cells: [
        { v: 'skip 2', label: 'leave alone' },
        { v: 'add “y”', label: 'insert', tone: 'is-pick' },
        { v: 'cut 3', label: 'delete', tone: 'is-alt' },
        { v: 'skip 6', label: 'leave alone' },
      ],
      caption: 'one edit covers the whole document, so two of them combine into one',
      alt: 'An edit drawn as a walk across the document: leave two characters, add one, delete three, leave six.',
    },
  },
  '005': {
    brief: 'The lab hands the sync layer a fake connection, so delay, loss and a cut cable are simulated with no engine code knowing.',
    diagram: {
      kind: 'seam',
      above: 'the sync layer — unchanged, and unaware',
      line: 'the connection',
      below: ['a real one', 'a simulated one'],
      alt: 'The sync layer sits above the connection; below it, either a real connection or a simulated one.',
    },
  },
  '006': {
    brief: 'Formatting rides on an ordinary edit, so bold is an edit like any other.',
    diagram: {
      kind: 'split',
      from: 'formatting as an edit',
      left: 'CRDT',
      leftSub: 'it lives on the character',
      right: 'OT',
      rightSub: 'every merge has to carry it',
      alt: 'Formatting as an edit splits into two costs: nearly free under the CRDT, extra merging work under OT.',
    },
  },
  '007': {
    brief: 'People are stored in one place both engines share; a document has one owner and a role for everyone else.',
    diagram: {
      kind: 'seam',
      above: 'people — one place, both servers',
      line: 'role on a document',
      below: ['owner', 'editor', 'viewer'],
      alt: 'People are stored once for both servers; below, the three roles somebody can hold on a document: owner, editor, viewer.',
    },
  },
  '008': {
    brief: 'Old changes are archived rather than deleted, so any past moment can still be rebuilt.',
    diagram: {
      kind: 'strip',
      blocks: 11,
      marks: [3, 8],
      label: 'the archive and the live history join back up',
      tail: 'restoring adds to the end; it never rewrites what happened',
      alt: 'The archive and the live history join into one, with named checkpoints along it; restoring adds a new edit at the end.',
    },
  },
  '009': {
    brief: 'Every document on the site is a CRDT, because choosing a concurrency algorithm is not a decision a writer can evaluate.',
    diagram: {
      kind: 'split',
      from: 'two working engines',
      left: 'the product',
      leftSub: 'CRDT only',
      right: 'the lab',
      rightSub: 'both, side by side',
      alt: 'Two working engines: the product uses the CRDT only, while the lab runs both side by side.',
    },
  },
  '010': {
    brief: 'Creating and editing need no account — the document is simply unowned; sharing with a named person is what needs one.',
    diagram: {
      kind: 'flow',
      steps: ['open a link', 'write', 'sign in', 'claim it'],
      accent: 3,
      alt: 'A guest opens a link, writes, and can later sign in and claim the document as their own.',
    },
  },
  '011': {
    brief: 'Three kinds of formatting: simple on-or-off marks, values typed by a collaborator, and whole-line ones.',
    diagram: {
      kind: 'cells',
      cells: [
        { v: 'bold', label: 'on or off' },
        { v: 'colour', label: 'a value', tone: 'is-alt' },
        { v: 'heading', label: 'a whole line' },
      ],
      caption: 'only the middle kind is written by a person, so only it is checked before it is drawn',
      alt: 'Three kinds of formatting: on-or-off marks, values a collaborator types and the page must check, and whole-line ones.',
    },
  },
  '012': {
    brief: 'A comment points at a character rather than a position, which the CRDT gives free and OT has to keep moving.',
    diagram: {
      kind: 'split',
      from: 'where a comment points',
      left: 'CRDT',
      leftSub: 'at a character — nothing to update',
      right: 'OT',
      rightSub: 'the server moves every anchor',
      alt: 'A comment points at a character under the CRDT, and at a position the server keeps moving under OT.',
    },
  },
  '013': {
    brief: 'An image is one character and a table is a run of lines, so there is no tree for anything to have to understand.',
    diagram: {
      kind: 'cells',
      cells: [
        { v: 'a', label: 'text' },
        { v: '￼', label: 'an image', tone: 'is-pick' },
        { v: 'b', label: 'text' },
        { v: '␟', label: 'next cell', tone: 'is-alt' },
      ],
      caption: 'images and tables are characters, so merging and history need nothing new',
      alt: 'An image is a single character in the text, and the boundary between two table cells is another one.',
    },
  },
  '014': {
    brief: 'A tab is a whole document of its own, so it syncs, restores and shares exactly like any other.',
    diagram: {
      kind: 'cells',
      cells: [
        { v: 'the document', label: 'title · sharing · tasks' },
        { v: 'a tab', label: 'text · history · comments', tone: 'is-pick' },
      ],
      caption: 'a tab carries its own text; the document carries who may read it',
      alt: 'A tab holds its own text, history and comments, while the document around it holds the title, the sharing and the task list.',
    },
  },
  '015': {
    brief: 'The task list is a list of rows, not text — about the document without being part of it.',
    diagram: {
      kind: 'split',
      from: 'one document',
      left: 'the text',
      leftSub: 'merged live, character by character',
      right: 'tasks & comments',
      rightSub: 'rows, saved one at a time',
      alt: 'A document splits into its text, which merges live, and its tasks and comments, which are rows saved one at a time.',
    },
  },
  '016': {
    brief: 'Changes going out are held for a fiftieth of a second and merged into one, which only the CRDT allows.',
    diagram: {
      kind: 'flow',
      steps: ['keystrokes', 'a 50ms wait', 'one merged change', 'the room'],
      accent: 2,
      alt: 'Keystrokes are held for fifty milliseconds, merged into one change, and sent once to the whole room.',
    },
  },
  '017': {
    brief: 'Search reads a plain-text copy kept beside each document, so neither engine has to help with it.',
    diagram: {
      kind: 'flow',
      steps: ['the document', 'its plain text', 'an index', 'search'],
      accent: 2,
      alt: 'Search reads a plain-text copy taken from each document and indexed beside it, rather than the document itself.',
    },
  },
  '018': {
    brief: 'Who wrote each character is free under the CRDT and hand-built under OT, and that difference is the finding.',
    diagram: {
      kind: 'split',
      from: 'who wrote this?',
      left: 'CRDT',
      leftSub: 'the characters already know',
      right: 'OT',
      rightSub: 'a second record, kept by hand',
      alt: 'Under the CRDT the characters already carry who wrote them; under OT it is a second record maintained by hand.',
    },
  },
  '019': {
    brief: 'The host wipes its disk on every deploy, so the database holds the record and everything in front of it may be lost.',
    diagram: {
      kind: 'seam',
      above: 'cursors · fan-out · open rooms · the write buffer',
      line: 'may be lost',
      below: ['the database — the record'],
      alt: 'Cursors, fan-out, the list of open rooms and the write buffer sit above a line marked "may be lost"; the database sits below it as the record.',
    },
  },
  '020': {
    brief: 'Google proves who you are; this server decides what you may do, exactly as it does for a password sign-in.',
    diagram: {
      kind: 'flow',
      steps: ['sign in with Google', 'checked here', 'an ordinary session', 'ownership · roles'],
      accent: 1,
      alt: 'Signing in with Google is checked by this server and exchanged for an ordinary session, which then drives ownership and roles like any other sign-in.',
    },
  },
  '021': {
    brief: 'A picked document is converted once and lands as an ordinary one, with no link back and no second system arbitrating it.',
    diagram: {
      kind: 'flow',
      steps: ['pick from Drive', 'export once', 'convert', 'a document here'],
      accent: 2,
      alt: 'A document picked from Google Drive is exported once and converted into an ordinary document here, with no link back to the original.',
    },
  },
  '022': {
    brief: 'The wait was measured to the machine, not the database, so the housekeeping moved to after the site starts answering.',
    diagram: {
      kind: 'split',
      from: 'the first visit after a quiet hour',
      left: 'the database wakes',
      leftSub: 'a few hundred milliseconds',
      right: 'the machine wakes',
      rightSub: 'tens of seconds — the real cost',
      alt: 'The wait on a first visit splits in two: the database waking in a few hundred milliseconds, and the sleeping machine waking in tens of seconds, which dominates.',
    },
  },
  '023': {
    brief: 'Requests are counted and limited before they reach anything; Redis is optional and only buys counters that survive a restart.',
    diagram: {
      kind: 'seam',
      above: 'signed-in sessions · request counters',
      line: 'one cache',
      below: ['kept in memory', 'kept in Redis'],
      alt: 'One cache holds signed-in sessions and request counters, kept either in memory or in Redis — interchangeably.',
    },
  },
};
