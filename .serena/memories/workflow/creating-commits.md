# Creating Commits

Commit when the user explicitly requests it or when completing the default PR workflow required by `AGENTS.md`. Before commit: `git status`; exclude unrelated user changes.

## Default Pull Request Workflow

Unless the user explicitly requests a different workflow:

1. Start from an up-to-date local `develop` and create a `codex/` topic branch.
2. Implement and run the affected module's tests, lint, and format checks.
3. Commit the complete change using the format below.
4. Verify that `origin` is `xuchen-cloud/penpot`, verify the intended branch and clean worktrees, and push the topic branch with an explicit refspec. Skip the push only when the user explicitly says not to push.
5. Open or update a PR from the topic branch into `develop`; PR creation is a standard completion step, not a separate opt-in.
6. Review the PR once with the structured Spec, Standards, and Risk checklist in `mem:workflow/creating-prs`. Fix every blocking finding with new commits and push them without rewriting published history.
7. Before merge, run the relevant checks locally and record the commands and results in the PR. Merge only after the structured review and local checks pass. GitHub CI does not run automatically. Use GitHub squash merge and let GitHub delete the remote topic branch. Never create a local merge commit or push a merge result to `develop` during normal work.

### Small Changes and Emergency Bypass

Small and low-impact changes still use a focused topic branch and a lightweight
PR. Keep the PR short and run only the relevant focused checks.

A direct `develop` push is allowed only when the user declares an emergency and
explicitly approves both the protected-branch bypass and the exact
`origin/develop` refspec. Run focused checks first when the incident permits,
never force-push, and record why the bypass was needed after service is stable.

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
Signed-off-by: Your Real Name <your.email@example.com>
```

Every commit requires exactly one DCO `Signed-off-by` trailer, including docs
and configuration commits. Use `git commit -s`; the sign-off must match the
commit author. Run the local checker on the complete PR commit range before merge.

**AI-assisted-by trailer rules:**
- Required for every AI-assisted commit; omit it for fully manual commits
- Use only the model name, e.g. `mimo-v2.5`, `deepseek-v4-flash`
- Do NOT add prefixes like `opencode-go/` — use the bare model name
- The local checker validates the format whenever the trailer is present

## Commit Type Emojis

`:bug:` bug fix · `:sparkles:` enhancement · `:tada:` new feature · `:recycle:` refactor · `:lipstick:` cosmetic · `:ambulance:` critical fix · `:books:` docs · `:construction:` WIP · `:boom:` breaking · `:wrench:` config · `:zap:` perf · `:whale:` docker · `:paperclip:` other · `:arrow_up:` dep upgrade · `:arrow_down:` dep downgrade · `:fire:` removal · `:globe_with_meridians:` translations · `:rocket:` epic/highlight

## Referencing Issues

Use `Closes #NNNN` (not `Fixes #NNNN`) to link a commit to a GitHub issue.
