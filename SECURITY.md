# Security

planfly stores bank accounts, balances and the detail of what a person spends
money on. A fault here does not break a page: it exposes that.

## Reporting a fault

**Do not open a public issue.** Use GitHub's private advisory:

> Security → Report a vulnerability

If you cannot, open an issue saying only «I have a security report» and wait for
a private channel. Do not paste details or proofs of concept into it.

Say what you found, how to reproduce it and what can be done with it. An email
saying «I tried this and got that» is worth more than a formal report.

This is maintained by one person in their spare time: an answer may take days.
You always get one, even if it is to say it is not a fault.

## What counts as a fault

- Reading, writing or deleting a household's data without being a member of it.
- Bypassing the login, or staying in after logging out.
- Writing with a read-only account, or any other way of escalating permissions.
- SQL injection, code execution, or reading server files.
- An API token working beyond its declared scopes.
- A connected rate source being able to execute something outside its remit.

## What does not

- The instance being exposed to the internet. **planfly is meant to run on a
  machine of your own**, not to be published. With no TLS, no firewall and the
  port open, what happens is the installation's doing, not the program's.
- A figure coming out wrong because a rate source published a bad value. That is
  a data fault, and it goes as an ordinary issue.
- Missing rate limiting, security headers or session rotation on a local
  single-user installation. These are accepted as improvements, not as
  vulnerabilities.

## What is already known

Said here so nobody spends an afternoon finding it:

- The Postgres password in `compose.yaml` is an example one and the database
  only hangs off an internal network with the port bound to `127.0.0.1`. If you
  move this to a server, change it.
- Form sign-up is deliberately closed: accounts are created from the terminal.
- There is no email verification and no second factor. There is no mail server,
  and the usage model is one person on their own machine.
