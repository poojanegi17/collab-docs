# ADR-007: Accounts, ownership and per-document roles

**Status:** accepted

**Consequence:** Roles are enforced on the connection, where the interface cannot be talked out of them.

A client used to name itself and be believed. Making documents owned forces a
question the project had not had to answer: what a client is allowed to do, as
distinct from what it is able to send.

People are stored apart from documents, in one place both engine servers share.
A document belongs to an engine because only that engine can read its history;
a person does not. A document has one owner and gives everyone else a role,
editor or viewer — two roles, because two are all the server actually enforces.

Whether you may open a document is answered once, before the connection is
accepted. Whether you may change it is answered on every edit, because only the
engine can tell an edit from a greeting. Sessions travel in an explicit header
rather than a cookie, since a browser attaches cookies by itself, including on
requests coming from other sites.

The two engines refuse a forbidden edit differently, so the editor is made
genuinely read-only rather than left to fail quietly. The assertions that
matter are the negative ones: a viewer's edit is rejected by the server, and
revoking access disconnects someone already connected.
