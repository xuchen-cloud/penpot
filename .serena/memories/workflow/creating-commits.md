# Creating Commits

Commit when the user explicitly requests it or when completing the default branch-review-merge workflow required by `AGENTS.md`. Before commit: `git status`; exclude unrelated user changes.

## Default Branch Workflow

Unless the user explicitly requests a different workflow:

1. Identify the local target branch and create a `codex/` topic branch from it.
2. Implement and run the affected module's tests, lint, and format checks on the topic branch.
3. Commit the complete change on the topic branch using the format below.
4. Verify that `origin` is `xuchen-cloud/penpot`, verify the intended branch and clean worktrees, and push the completed feature branch with an explicit refspec by default. Skip this push only when the user explicitly says not to push.
5. Do not run the dual-axis review for a push alone. When the user asks to merge, review the remote feature branch against `develop` with separate Standards and Spec axes.
6. Fix every blocking finding, commit the fixes, push the updated feature branch, and repeat the affected review axis.
7. Merge the reviewed remote feature branch into `develop` only after both axes pass. A merge request authorizes the local merge; push the resulting `develop` update only when the request also authorizes a remote update or names the remote branch. Never force-push or change a remote URL.

### Small-Change Shortcut

For a change assessed as small and low impact, use the shortcut only after the
user explicitly approves both that assessment and the shortcut:

1. Work directly on local `develop`; do not create a topic branch.
2. Run the relevant focused tests, lint, and format checks.
3. Commit using the format below; do not run the dual-axis review.
4. Verify `origin` is `xuchen-cloud/penpot`, confirm a clean worktree and the
   intended ref, then push local `develop` to `origin/develop` explicitly.

The shortcut never permits force-pushes, remote changes, or any operation
against upstream `penpot/penpot`.

Do not guess or hallucinate git author information (Name or Email). Never include the
`--author` flag in git commands unless specifically instructed by the user for a unique
case; assume the local environment is already configured. Allow git commit to
automatically pull the identity from the local git config `user.name` and `user.email`.


## Message Format

```
:emoji: Subject line (imperative, capitalized, no period, <=70 chars)

Body explaining what changed and why.
Wrap lines at 72 characters — git log and tooling
render long lines poorly. Keep each line concise.

AI-assisted-by: model-name
```

**AI-assisted-by trailer rules:**
- Use only the model name, e.g. `mimo-v2.5`, `deepseek-v4-flash`
- Do NOT add prefixes like `opencode-go/` — use the bare model name

## Commit Type Emojis

`:bug:` bug fix · `:sparkles:` enhancement · `:tada:` new feature · `:recycle:` refactor · `:lipstick:` cosmetic · `:ambulance:` critical fix · `:books:` docs · `:construction:` WIP · `:boom:` breaking · `:wrench:` config · `:zap:` perf · `:whale:` docker · `:paperclip:` other · `:arrow_up:` dep upgrade · `:arrow_down:` dep downgrade · `:fire:` removal · `:globe_with_meridians:` translations · `:rocket:` epic/highlight

## Referencing Issues

Use `Closes #NNNN` (not `Fixes #NNNN`) to link a commit to a GitHub issue.
