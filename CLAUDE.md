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


# Project Conventions

<!-- Fill in per project: stack, commands, style rules, etc. -->
- Build/test commands:
- Code style:
- Key constraints:

---

# Feature Plan Tracking

This project tracks feature plans as files, not in Claude Code's default
plan storage (`~/.claude/plans/`), which is not project-scoped and is not
reliably re-read after context is compacted.

Structure:
```
.claude/plans/
  index.md              <- master status table (cheap to read, read every session)
  dark-mode-toggle.md    <- one file per feature (read only when working on it)
  search-filters.md
  plans-archive/         <- completed features get moved here
```

## Master index (`.claude/plans/index.md`)

A short table, nothing more:

```markdown
| Feature          | Status      | Priority | Type         | File                 | Last updated |
|------------------|-------------|----------|--------------|----------------------|--------------|
| Dark mode toggle  | in-progress | high     | new-feature  | dark-mode-toggle.md  | 2026-08-01   |
| Search filters     | backlog     | medium   | refinement   | search-filters.md    | 2026-07-28   |
| Login crash        | backlog     | high     | bug-fix      | login-crash.md       | 2026-08-05   |
```

**Type vocabulary** (adjust to taste, but keep it consistent within a project):
`bug-fix` · `refinement` · `new-feature` · `refactor` · `chore`

**Priority:** `high` · `medium` · `low` — reflects urgency/importance, independent
of type. A `bug-fix` isn't automatically `high`; a `refinement` isn't
automatically `low`.

## Feature files (`.claude/plans/<feature-slug>.md`)

Every feature file starts with a short status header, before anything else:

```markdown
Status: in-progress
Priority: high
Type: new-feature
Last updated: 2026-08-01

# Dark mode toggle

## Context
<one paragraph: what this is and why>

## Tasks
- [x] Task 1 — done
- [ ] Task 2 — in progress
- [ ] Task 3 — not started

## Decisions
- <anything decided along the way that isn't obvious from the code>
- Superseded decisions are kept, not deleted — see convention below.

## Detours
- <bugs fixed or side-tracks taken while working on this, with a one-line
   note so they don't get mistaken for part of the original plan>

## Open questions
- <anything unresolved that needs a human answer>
```

**Marking a decision as superseded:** don't delete old reasoning when
direction changes — strike it and say why, so it stops steering new work
without erasing the record:

```markdown
- ~~Store preference in localStorage~~ — superseded 2026-08-06: moved to
  server-side user settings once accounts shipped.
- Store preference in user settings table, synced on login.
```

Struck-through decisions are historical context only. Never treat them as
current guidance, and never let them override a plain reading of the
active decision beneath them.

## Source of truth rule

**The feature file's status header is authoritative. The index is a cache,
never the other way around.**

- When you open a feature file to work on it, compare its full header
  (`Status`, `Priority`, `Type`, `Last updated`) to that feature's line in
  the index.
- If any field disagrees, the feature file wins. Update the index line to
  match, and mention to the user that you reconciled a stale index entry —
  don't fix it silently.
- Never rewrite a feature file's header to match the index. The flow is
  always feature file → index.

## Session start behavior

1. Read `.claude/plans/index.md` only. Don't read individual feature files
   up front — the index tells you what exists and its last known status
   without paying for full detail on features you're not touching.
2. State current status back to the user in one or two lines based on the
   index (and mention if the user's request implies a feature whose index
   status looks stale).
3. Once the user names or implies which feature is active, read that one
   feature file in full before proceeding.
4. If no `.claude/plans/` folder exists and the user asks for a non-trivial
   feature, propose creating an index and a feature file before writing code.

## Updating status while working

Whenever a feature's status changes (starting work, finishing a task,
getting blocked), update the feature file's header first, then update its
index line to match, in the same turn. Don't let the index drift while
you're mid-session on a feature — reconciliation only covers gaps you
didn't create yourself.

Check off tasks in the feature file immediately after finishing them, not
at the end of the session — if context gets compacted mid-task, the
checklist is what makes recovery possible.

## Choosing what to work on next

When the user asks something like "what should I work on next," use the
index alone — don't open feature files for this unless the answer is
ambiguous. Default ordering: `priority` first (high before medium before
low), then surface the mix of `type` present at that priority level rather
than picking silently — bug fixes and new-feature work aren't
interchangeable even at the same priority, and the choice is the user's.
For example: "Two high-priority items: a bug fix (login crash) and a new
feature (dark mode toggle). Which do you want?" rather than assuming one.

## Guarding against plan/implementation drift

A plan file being internally consistent doesn't mean it still matches the
code. Across creative iteration this is the more likely failure mode than
losing the plan outright.

- **Before resuming a feature with existing checked-off tasks**, spot-check
  that the checked items are actually reflected in the current code —
  especially if meaningful time has passed or the user mentions the
  direction changed. Don't do an exhaustive re-verification every session;
  a quick sanity look at the relevant files is enough. If something's off,
  say so before continuing rather than building on a checklist that's
  quietly wrong.
- **If the code and the plan disagree**, stop and reconcile explicitly.
  Don't silently force the code back to match a stale plan, and don't
  silently rewrite the plan to match whatever the code currently does —
  either could be the "wrong" one from the user's perspective. Ask.
- **Treat archived plans (`.claude/plans/plans-archive/`) as historical
  record only.** A completed feature's original plan may describe an
  approach that was later abandoned even though the feature itself shipped
  successfully. Don't pull guidance from an archived file for current work
  unless the user explicitly points at it.
- **When starting new work that resembles or touches an earlier feature**,
  it's fine to check that feature's file for context, but read its
  `Decisions` section critically — strikethrough entries are dead, and even
  active-looking entries may reflect thinking the user has since moved past
  without formally superseding it. When in doubt, ask rather than assume
  the old reasoning still holds.

## Audits

On request ("audit plans" / "sync the index"), reconcile the whole index in
one pass, cheaply:

1. For each feature file, read only its header block (`Status` through
   `Last updated`, a handful of lines) — use offset/limit rather than
   reading the full file. Only read a feature file in full if its header
   doesn't match the index or looks ambiguous.
2. Rewrite `index.md` so every line matches its feature file's header.
3. Report which lines changed, if any. If nothing changed, say so briefly.

Audits aren't automatic on every session start — they're a deliberate,
occasional cleanup step, since scanning every feature file costs more than
just trusting the index for routine work.

## Detours and interrupted work

If you get pulled into fixing an unrelated bug while a feature is active,
log it under that feature's **Detours** section rather than losing the
thread. Return to the task list afterward and say so explicitly ("Back to
task 3 of dark-mode-toggle.").

If requirements change mid-feature, update **Context** and **Tasks** and
note what changed and why — don't silently overwrite.

When a feature is complete, set its header to `Status: done` and move the
file to `.claude/plans/plans-archive/`, then update the index line to point
at the new path. Don't delete it — it's useful history for related work later.

---

# Mode-switch discipline

Plan mode → execution → interrupted-by-a-bug → back to execution is where
context most often gets lost. Any time you're about to leave the current
task to do something else, say what you're switching to and why, and name
the feature/task you'll return to. When you come back, say so explicitly
rather than silently resuming.

# After a compaction or a fresh session

Don't assume you remember the state of an in-progress feature from
conversation alone. Re-read the relevant feature file and treat it as
authoritative over anything you recall. If the file and your memory of the
conversation disagree, the file wins — say so and confirm before continuing.