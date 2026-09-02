# ADR-020: Signing in with Google

**Status:** accepted

**Consequence:** Identity is federated; authority is not.

Accounts asked a visitor who only wants to look at a collaborative editor to
invent a password first. Adding a second way to sign in raises a question the
project had not had to answer: what a credential is, as distinct from a person.

A credential belongs to a provider; a person does not. Sign-in methods are
stored separately from people, keyed on the identifier the provider promises is
stable rather than on an email address, which can change hands. A person may
have a password, a provider, or both.

The provider's token is verified here and exchanged for one of our own
sessions, so nothing downstream — sharing, ownership, the roles enforced on the
connection — can tell a federated sign-in from a password one. Only identity is
taken: signing in gives this application no access to anything else of yours.

Accounts are linked by email only when the provider says the address is
verified, which is what makes it safe. Signing in with a password to an account
that has none is refused exactly as an unknown address is, so nothing leaks
about which addresses exist here. Leave it unconfigured and the feature is off
rather than broken.
