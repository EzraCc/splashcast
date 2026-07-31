# Working in this repo

## Changelog

Every change that touches code or behavior — add, update, or remove — gets a
`CHANGELOG.md` entry as part of the same piece of work, not as an
afterthought at the end of a session. Match the file's existing style: a
`## YYYY-MM-DD` header for today (reuse it if one already exists for today),
a bold one-line summary per change, then terse, evidence-heavy bullets (real
numbers, what was verified, real trade-offs) — not a changelog of vague
intentions. If a later change in the same day supersedes an earlier entry's
described behavior, add a new entry noting the follow-up rather than
silently rewriting the old one — the file is a log, not a snapshot.

## README

Before any push to remote, check `README.md` against what's actually being
pushed and fix anything stale: wrong file/constant names, features that
shipped but were never mentioned, described behavior that no longer matches
the code. Don't wait to be asked.
