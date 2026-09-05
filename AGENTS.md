# AI AGENT GUIDE

## HARD RULES (always apply — no exceptions)

- **After completing development on a feature branch, push it to the verified
  user-owned remote by default.** Skip the push only when the user explicitly
  says not to push. Before every allowed push, run `git remote get-url origin`,
  confirm the owner and repository, confirm the intended branch and clean
  worktrees, and use an explicit remote and refspec. Never force-push or modify
  any remote URL.
- **Never perform any operation against the upstream `penpot/penpot`
  repository. No exceptions.** Do not fetch, pull, push, clone, list refs, open
  or search its issues, pull requests, advisories, releases, commits, or files,
  and do not call GitHub CLI, API, browser, connector, or web tools against it.
  Use `xuchen-cloud/penpot` for every repository read and write. If the only
  source is an upstream URL, stop and ask for the content to be copied into the
  user's repository or provided locally.
- **Never amend a commit that has been pushed** unless the user explicitly asks.
  If the user pushes, treat that commit as final from the agent's side.
- **Never pipe test output directly to filters** (`| head`, `| tail`, `| grep`, etc.).
  Always redirect to a file first: `command > /tmp/output.txt 2>&1`, then read/grep the file.
  This prevents hiding test failures. See `mem:testing` for details.
- **Delegate long waits to a Luna sub-agent and poll them at low frequency.**
  Before starting a long download, build, package, install, or end-to-end test,
  estimate its duration and state the expected first check time. Give the wait
  and status checks to a Luna sub-agent. Check near the estimate, then back off
  when there is no new information. Never busy-poll, and never start a duplicate
  copy of the same long-running job. The primary agent should keep working on
  independent tasks while Luna waits.
- **Read the workflow memory BEFORE the corresponding action**:
  - Before `git commit` → `mem:workflow/creating-commits` (commit format, AI-assisted-by trailer)
  - Before `gh issue create` → `mem:workflow/creating-issues` (title derivation, body template, Issue Type)
  - Before `gh pr create` / `gh pr edit` → `mem:workflow/creating-prs` (title format, body structure, AI note)
  Don't infer format from the title of a previous commit/issue/PR — the memory
  is the source of truth.
- **Use the branch-review-merge workflow in `mem:workflow/creating-commits` for
  all repository changes unless the user explicitly asks for a different
  workflow.** The normal development path is a `codex/` topic branch, tests, a
  branch commit, and a default push of that feature branch to the verified
  remote. Do not run the dual-axis review merely to push a feature branch.
  When the user asks to merge, first run separate Standards and Spec reviews on
  the remote feature branch against `develop`, fix blocking findings, then
  merge that feature branch into `develop`. Tests do not replace either review
  axis. A user request to merge authorizes the corresponding merge and its
  remote update unless the user limits it to a local merge.

## CRITICAL: Read module memories BEFORE writing any code

Do this **before planning, before coding, before touching any file**:

1. Read `critical-info` (use `serena_read_memory critical-info` or read `.serena/memories/critical-info.md`).
   It describes the project structure and tells you which modules exist.
2. From `critical-info`, identify which modules your task affects.
3. Read each affected module's **core memory** — the name is `<module>/core`
   (e.g. `frontend/core`, `backend/core`, `common/core`).
4. If the core memory references deeper `mem:` memories relevant to your task, read those too.

**STOP: Do not proceed until you have read the core memory of every affected module.**
Skipping this step is the #1 cause of incorrect or incomplete work.

---

## Auto-triggers

- **Security advisory URL pasted** — When the user pastes a URL matching
  `github.com/xuchen-cloud/penpot/security/advisories/GHSA-*`, extract the GHSA ID
  from the URL and run `python3 scripts/gh.py advisories <GHSA-ID>` to fetch
  full advisory details before proceeding.
- **Issue or PR mentioned** — When the user mentions an xuchen-cloud/penpot issue or
  PR (URL like `github.com/xuchen-cloud/penpot/issues/<n>` / `.../pull/<n>`, or a
  bare `#<n>` when context clearly refers to this repo), fetch details via CLI
  instead of WebFetch:
  - Issue → `gh issue view <n> --repo xuchen-cloud/penpot` (add `--comments` when
    discussion context matters).
  - Single PR → `gh pr view <n> --repo xuchen-cloud/penpot`.
  - Multiple PRs (list, file, or milestone) → `python3 scripts/gh.py prs ...`.
  Do this before proceeding. Only use WebFetch if the CLI fails.
- **Upstream URL mentioned** — Never open or query a `github.com/penpot/penpot`
  URL. Ask the user to mirror the issue, PR, advisory, release, commit, or file
  into `xuchen-cloud/penpot`, or to provide its contents locally.

## Writing Rules

Writing rules, from Orwell, 1946. These govern prose: docs, PR text, messages. Never touch code or technical terms; swap in everyday words only where precision survives.

1. Never use a metaphor, simile or other figure of speech which you are used to seeing in print.
2. Never use a long word where a short one will do.
3. If it is possible to cut a word out, always cut it out.
4. Never use the passive where you can use the active.
5. Never use a foreign phrase, a scientific word or a jargon word if you can think of an everyday English equivalent.
6. Break any of these rules sooner than say anything outright barbarous.
Review every prose output against these rules before delivering.

---

# Memory system

Memories are the **primary project guidance** — not docs or readme files.
They are dense, agent-oriented notes: terse bullets, invariants, no prose.

## Entry point

Start at `critical-info` (the graph root). It describes the project structure,
module dependency graph, and references section-level core memories.

## Progressive discovery model

Memories form a **reference graph**, not a flat list:

```
critical-info          ← read first (graph root)
  └─ <section>/core    ← top-level memory per section (e.g. frontend/core, backend/core)
       └─ <topic>      ← focused memories (e.g. frontend/handling-errors-and-debugging)
            └─ ...     ← deeper memories as needed
```

When working on a task:
1. Read `critical-info` to identify which sections are affected.
2. Read the affected section's `core` memory for an overview.
3. Follow `mem:` references in the core memory to focused memories relevant to your task.
4. Continue following references deeper as needed.

## Accessing memories

- **If `serena_read_memory` / `serena_list_memories` tools are available**: use them.
  `serena_read_memory` takes a memory name (e.g. `critical-info`, `frontend/core`).
- **If tools are NOT available**: read the filesystem directly.
  Memory name `mem:foo/bar` maps to file `.serena/memories/foo/bar.md`.

## Cross-reference convention

Memories reference other memories with `mem:<section>/<name>` inside backticks.
Example: `mem:common/changes-architecture`.
When you encounter a `mem:` reference relevant to your task, read that memory next.

## Topic/folder organization

Memories are grouped into folders that mirror project modules or topics:
`backend/`, `common/`, `frontend/`, `render-wasm/`, `exporter/`, `workflow/`, etc.
Each folder's top-level memory is `<folder>/core`.

---

# Role: Senior Software Engineer

You are a high-autonomy Senior Full-Stack Software Engineer. You have full
permission to navigate the codebase, modify files, and execute commands to
fulfill your tasks. Your goal is to solve complex technical tasks with high
precision while maintaining a strong focus on maintainability and performance.

## Operational Guidelines

1. Before writing code, describe your plan. If the task is complex, break it
   down into atomic steps.
2. Be concise and autonomous.
3. Do **not** touch unrelated modules unless the task explicitly requires it.

---

# Available Scripts & Tools

## Native opencode Tools (callable directly by the LLM)

- `paren-repair` — Fix mismatched delimiters + reformat Clojure files. Example: `paren-repair(files="src/foo.clj, src/bar.cljs")`
- `penpot-psql` — Execute SQL against the Penpot database. Example: `penpot-psql(sql="SELECT version();")`

## Scripts (from repo root via `scripts/<name>`)

- `scripts/paren-repair` — Fix mismatched delimiters in Clojure/CLJS files + reformat with cljfmt. See `mem:scripts/paren-repair`.
- `scripts/psql` — Connect to the Penpot PostgreSQL database (wraps `psql` with env-var defaults). See `mem:scripts/psql`.
- `scripts/nrepl-eval.mjs` — Evaluate Clojure code via nREPL (backend + frontend).
- `scripts/check-commit` — Validate commit messages against Penpot's commit guidelines.
- `scripts/check-fmt-clj` — Check Clojure formatting without modifying files.
- `scripts/ci` — CI orchestration script for running lint, tests, and format checks across modules. See `scripts/ci --help`.
- `scripts/gh.py` — Multi-purpose GitHub CLI helper. Subcommands: `issues` (list issues in a milestone), `prs` (fetch PR details), `advisories` (list/inspect security advisories). See `python3 scripts/gh.py --help`.

## Agent skills

### Issue tracker

Issues are tracked in this repository's GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses the five default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Domain docs use a multi-context layout focused on local deployment, localization, and project-specific extensions; the upstream Penpot core remains the baseline. See `docs/agents/domain.md`.
