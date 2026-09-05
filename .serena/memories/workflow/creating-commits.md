# Creating Commits

Commit when the user explicitly requests it or when completing the default branch-review-merge workflow required by `AGENTS.md`. Before commit: `git status`; exclude unrelated user changes.

## Default Branch Workflow

Unless the user explicitly requests a different workflow:

1. Identify the local target branch and create a `codex/` topic branch from it.
2. Implement and run the affected module's tests, lint, and format checks on the topic branch.
3. Commit the complete change on the topic branch using the format below.
4. Run the `$code-review` skill with the target branch as the fixed point. Keep its Standards and Spec results separate.
5. Fix every blocking finding, commit the fixes, and repeat the affected review axis.
6. Merge the reviewed topic branch into the local target branch only after both axes pass.
7. Do not create a PR or push unless the user explicitly requests that separate action. Before an allowed push, verify that `origin` is `xuchen-cloud/penpot`, verify the branch list and clean worktrees, and use an explicit refspec. Never force-push or change a remote URL.

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
