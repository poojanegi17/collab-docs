/**
 * Durable append-only update log + snapshots, on Postgres.
 *
 * The storage layer is ENGINE-AGNOSTIC: it stores opaque byte blobs. It has no
 * idea whether those bytes are Yjs updates or OT revisions. Do not import yjs
 * into this file.
 *
 * Model, and why:
 *   updates   append-only log. Writing is O(1) and never blocks on a merge,
 *             which is what lets us ack a keystroke immediately.
 *   snapshots one row per doc, the whole state as of `through_seq`.
 *
 * Loading a doc = newest snapshot + every update after it. Compaction folds
 * the loose updates back into the snapshot and deletes them. This is the same
 * shape as an LSM / write-ahead log, and the reason you want it is that the
 * naive alternative (rewrite the whole doc on every keystroke) is O(doc size)
 * per character.
 *
 * ---------------------------------------------------------------------------
 * TWO THINGS TO KNOW BEFORE EDITING ANY QUERY BELOW.
 *
 * THE PER-KEYSTROKE PATH. `appendUpdate` is a network round trip, and nothing
 * in this file hides that -- hiding it here would mean lying about durability.
 * It is dealt with one layer up, in ../realtime/update-buffer.js, which
 * batches appends without ever becoming the record of them. See that file for
 * the trade.
 *
 * COLUMN ALIASES ARE QUOTED. Postgres folds unquoted identifiers to lower
 * case, so `AS docId` yields a column called `docid` and every `r.docId` in
 * this file would silently read `undefined`. Every camelCase alias below is
 * therefore `AS "docId"`, and it is the single most likely thing to get wrong.
 */
import { Db, toBytes } from './db.js';
import { DOCS_DDL, ensureSchema } from './schema.js';

export class Store {
  /**
   * @param {{connectionString: string, schema: string, max?: number}} opts
   *
   * The constructor no longer opens anything. Creating the schema is a
   * network round trip and constructors cannot await, so it moved to `init`,
   * which the server calls before it listens.
   */
  constructor({ connectionString, schema, max, adminConnectionString, appRole } = {}) {
    this.db = new Db({ connectionString, schema, max });
    // Used only by init(), only to run DDL, and closed again immediately.
    // The runtime pool above authenticates as a role that cannot CREATE.
    this.adminConnectionString = adminConnectionString;
    this.appRole = appRole;
  }

  /** Idempotent. Every boot runs it; on an ephemeral host that is the point. */
  async init() {
    await ensureSchema(this.db, DOCS_DDL, {
      adminConnectionString: this.adminConnectionString,
      appRole: this.appRole,
    });
    return this;
  }

  /** @returns {Promise<number>} the seq it was written at */
  async appendUpdate(docId, bytes) {
    const row = await this.db.one(
      'INSERT INTO {updates} (doc_id, data, created) VALUES ($1, $2, $3) RETURNING seq',
      [docId, Buffer.from(bytes), Date.now()]);
    return Number(row.seq);
  }

  /**
   * Append many updates as ONE statement, preserving their order.
   *
   * This is what makes buffering worth doing (see
   * ../realtime/update-buffer.js): twenty keystrokes become one round trip
   * rather than twenty. The rows are flattened into a single multi-row INSERT
   * rather than looped, because a loop inside a transaction would still be
   * twenty round trips -- it would only make them atomic, which is not the
   * problem being solved.
   *
   * Order is preserved because Postgres assigns IDENTITY values in the order
   * the VALUES list is written, and the whole log depends on seq order.
   *
   * `created` is carried per row rather than taken as `Date.now()` here: these
   * updates were accepted at the moment the keystroke arrived, and stamping
   * them at flush time would attribute a burst of typing to the instant the
   * batch happened to drain.
   *
   * @param {{bytes: Uint8Array, created: number}[]} rows
   * @returns {Promise<number[]>} the seqs written, in order
   */
  async appendUpdates(docId, rows) {
    if (!rows.length) return [];
    const values = [];
    const params = [docId];
    for (const r of rows) {
      params.push(Buffer.from(r.bytes), r.created);
      values.push(`($1, $${params.length - 1}, $${params.length})`);
    }
    const out = await this.db.all(
      `INSERT INTO {updates} (doc_id, data, created) VALUES ${values.join(', ')} RETURNING seq`,
      params);
    return out.map((r) => Number(r.seq));
  }

  /**
   * Everything needed to reconstruct a document.
   * @returns {Promise<{ snapshot: Uint8Array|null, updates: Uint8Array[], throughSeq: number }>}
   */
  async load(docId) {
    const snap = await this.db.one(
      'SELECT data, through_seq FROM {snapshots} WHERE doc_id = $1', [docId]);
    const throughSeq = snap ? Number(snap.through_seq) : 0;
    const rows = await this.db.all(
      'SELECT seq, data FROM {updates} WHERE doc_id = $1 AND seq > $2 ORDER BY seq',
      [docId, throughSeq]);
    return {
      snapshot: snap ? toBytes(snap.data) : null,
      updates: rows.map((r) => toBytes(r.data)),
      throughSeq: rows.length ? Number(rows[rows.length - 1].seq) : throughSeq,
    };
  }

  /** How many loose updates are sitting on top of the snapshot. */
  async looseUpdateCount(docId) {
    const snap = await this.db.one(
      'SELECT through_seq FROM {snapshots} WHERE doc_id = $1', [docId]);
    const throughSeq = snap ? Number(snap.through_seq) : 0;
    const row = await this.db.one(
      'SELECT COUNT(*) AS n FROM {updates} WHERE doc_id = $1 AND seq > $2',
      [docId, throughSeq]);
    return Number(row.n);
  }

  async currentSeq(docId) {
    const row = await this.db.one(
      'SELECT COALESCE(MAX(seq), 0) AS seq FROM {updates} WHERE doc_id = $1', [docId]);
    return Number(row.seq);
  }

  /**
   * Replace the snapshot and drop the log entries it now subsumes.
   * Atomic: a crash mid-compaction must not lose updates.
   *
   * The four statements run on ONE pooled connection via `transaction`. With
   * a pool that is not automatic, and getting it wrong would strand an open
   * transaction on one connection while the deletes ran unwrapped on another.
   * See Db#transaction.
   */
  async compact(docId, snapshotBytes, throughSeq) {
    const now = Date.now();
    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO {snapshots} (doc_id, data, through_seq, created) VALUES ($1,$2,$3,$4)
         ON CONFLICT (doc_id) DO UPDATE SET data = excluded.data,
           through_seq = excluded.through_seq, created = excluded.created`,
        [docId, Buffer.from(snapshotBytes), throughSeq, now]);
      // Move, do not delete. The updates being folded in are the document's
      // history; the snapshot only replaces them for the purpose of LOADING.
      await tx.query(
        `INSERT INTO {archive} (seq, doc_id, data, created)
         SELECT seq, doc_id, data, created FROM {updates}
         WHERE doc_id = $1 AND seq <= $2
         ON CONFLICT (seq) DO NOTHING`,
        [docId, throughSeq]);
      await tx.query('DELETE FROM {updates} WHERE doc_id = $1 AND seq <= $2',
        [docId, throughSeq]);
      // Compaction has just produced the exact bytes a checkpoint needs, so
      // taking one here is free. Automatic checkpoints have no label.
      await tx.query(
        `INSERT INTO {checkpoints} (doc_id, seq, label, author_id, data, created)
         VALUES ($1,$2,NULL,NULL,$3,$4)`,
        [docId, throughSeq, Buffer.from(snapshotBytes), now]);
    });
    await this.pruneHistory(docId);
  }

  /**
   * The unbuffered counterpart of `BufferedStore.compactAtomically`.
   *
   * Nothing is queued in front of this store, so the seq is read first and
   * the snapshot taken immediately after it resolves -- with no `await` in
   * between, so no socket message can apply an update to the engine and land
   * between the two. The pair therefore describes one instant.
   *
   * @param {string} docId
   * @param {() => Uint8Array} makeSnapshot must be synchronous
   */
  async compactAtomically(docId, makeSnapshot) {
    const throughSeq = await this.currentSeq(docId);
    const snapshot = makeSnapshot();
    if (!throughSeq) return { compacted: false, throughSeq: 0 };
    await this.compact(docId, snapshot, throughSeq);
    return { compacted: true, throughSeq };
  }

  /**
   * Every document this store knows about, newest first.
   *
   * A document exists if it has a snapshot, loose updates, or both -- so this
   * is a union, not a read of one table, and Postgres requires the derived
   * table to be named, hence `AS both_logs`.
   */
  async listDocs(limit = 50) {
    const rows = await this.db.all(
      `SELECT doc_id AS "docId",
              MAX(updated) AS updated,
              SUM(bytes)   AS bytes
       FROM (
         SELECT doc_id, created AS updated, octet_length(data) AS bytes FROM {snapshots}
         UNION ALL
         SELECT doc_id, created AS updated, octet_length(data) AS bytes FROM {updates}
       ) AS both_logs
       GROUP BY doc_id
       ORDER BY updated DESC
       LIMIT $1`, [limit]);
    return rows.map((r) => ({
      docId: r.docId,
      updatedAt: Number(r.updated),
      bytes: Number(r.bytes ?? 0),
    }));
  }

  // ---- documents, ownership and sharing ------------------------------------

  /**
   * Roles, most powerful first. Order matters: `canEdit` and friends compare
   * by index, so adding a role means putting it in the right place here rather
   * than editing every check.
   */
  static ROLES = ['owner', 'editor', 'viewer'];

  async createDoc({ docId, title, ownerId }) {
    const now = Date.now();
    await this.db.query(
      `INSERT INTO {docs} (doc_id, title, owner_id, created, updated)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (doc_id) DO NOTHING`,
      [docId, title || 'Untitled', ownerId ?? null, now, now]);
    if (ownerId) await this.grant(docId, ownerId, 'owner');
    return this.getDoc(docId);
  }

  async getDoc(docId) {
    const row = await this.db.one('SELECT * FROM {docs} WHERE doc_id = $1', [docId]);
    return row ? shapeDoc(row) : null;
  }

  /**
   * Give an UNOWNED document an owner.
   *
   * This is the one transition that turns a document anyone can edit into a
   * document with an access list, and it exists because of how people actually
   * start: you write something first, and only later does it need to be shared
   * with a named person. Sharing is the moment ownership has to exist -- there
   * is nobody to grant access *from* until then -- so the product asks you to
   * sign in at exactly that moment and claim what you already wrote.
   *
   * The UPDATE is guarded by `owner_id IS NULL` in SQL rather than by a read
   * followed by a write. Two guests clicking Claim on the same document at the
   * same time is a race, and losing it must mean "somebody else owns this now",
   * not "you silently took it from them". A zero row count is that answer.
   *
   * @returns {Promise<{ok: true, doc: object}|{ok: false, error: string}>}
   */
  async claimDoc(docId, userId) {
    const doc = await this.getDoc(docId);
    if (!doc || doc.deletedAt) return { ok: false, error: 'no such document' };
    // Already yours: claiming twice is a no-op, not an error. The UI can
    // retry after a reconnect without having to know which it is.
    if (doc.ownerId === userId) return { ok: true, doc };
    if (doc.ownerId) return { ok: false, error: 'this document already has an owner' };

    const changed = await this.db.count(
      'UPDATE {docs} SET owner_id = $1, updated = $2 WHERE doc_id = $3 AND owner_id IS NULL',
      [userId, Date.now(), docId]);
    if (!changed) return { ok: false, error: 'this document already has an owner' };

    await this.grant(docId, userId, 'owner');
    return { ok: true, doc: await this.getDoc(docId) };
  }

  async renameDoc(docId, title) {
    await this.db.query('UPDATE {docs} SET title = $1, updated = $2 WHERE doc_id = $3',
      [String(title).slice(0, 200) || 'Untitled', Date.now(), docId]);
    return this.getDoc(docId);
  }

  /**
   * Soft delete. The update log stays, because throwing away a document's
   * history the instant somebody clicks a button is how you find out what
   * "undo" was worth -- and version history (see `archive`) depends on it.
   */
  async deleteDoc(docId) {
    await this.db.query('UPDATE {docs} SET deleted = $1 WHERE doc_id = $2',
      [Date.now(), docId]);
  }

  /**
   * Undo a soft delete.
   *
   * `updated` is deliberately bumped to now rather than left at whatever it
   * was before the delete. The documents page sorts by activity, and a
   * document restored this afternoon that sorts under last month's is one
   * nobody will find -- restoring it IS the activity.
   *
   * Note what is NOT restored: a tab deleted separately stays deleted
   * (ADR-014). Deleting a document hides the whole family at once, but the
   * two flags are independent, and resurrecting a tab somebody removed on
   * purpose would be a second, unasked-for undo.
   */
  async restoreDeletedDoc(docId) {
    await this.db.query('UPDATE {docs} SET deleted = NULL, updated = $1 WHERE doc_id = $2',
      [Date.now(), docId]);
    return this.getDoc(docId);
  }

  /**
   * The trash: documents this user owns that have been deleted.
   *
   * Owner only, and not via the ACL the way `listForUser` goes. An editor
   * someone shared a document with never had the right to delete it, so
   * showing it to them in a state they cannot have caused and cannot undo
   * would be reporting someone else's action as their own pending decision.
   *
   * Newest deletion first, because the thing you want back is almost always
   * the thing you just lost.
   */
  async listDeletedForUser(userId, limit = 50) {
    if (!userId) return [];
    const rows = await this.db.all(
      `SELECT * FROM {docs}
       WHERE owner_id = $1 AND deleted IS NOT NULL
       ORDER BY deleted DESC LIMIT $2`, [userId, limit]);
    return rows.map(shapeDoc);
  }

  // ---- search (ADR-017) -----------------------------------------------------

  /**
   * Refresh one log's row in the search index.
   *
   * One upsert, not a delete followed by an insert. `body_tsv` is a generated
   * column, so Postgres recomputes it from `body` as part of the same write --
   * which makes the upsert both correct and one network round trip instead of
   * two.
   *
   * `text` is whatever `DocEngine.readDocument().toString()` produced. This
   * method does not know, and must not know, which engine that was.
   */
  async indexDoc(docId, text) {
    const { docId: parentId, tabId } = Store.tabOf(docId);
    await this.db.query(
      `INSERT INTO {doc_search} (doc_id, parent_id, tab_id, body) VALUES ($1,$2,$3,$4)
       ON CONFLICT (doc_id) DO UPDATE SET
         parent_id = excluded.parent_id, tab_id = excluded.tab_id, body = excluded.body`,
      [docId, parentId, tabId ?? '', String(text ?? '')]);
  }

  async unindexDoc(docId) {
    await this.db.query('DELETE FROM {doc_search} WHERE doc_id = $1', [docId]);
  }

  /**
   * Turn what somebody typed into a `to_tsquery` expression.
   *
   * Bare input reaching `to_tsquery` means `&`, `|`, `!`, `<->`, `:`
   * and unbalanced parentheses are all operators or syntax errors -- so a
   * person searching for `C++ (draft)` gets a 500. Every token is therefore
   * split out on non-word characters and rejoined with an explicit `&`, which
   * turns the query language off entirely, and each gets `:*` so the last word
   * matches as a prefix while it is still being typed.
   *
   * Tokens are extracted rather than escaped. Escaping would mean reasoning
   * about `to_tsquery`'s quoting rules; a whitelist of letters, numbers and
   * underscore cannot express an operator in the first place.
   */
  static ftsQuery(raw) {
    const tokens = String(raw ?? '')
      .split(/[^\p{L}\p{N}_]+/u)
      .filter(Boolean)
      .slice(0, 16);
    if (!tokens.length) return null;
    return tokens.map((t) => `${t}:*`).join(' & ');
  }

  /**
   * Search the documents this user has a role on.
   *
   * Scoped to the ACL, and deliberately NOT to everything the documents page
   * lists. That page also shows the unowned pile -- the lab's scratch pads and
   * every document the test harnesses have ever left behind -- and searching
   * those would bury three real results under forty named `zz-probe-`. The
   * box says "your documents"; this is that set.
   *
   * Two match sources, merged:
   *
   *   title  read LIVE from `docs`, because that is where a title is
   *          authoritative and a rename is not an edit
   *   body   from the projection, which lags by at most one debounce window
   *
   * A hit on both is one result that says so, not two rows.
   */
  async searchDocs(userId, raw, limit = 25) {
    if (!userId) return [];
    // An empty query is not a query. Without this the title arm below builds
    // LIKE '%%', which matches every row -- so a search box cleared with
    // backspace would answer with the entire account rather than nothing.
    const trimmed = String(raw ?? '').trim();
    if (!trimmed) return [];
    // '#' as the LIKE escape, not the conventional backslash: this string is
    // built in a template literal and read back inside another one, and a
    // backslash that survives both is a backslash written four ways. '#' needs
    // no escaping at any layer, and LIKE does not care which character it is.
    const like = `%${trimmed.replace(/[#%_]/g, '#$&')}%`;
    const hits = new Map();

    const add = (row, where, snippet = null) => {
      const existing = hits.get(row.docId);
      if (existing) {
        existing.matchedIn = [...new Set([...existing.matchedIn, where])];
        if (snippet && !existing.snippet) existing.snippet = snippet;
        return;
      }
      hits.set(row.docId, { ...row, matchedIn: [where], snippet });
    };

    for (const r of await this.db.all(
      `SELECT d.doc_id AS "docId", d.title, d.updated, a.role
       FROM {docs} d JOIN {acl} a ON a.doc_id = d.doc_id
       WHERE a.user_id = $1 AND d.deleted IS NULL AND d.title ILIKE $2 ESCAPE '#'
       ORDER BY d.updated DESC LIMIT $3`, [userId, like, limit])) {
      add({ docId: r.docId, title: r.title, updatedAt: Number(r.updated), role: r.role,
        tabId: null }, 'title');
    }

    // U+0002/U+0003 (START OF TEXT / END OF TEXT) delimit the matched run in
    // the snippet, written as chr(2)/chr(3) so no control byte has to live in
    // this source file. Deliberately NOT '<b>': a snippet is a fragment of
    // somebody's document, and wrapping it in markup means the client either
    // renders the document's own angle brackets as HTML or strips them from
    // the excerpt. Two characters that cannot occur in a document -- the
    // attribute sanitisers reject C0 controls -- carry the range instead, and
    // the client turns them into elements itself.
    //
    // `ts_headline` takes its delimiters as a settings STRING rather than as
    // arguments, so they are concatenated in rather than bound. They are
    // chr(2)/chr(3) from Postgres itself, not user input.
    const match = Store.ftsQuery(raw);
    if (match) {
      for (const r of await this.db.all(
        `SELECT s.parent_id AS "docId", s.tab_id AS "tabId", d.title, d.updated, a.role,
                ts_headline('simple', s.body, q,
                  'StartSel=' || chr(2) || ',StopSel=' || chr(3) ||
                  ',MaxWords=12,MinWords=4,MaxFragments=1,FragmentDelimiter=...'
                ) AS snippet,
                ts_rank(s.body_tsv, q) AS rank
         FROM {doc_search} s
         JOIN {docs} d ON d.doc_id = s.parent_id
         JOIN {acl}  a ON a.doc_id = s.parent_id
         -- A tab deleted on its own (ADR-014) keeps its content log, and so
         -- keeps its index row. Without this join its text stays findable
         -- after it has stopped being anywhere you can open.
         LEFT JOIN {tabs} t ON t.tab_id = s.doc_id
         CROSS JOIN LATERAL to_tsquery('simple', $2) AS q
         WHERE a.user_id = $1 AND d.deleted IS NULL AND t.deleted IS NULL
           AND s.body_tsv @@ q
         ORDER BY rank DESC LIMIT $3`, [userId, match, limit])) {
        add({ docId: r.docId, title: r.title, updatedAt: Number(r.updated), role: r.role,
          tabId: r.tabId || null }, 'body', r.snippet);
      }
    }

    return [...hits.values()].slice(0, limit);
  }

  /**
   * Bump `updated` so the document list sorts by real activity.
   *
   * Typing in a tab is activity on the DOCUMENT. Without the redirect the
   * listing would sort by when the first tab was last touched, so a document
   * somebody has been writing in all afternoon -- in tab two -- sinks to the
   * bottom as though it were abandoned.
   */
  async touchDoc(docId) {
    const parentId = Store.tabOf(docId).docId;
    const now = Date.now();
    await this.db.query('UPDATE {docs} SET updated = $1 WHERE doc_id = $2', [now, parentId]);
    if (parentId !== docId) {
      await this.db.query('UPDATE {tabs} SET updated = $1 WHERE tab_id = $2', [now, docId]);
    }
  }

  async grant(docId, userId, role) {
    if (!Store.ROLES.includes(role)) throw new Error(`unknown role: ${role}`);
    await this.db.query(
      `INSERT INTO {acl} (doc_id, user_id, role, granted) VALUES ($1,$2,$3,$4)
       ON CONFLICT (doc_id, user_id) DO UPDATE SET role = excluded.role`,
      [docId, userId, role, Date.now()]);
  }

  async revoke(docId, userId) {
    await this.db.query(
      'DELETE FROM {acl} WHERE doc_id = $1 AND user_id = $2 AND role <> $3',
      [docId, userId, 'owner']);
  }

  /**
   * What `userId` may do with `docId`.
   *
   * Three outcomes that are easy to conflate and must not be:
   *
   *   null       no such document, or it is deleted -- nobody has any role
   *   'editor'   the document is UNOWNED, so it is open to whoever asks
   *   a role     an explicit grant
   *
   * The middle case is the guest-document and lab affordance described on the
   * docs table (ADR-010). A deployment that wants none of it sets
   * `requireOwner`, and then an unowned document is simply inaccessible.
   */
  async roleFor(docId, userId, { requireOwner = false } = {}) {
    // A tab inherits its document's access, always. There is no per-tab ACL
    // and there deliberately is not one: sharing a document and then having to
    // share each of its tabs is a permission model that will be got wrong, and
    // the failure mode is a collaborator who can read four tabs and not the
    // fifth for no reason they can see.
    //
    // Derived from the id rather than looked up, so this stays one lookup on a
    // path that runs per frame. `tabOf` explains why that is safe.
    const parentId = Store.tabOf(docId).docId;
    const doc = await this.getDoc(parentId);
    if (!doc || doc.deletedAt) return null;
    if (!doc.ownerId) return requireOwner ? null : 'editor';
    if (!userId) return null;
    const row = await this.db.one(
      'SELECT role FROM {acl} WHERE doc_id = $1 AND user_id = $2', [parentId, userId]);
    return row?.role ?? null;
  }

  async collaborators(docId) {
    const rows = await this.db.all(
      'SELECT user_id AS "userId", role, granted FROM {acl} WHERE doc_id = $1 ORDER BY granted',
      [docId]);
    return rows.map((r) => ({ ...r, granted: Number(r.granted) }));
  }

  /** Every live document this user can open, newest activity first. */
  async listForUser(userId, limit = 100) {
    const rows = await this.db.all(
      `SELECT d.*, a.role
       FROM {docs} d JOIN {acl} a ON a.doc_id = d.doc_id
       WHERE a.user_id = $1 AND d.deleted IS NULL
       ORDER BY d.updated DESC LIMIT $2`, [userId, limit]);
    return rows.map((r) => ({ ...shapeDoc(r), role: r.role }));
  }

  /**
   * How much text each document actually holds, keyed by document id.
   *
   * Read from the search projection, which is the only place the storage layer
   * can learn this: the update log beside it is engine-specific opaque bytes,
   * and "is there anything written in here" is not a question those bytes can
   * answer (ADR-017). Summed over the family, because a document's text is the
   * text of all its tabs (ADR-014).
   *
   * The obvious cheaper signal does not work. A document's logged BYTES are
   * not zero just because it is empty -- merely opening one in an editor
   * persists ~57 bytes of engine state before anybody has typed a character,
   * so byte count answers "has this ever been connected to", which is a
   * different question and not the one being asked.
   *
   * Trimmed, so a document holding nothing but whitespace counts as empty.
   *
   * `GROUP_CONCAT` became `string_agg`. Neither promises an order across a
   * multi-tab document, so the preview may begin at any of its tabs -- which
   * is acceptable for a thumbnail and would not be for anything that had to
   * round-trip.
   */
  async textSummaries({ preview = 180 } = {}) {
    const rows = await this.db.all(
      `SELECT parent_id AS "docId",
              SUM(length(trim(body))) AS chars,
              substr(trim(string_agg(body, ' ')), 1, $1) AS preview
       FROM {doc_search} GROUP BY parent_id`, [preview]);
    return new Map(rows.map((r) => [r.docId, {
      chars: Number(r.chars) || 0,
      preview: r.preview ?? '',
    }]));
  }

  /**
   * Remove a document and everything hanging off it. Not a soft delete.
   *
   * `deleteDoc` is the one people use: it sets a tombstone, keeps the log, and
   * is undone from the Trash. This is the other thing entirely, and it exists
   * for exactly one case -- an unowned document that was never named and never
   * written in, abandoned by the only person who could reach it. There is
   * nothing to put in a trash nobody can open, and no owner to open it.
   *
   * Every table keyed on the document goes, including the ones that should be
   * empty for a document in this state. "Should be empty" is an assumption,
   * and leaving orphaned rows behind on the strength of one is how a database
   * accumulates things nobody can account for.
   *
   * One transaction, and no per-statement error swallowing. Every table here
   * is created by `init` on the same boot, so a failure is a real one and
   * must not be discarded.
   */
  async purgeDoc(docId) {
    const tabIds = (await this.tabsFor(docId)).map((t) => t.docId);
    const family = [...new Set([docId, ...tabIds])];

    await this.db.transaction(async (tx) => {
      for (const id of family) {
        await tx.query('DELETE FROM {updates} WHERE doc_id = $1', [id]);
        await tx.query('DELETE FROM {snapshots} WHERE doc_id = $1', [id]);
        await tx.query('DELETE FROM {doc_search} WHERE doc_id = $1', [id]);
        await tx.query('DELETE FROM {checkpoints} WHERE doc_id = $1', [id]);
        await tx.query('DELETE FROM {archive} WHERE doc_id = $1', [id]);
        await tx.query(
          'DELETE FROM {comments} WHERE thread_id IN '
          + '(SELECT id FROM {comment_threads} WHERE doc_id = $1)', [id]);
        await tx.query('DELETE FROM {comment_threads} WHERE doc_id = $1', [id]);
        await tx.query('DELETE FROM {tasks} WHERE doc_id = $1', [id]);
      }
      await tx.query('DELETE FROM {tabs} WHERE doc_id = $1', [docId]);
      await tx.query('DELETE FROM {acl} WHERE doc_id = $1', [docId]);
      await tx.query('DELETE FROM {docs} WHERE doc_id = $1', [docId]);
    });
  }

  /**
   * Documents with content but NO index row.
   *
   * A document in this state is left alone by `purgeEmptyUnowned`: it may
   * predate the projection, or have failed to index; either way "we have not
   * looked" is not the same as "there is nothing there", and guessing wrong
   * loses somebody's writing. This finds them so the caller -- which, unlike
   * this layer, is allowed to know what an engine is -- can read them first.
   */
  async unindexedUnowned() {
    const rows = await this.db.all(
      `SELECT d.doc_id AS "docId" FROM {docs} d
       WHERE d.owner_id IS NULL AND d.deleted IS NULL
         AND NOT EXISTS (SELECT 1 FROM {doc_search} s WHERE s.doc_id = d.doc_id)`);
    return rows.map((r) => r.docId);
  }

  /**
   * Remove unowned documents that have nothing in them. Returns how many.
   *
   * Run once at boot, to clear what accumulated before rooms started doing
   * this on their way out. Those documents are never revisited -- nobody
   * opens them, so no room is ever built for them, so nothing would ever
   * notice they are empty.
   *
   * TWO GUARDS, BECAUSE ONE OF THEM HAS A HOLE. Both exist because this no
   * longer runs before the port is open (ADR-022): a guest connecting in the
   * first second creates an unowned document with no updates and no snapshot,
   * which is character-for-character the second branch of the query below.
   *
   * `isBusy` is the obvious guard -- "is there an open room for this
   * document" -- and it is NOT SUFFICIENT ON ITS OWN. The transport creates
   * the `docs` row when a socket connects and registers the room several
   * awaits later, so between those two moments a live document is invisible to
   * the registry. That window is small, real, and was found by
   * tools/comments-test.mjs failing intermittently on whichever engine
   * happened to lose the race.
   *
   * `minAgeMs` closes it, and is the guard that actually matches the intent.
   * This sweep is for rubbish that ACCUMULATED -- documents from before rooms
   * cleaned up after themselves, which "nobody will ever open again". A
   * document created four seconds ago is not that, whatever the registry says.
   * Refusing to judge anything recent makes the outcome independent of how
   * fast a connection happens to be admitted, which is the only version of
   * this that is not a race.
   *
   * Deliberately conservative about what "empty" means, because this deletes
   * without a trash to fall back on. Only two states qualify: indexed and
   * found to hold no text, which is a positive answer rather than an absence
   * of one; or never written at all, with no updates and no snapshot.
   *
   * Documents with tabs are skipped outright: the text of a tab lives under
   * the tab's own log id, and a parent that looks empty may be a document
   * whose writing is all in tab two (ADR-014).
   */
  async purgeEmptyUnowned(isBusy = () => false, minAgeMs = 60_000) {
    const rows = await this.db.all(
      `SELECT d.doc_id AS "docId" FROM {docs} d
       WHERE d.owner_id IS NULL AND d.deleted IS NULL
         AND d.created < $1
         AND NOT EXISTS (SELECT 1 FROM {tabs} t WHERE t.doc_id = d.doc_id)
         AND (
           (EXISTS (SELECT 1 FROM {doc_search} s WHERE s.parent_id = d.doc_id)
            AND COALESCE((SELECT SUM(length(trim(s.body)))
                          FROM {doc_search} s WHERE s.parent_id = d.doc_id), 0) = 0)
           OR
           (NOT EXISTS (SELECT 1 FROM {updates} u WHERE u.doc_id = d.doc_id)
            AND NOT EXISTS (SELECT 1 FROM {snapshots} p WHERE p.doc_id = d.doc_id))
         )`, [Date.now() - minAgeMs]);
    let purged = 0;
    for (const r of rows) {
      if (isBusy(r.docId)) continue;
      await this.purgeDoc(r.docId);
      purged++;
    }
    return purged;
  }

  /** Unowned documents -- the lab's scratch pads and the harnesses' leavings. */
  async listUnowned(limit = 50) {
    const rows = await this.db.all(
      `SELECT * FROM {docs} WHERE owner_id IS NULL AND deleted IS NULL
       ORDER BY updated DESC LIMIT $1`, [limit]);
    return rows.map(shapeDoc);
  }

  /**
   * Give a `docs` row to anything that has content but no metadata.
   *
   * Runs once at boot. Anything with a log but no `docs` row is found by the
   * same aggregate `listDocs` uses and adopted as unowned, so a document can
   * never become unreachable by being absent from the metadata table.
   */
  async backfillDocs() {
    const known = new Set(
      (await this.db.all('SELECT doc_id FROM {docs}')).map((r) => r.doc_id));
    let added = 0;
    for (const d of await this.listDocs(1000)) {
      if (known.has(d.docId)) continue;
      // A tab's content log is not a document to be adopted. It has bytes and
      // no `docs` row by design (ADR-014), which is exactly the shape this
      // backfill looks for -- so without this line every tab would surface on
      // the documents page as its own untitled, unowned document.
      if (Store.tabOf(d.docId).tabId) continue;
      await this.db.query(
        'INSERT INTO {docs} (doc_id, title, owner_id, created, updated) '
        + 'VALUES ($1,$2,NULL,$3,$4) ON CONFLICT (doc_id) DO NOTHING',
        [d.docId, d.docId, d.updatedAt, d.updatedAt]);
      added++;
    }
    return added;
  }

  // ---- version history -----------------------------------------------------

  /**
   * The full ordered log for a document: archived updates followed by loose
   * ones. Concatenating them is valid precisely because compaction preserves
   * the original seq numbers.
   */
  async fullLog(docId, fromSeq = 0, toSeq = Number.MAX_SAFE_INTEGER) {
    const rows = await this.db.all(
      `SELECT seq, data, created FROM (
         SELECT seq, doc_id, data, created FROM {archive}
         UNION ALL
         SELECT seq, doc_id, data, created FROM {updates}
       ) AS whole_log
       WHERE doc_id = $1 AND seq > $2 AND seq <= $3 ORDER BY seq`,
      [docId, fromSeq, toSeq]);
    return rows.map((r) => ({
      seq: Number(r.seq),
      data: toBytes(r.data),
      createdAt: Number(r.created),
    }));
  }

  /**
   * Everything an engine needs to rebuild the document AS IT WAS at `seq`.
   *
   * Same shape as `load()` -- deliberately, so `DocEngine.restore` serves both
   * "open this document" and "show me last Tuesday" without knowing which it
   * is doing. The nearest checkpoint at or before `seq` provides the base, and
   * only the updates after it are replayed, so this is bounded by the
   * compaction interval rather than by the document's whole history.
   */
  async stateAt(docId, seq) {
    const cp = await this.db.one(
      'SELECT seq, data FROM {checkpoints} WHERE doc_id = $1 AND seq <= $2 '
      + 'ORDER BY seq DESC LIMIT 1', [docId, seq]);
    const base = cp ? Number(cp.seq) : 0;
    return {
      snapshot: cp ? toBytes(cp.data) : null,
      updates: (await this.fullLog(docId, base, seq)).map((u) => u.data),
      throughSeq: seq,
    };
  }

  /** A named version. `data` is the materialised state, supplied by the engine. */
  async createCheckpoint(docId, { seq, label, authorId, data }) {
    const row = await this.db.one(
      'INSERT INTO {checkpoints} (doc_id, seq, label, author_id, data, created) '
      + 'VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [docId, seq, label ?? null, authorId ?? null, Buffer.from(data), Date.now()]);
    return Number(row.id);
  }

  /**
   * The version list. Named checkpoints always appear; automatic ones are
   * included so there is something to scrub through on a document nobody
   * thought to name a version of.
   */
  async listCheckpoints(docId, limit = 100) {
    const rows = await this.db.all(
      'SELECT id, seq, label, author_id AS "authorId", created, '
      + 'octet_length(data) AS bytes '
      + 'FROM {checkpoints} WHERE doc_id = $1 ORDER BY seq DESC LIMIT $2', [docId, limit]);
    return rows.map((r) => ({
      id: Number(r.id),
      seq: Number(r.seq),
      label: r.label ?? null,
      authorId: r.authorId ?? null,
      createdAt: Number(r.created),
      bytes: Number(r.bytes),
      automatic: r.label === null,
    }));
  }

  /** Edit activity, for a timeline that shows when a document was worked on. */
  async activity(docId, limit = 400) {
    return (await this.fullLog(docId)).slice(-limit)
      .map((u) => ({ seq: u.seq, at: u.createdAt }));
  }

  /**
   * Retention. Unbounded history is a decision too, and not one to make by
   * omission -- a busy document would grow its archive forever.
   *
   * Named checkpoints are never pruned. Automatic ones and archived updates
   * age out together, so a pruned window leaves neither a base to rebuild from
   * nor updates to replay, rather than a checkpoint that silently cannot be
   * reached.
   */
  async pruneHistory(docId, { keepDays = 30, keepUpdates = 20000 } = {}) {
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
    await this.db.query('DELETE FROM {archive} WHERE doc_id = $1 AND created < $2',
      [docId, cutoff]);
    await this.db.query(
      'DELETE FROM {checkpoints} WHERE doc_id = $1 AND label IS NULL AND created < $2',
      [docId, cutoff]);

    const row = await this.db.one(
      'SELECT COUNT(*) AS n FROM {archive} WHERE doc_id = $1', [docId]);
    const count = Number(row.n);
    if (count > keepUpdates) {
      const boundary = await this.db.one(
        'SELECT seq FROM {archive} WHERE doc_id = $1 ORDER BY seq DESC LIMIT 1 OFFSET $2',
        [docId, keepUpdates]);
      if (boundary) {
        await this.db.query('DELETE FROM {archive} WHERE doc_id = $1 AND seq <= $2',
          [docId, boundary.seq]);
        await this.db.query(
          'DELETE FROM {checkpoints} WHERE doc_id = $1 AND label IS NULL AND seq <= $2',
          [docId, boundary.seq]);
      }
    }
  }

  // ---- comments -----------------------------------------------------------
  //
  // Bodies are ordinary rows. `anchor` is the only interesting column, and the
  // store deliberately treats it as an opaque string -- resolving it is the
  // engine's job, and the whole point of ADR-012 is that the two engines do it
  // differently.

  /**
   * Open a thread on a range. `anchor` is whatever the engine minted.
   * @returns {Promise<object>} the thread, with its first comment attached
   */
  async createThread({ docId, anchor, quote, body, author }) {
    const now = Date.now();
    const threadId = 'th_' + randomId();
    // A thread with no comment in it is not a thing a user can make -- opening
    // one and writing the first note is a single action, so the two inserts
    // are one transaction rather than two writes that can half-fail. Over a
    // pool that has to be asked for explicitly.
    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO {comment_threads}
           (id, doc_id, anchor, quote, resolved, orphaned,
            author_id, author_name, author_color, created, updated)
         VALUES ($1,$2,$3,$4,0,0,$5,$6,$7,$8,$9)`,
        [threadId, docId, JSON.stringify(anchor), quote,
          author.id ?? null, author.name, author.color ?? null, now, now]);
      await tx.query(
        `INSERT INTO {comments}
           (id, thread_id, body, author_id, author_name, author_color, created)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        ['cm_' + randomId(), threadId, body,
          author.id ?? null, author.name, author.color ?? null, now]);
    });
    return this.getThread(threadId);
  }

  async addComment({ threadId, body, author }) {
    const thread = await this.db.one(
      'SELECT id FROM {comment_threads} WHERE id = $1', [threadId]);
    if (!thread) return null;
    const now = Date.now();
    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO {comments}
           (id, thread_id, body, author_id, author_name, author_color, created)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        ['cm_' + randomId(), threadId, body,
          author.id ?? null, author.name, author.color ?? null, now]);
      // Replying re-opens: someone had more to say, so the thread is not done.
      await tx.query('UPDATE {comment_threads} SET resolved = 0, updated = $1 WHERE id = $2',
        [now, threadId]);
    });
    return this.getThread(threadId);
  }

  async getThread(threadId) {
    const row = await this.db.one(
      'SELECT * FROM {comment_threads} WHERE id = $1', [threadId]);
    if (!row) return null;
    const comments = await this.db.all(
      'SELECT * FROM {comments} WHERE thread_id = $1 ORDER BY created', [threadId]);
    return shapeThread(row, comments.map(shapeComment));
  }

  /**
   * Every thread on a document, with its comments, oldest first.
   *
   * Two queries rather than one per thread: a document with fifty comments
   * should not cost fifty round trips to render a sidebar. That was worth
   * doing against a local file and it is worth considerably more now that a
   * round trip crosses a network.
   */
  async listThreads(docId) {
    const byThread = new Map();
    for (const c of await this.db.all(
      `SELECT c.* FROM {comments} c
       JOIN {comment_threads} t ON t.id = c.thread_id
       WHERE t.doc_id = $1 ORDER BY c.created`, [docId])) {
      if (!byThread.has(c.thread_id)) byThread.set(c.thread_id, []);
      byThread.get(c.thread_id).push(shapeComment(c));
    }
    const threads = await this.db.all(
      'SELECT * FROM {comment_threads} WHERE doc_id = $1 ORDER BY created', [docId]);
    return threads.map((t) => shapeThread(t, byThread.get(t.id) ?? []));
  }

  /**
   * Replace a thread's anchor. Under OT this is the server writing down the
   * result of transforming the anchor through a newly sequenced operation --
   * the authoritative answer nobody else is allowed to compute (ADR-012).
   */
  async setAnchor(threadId, anchor) {
    await this.db.query(
      'UPDATE {comment_threads} SET anchor = $1, updated = $2 WHERE id = $3',
      [JSON.stringify(anchor), Date.now(), threadId]);
  }

  /** The commented text is gone. Not the same as somebody resolving it. */
  async orphanThread(threadId, orphaned = true) {
    await this.db.query(
      'UPDATE {comment_threads} SET orphaned = $1, updated = $2 WHERE id = $3',
      [orphaned ? 1 : 0, Date.now(), threadId]);
  }

  async resolveThread(threadId, resolved = true) {
    await this.db.query(
      'UPDATE {comment_threads} SET resolved = $1, updated = $2 WHERE id = $3',
      [resolved ? 1 : 0, Date.now(), threadId]);
    return this.getThread(threadId);
  }

  async deleteThread(threadId) {
    // No ON DELETE CASCADE: the schema is created by CREATE TABLE IF NOT
    // EXISTS across versions, and a foreign key added later would not apply to
    // databases that already exist. Two statements always work.
    await this.db.transaction(async (tx) => {
      await tx.query('DELETE FROM {comments} WHERE thread_id = $1', [threadId]);
      await tx.query('DELETE FROM {comment_threads} WHERE id = $1', [threadId]);
    });
  }

  /**
   * Delete one comment; if it was the last in its thread, the thread goes too.
   * A thread with nothing in it would render as an anchor highlighting some
   * text for no stated reason.
   */
  async deleteComment(commentId) {
    const row = await this.db.one(
      'SELECT id, thread_id FROM {comments} WHERE id = $1', [commentId]);
    if (!row) return null;
    await this.db.query('DELETE FROM {comments} WHERE id = $1', [commentId]);
    const left = await this.db.one(
      'SELECT COUNT(*) AS n FROM {comments} WHERE thread_id = $1', [row.thread_id]);
    if (Number(left?.n ?? 0) === 0) {
      await this.deleteThread(row.thread_id);
      return { threadId: row.thread_id, threadDeleted: true };
    }
    return { threadId: row.thread_id, threadDeleted: false };
  }

  // ---- tabs ---------------------------------------------------------------
  //
  // ADR-014. A tab is a document: `tab_id` IS a doc_id, and everything that
  // already works per document -- the update log, snapshots, compaction,
  // version history, comments and their anchors -- works per tab for free,
  // because none of it is being asked to do anything new.

  /**
   * Split a doc id into the document it belongs to and, if it is a tab, which
   * tab it is.
   *
   * Structural rather than a table lookup, and that is a deliberate trade.
   * `slugId` emits `[a-z0-9-]` only, so `~` cannot occur in a document id by
   * accident, and a tab id is therefore self-describing: `notes-a1b2c3d4~7fq2e1`
   * belongs to `notes-a1b2c3d4` and nothing else can be read out of it.
   *
   * The reason it matters is `roleFor`, which runs on every frame and every
   * request. Access is INHERITED, so the answer for a tab is the answer for
   * its document -- and a forged tab id can therefore only ever reach the
   * permissions its own document already grants. Whether the tab EXISTS is a
   * different question, asked where it matters: the socket refuses to open a
   * room for a tab id with no row (see server.js).
   *
   * Stays synchronous, and that matters more than it did: it is pure string
   * arithmetic on a per-frame path, and making it a lookup would have put a
   * network round trip inside `roleFor`.
   */
  static tabOf(id) {
    const at = String(id).indexOf('~');
    if (at <= 0) return { docId: String(id), tabId: null };
    return { docId: String(id).slice(0, at), tabId: String(id) };
  }

  /** Is this id a tab's content rather than a document's? */
  static isTabId(id) {
    return Store.tabOf(id).tabId !== null;
  }

  /**
   * The tabs of a document, in order.
   *
   * Empty means "this document has never been split", NOT "this document has
   * no content" -- its one tab's content is stored under the document's own
   * id. Callers that want a list to render should use `tabsFor`, which makes
   * that implicit tab explicit.
   */
  async listTabs(docId) {
    const rows = await this.db.all(
      `SELECT * FROM {tabs} WHERE doc_id = $1 AND deleted IS NULL
       ORDER BY position, created`, [docId]);
    return rows.map(shapeTab);
  }

  /**
   * What the UI should draw: always at least one tab.
   *
   * The synthetic row is marked `implicit` so a caller can tell that nothing
   * has been written down about it yet. It is otherwise an ordinary tab --
   * its content really is at that id, and it really is the one you are editing
   * when you open a document that has never been split.
   */
  async tabsFor(docId) {
    const rows = await this.listTabs(docId);
    if (rows.length) return rows;
    return [{
      tabId: docId,
      docId,
      // Not the document's title. The index sits directly under the header
      // that already shows that title, and a tab repeating it reads as a bug
      // -- two controls, same words, one of them renameable. "Tab 1" is what
      // it is: the first of however many there turn out to be.
      title: 'Tab 1',
      position: 0,
      implicit: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }];
  }

  async getTab(tabId) {
    const row = await this.db.one('SELECT * FROM {tabs} WHERE tab_id = $1', [tabId]);
    return row ? shapeTab(row) : null;
  }

  /**
   * Write down the first tab, if it has not been written down yet.
   *
   * Called before adding a second one. It points at the document's own id,
   * because that is where the content of the first tab already is -- the
   * alternative, moving that content under a fresh tab id, would mean the act
   * of adding a tab rewrites an update log, invalidates every checkpoint
   * against it, and orphans every comment anchor in the document. Naming what
   * already exists costs one row.
   */
  async ensureFirstTab(docId) {
    const existing = await this.listTabs(docId);
    if (existing.length) return existing[0];
    const doc = await this.getDoc(docId);
    const now = Date.now();
    // Named to match what `tabsFor` has been calling it all along, so writing
    // it down does not silently rename the tab somebody was looking at.
    await this.db.query(
      `INSERT INTO {tabs} (tab_id, doc_id, title, position, created, updated)
       VALUES ($1,$2,$3,0,$4,$5) ON CONFLICT (tab_id) DO NOTHING`,
      [docId, docId, 'Tab 1', doc?.createdAt ?? now, now]);
    return this.getTab(docId);
  }

  async createTab(docId, title) {
    await this.ensureFirstTab(docId);
    const now = Date.now();
    const tabId = `${docId}~${randomId().slice(0, 6)}`;
    const row = await this.db.one(
      'SELECT COALESCE(MAX(position), -1) + 1 AS n FROM {tabs} WHERE doc_id = $1', [docId]);
    await this.db.query(
      `INSERT INTO {tabs} (tab_id, doc_id, title, position, created, updated)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [tabId, docId, String(title ?? '').slice(0, 120) || 'Untitled tab',
        Number(row.n), now, now]);
    await this.touchDoc(docId);
    return this.getTab(tabId);
  }

  async renameTab(tabId, title) {
    await this.db.query('UPDATE {tabs} SET title = $1, updated = $2 WHERE tab_id = $3',
      [String(title ?? '').slice(0, 120) || 'Untitled tab', Date.now(), tabId]);
    return this.getTab(tabId);
  }

  /**
   * Delete a tab, unless it is the last one.
   *
   * A document with zero tabs is not a state this system has: the editor would
   * have nothing to open, and the content of the deleted tab -- which is still
   * there -- would be unreachable. Refusing is a better answer than inventing
   * an empty tab to replace it.
   */
  async deleteTab(tabId) {
    const tab = await this.getTab(tabId);
    if (!tab) return { ok: false, error: 'no such tab' };
    const siblings = await this.listTabs(tab.docId);
    if (siblings.length <= 1) return { ok: false, error: 'a document needs at least one tab' };
    const now = Date.now();
    await this.db.query('UPDATE {tabs} SET deleted = $1, updated = $2 WHERE tab_id = $3',
      [now, now, tabId]);
    await this.touchDoc(tab.docId);
    return { ok: true, tab: { ...tab, deletedAt: now } };
  }

  /**
   * Move a tab to an absolute index in its document.
   *
   * Positions are rewritten densely for the whole document rather than
   * fractionally for the moved tab. The list is short and the write is one
   * transaction, and dense integers mean two people reordering concurrently
   * end up with SOME order both of them see, instead of a fraction that
   * converges towards a rounding error.
   */
  async moveTab(tabId, index) {
    const tab = await this.getTab(tabId);
    if (!tab) return { ok: false, error: 'no such tab' };
    const order = (await this.listTabs(tab.docId)).filter((t) => t.tabId !== tabId);
    const at = Math.max(0, Math.min(order.length, Number(index) || 0));
    order.splice(at, 0, tab);
    const now = Date.now();
    await this.db.transaction(async (tx) => {
      for (const [i, t] of order.entries()) {
        await tx.query('UPDATE {tabs} SET position = $1, updated = $2 WHERE tab_id = $3',
          [i, now, t.tabId]);
      }
    });
    return { ok: true, tabs: await this.listTabs(tab.docId) };
  }

  // ---- tasks --------------------------------------------------------------
  //
  // ADR-015. Deliberately the dullest data in the project: rows with a
  // boolean. The interesting decision is what is NOT here -- no anchor, no
  // engine involvement, no CRDT -- and the ADR argues why a checklist is one
  // of the few collaborative features that is better off without any of it.

  async listTasks(docId) {
    const rows = await this.db.all(
      'SELECT * FROM {tasks} WHERE doc_id = $1 ORDER BY position, created', [docId]);
    return rows.map(shapeTask);
  }

  async getTask(id) {
    const row = await this.db.one('SELECT * FROM {tasks} WHERE id = $1', [id]);
    return row ? shapeTask(row) : null;
  }

  async createTask({ docId, body, author }) {
    const now = Date.now();
    const id = 'tk_' + randomId();
    const row = await this.db.one(
      'SELECT COALESCE(MAX(position), -1) + 1 AS n FROM {tasks} WHERE doc_id = $1', [docId]);
    await this.db.query(
      `INSERT INTO {tasks}
         (id, doc_id, body, done, author_id, author_name, author_color,
          position, created, updated)
       VALUES ($1,$2,$3,0,$4,$5,$6,$7,$8,$9)`,
      [id, docId, body, author.id ?? null, author.name, author.color ?? null,
        Number(row.n), now, now]);
    return this.getTask(id);
  }

  /**
   * Tick or untick a task, recording who did it.
   *
   * Last writer wins, and for this one field that is the right answer rather
   * than a compromise. Two people ticking the same task concurrently agree
   * about the outcome -- the work is done -- and disagree only about whose
   * name is against it, which is a question the document cannot answer and
   * neither can a merge algorithm. What must never happen is the tick being
   * LOST, and a single UPDATE cannot lose it.
   */
  async setTaskDone(id, done, by) {
    const now = Date.now();
    await this.db.query(
      `UPDATE {tasks} SET done = $1, done_by_id = $2, done_by_name = $3,
                          done_at = $4, updated = $5
       WHERE id = $6`,
      [done ? 1 : 0,
        done ? (by?.id ?? null) : null,
        done ? (by?.name ?? null) : null,
        done ? now : null,
        now, id]);
    return this.getTask(id);
  }

  async editTask(id, body) {
    await this.db.query('UPDATE {tasks} SET body = $1, updated = $2 WHERE id = $3',
      [body, Date.now(), id]);
    return this.getTask(id);
  }

  async deleteTask(id) {
    return (await this.db.count('DELETE FROM {tasks} WHERE id = $1', [id])) > 0;
  }

  async close() {
    await this.db.close();
  }
}

function randomId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function shapeThread(row, comments) {
  return {
    id: row.id,
    docId: row.doc_id,
    // Parsed on the way out so callers deal in objects and never in the fact
    // that this column happens to be text.
    anchor: JSON.parse(row.anchor),
    quote: row.quote,
    resolved: !!row.resolved,
    orphaned: !!row.orphaned,
    author: { id: row.author_id, name: row.author_name, color: row.author_color },
    created: Number(row.created),
    updated: Number(row.updated),
    comments,
  };
}

function shapeComment(row) {
  return {
    id: row.id,
    threadId: row.thread_id,
    body: row.body,
    author: { id: row.author_id, name: row.author_name, color: row.author_color },
    created: Number(row.created),
  };
}

function shapeTab(row) {
  return {
    // The id of the tab AND of the document its content lives in. One value
    // because they are one thing (ADR-014); two fields would invite code that
    // keeps them apart and then has to decide which is authoritative.
    tabId: row.tab_id,
    docId: row.doc_id,
    title: row.title,
    position: Number(row.position),
    implicit: false,
    createdAt: Number(row.created),
    updatedAt: Number(row.updated),
    deletedAt: row.deleted ? Number(row.deleted) : null,
  };
}

function shapeTask(row) {
  return {
    id: row.id,
    docId: row.doc_id,
    body: row.body,
    done: !!row.done,
    // Null unless done. Kept as a nested object so the client renders it the
    // same way it renders a comment author, rather than growing a second
    // convention for "a person" three components later.
    doneBy: row.done ? { id: row.done_by_id, name: row.done_by_name } : null,
    doneAt: row.done_at ? Number(row.done_at) : null,
    author: { id: row.author_id, name: row.author_name, color: row.author_color },
    position: Number(row.position),
    createdAt: Number(row.created),
    updatedAt: Number(row.updated),
  };
}

function shapeDoc(row) {
  return {
    docId: row.doc_id,
    title: row.title,
    ownerId: row.owner_id ?? null,
    createdAt: Number(row.created),
    updatedAt: Number(row.updated),
    deletedAt: row.deleted ? Number(row.deleted) : null,
  };
}
