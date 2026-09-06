# Development Workflow

`develop` is the protected default branch. All normal changes use this path:

1. Create `codex/<short-description>` from current `develop`.
2. Make one focused change and run the affected checks.
3. Commit with a subject of at most 70 characters and exactly one DCO sign-off.
4. Add `AI-assisted-by: <model-name>` when AI helped create the commit.
5. Push the topic branch and open a PR into `develop`.
6. Complete one structured Spec, Standards, and Risk review.
7. Run the relevant checks locally and record the result in the PR.
8. Squash merge in GitHub; GitHub deletes the topic branch.

Small changes use the same path with a smaller diff and focused checks.

## Repository settings

The GitHub repository must keep these settings:

- Default branch: `develop`.
- Automatically delete head branches after pull requests merge.
- Allow squash merge.
- Protect `develop` and require a pull request before merging.
- Require a pull request; the structured checklist is the review record.
- Require conversation resolution before merging.
- Do not require GitHub status checks; CI workflows do not run automatically.
- Block force pushes and branch deletion.
- Allow repository administrators to bypass only for a declared emergency.
- Use the built-in `GITHUB_TOKEN` for triage labels; do not depend on an
  upstream organization GitHub App or project board.

Run `scripts/configure-repository` with an authenticated GitHub CLI session to
apply these settings. The script refuses any origin other than
`xuchen-cloud/penpot`.

## Emergency bypass

A direct push to `develop` is allowed only to restore service during an active
incident. The user must state the emergency and approve the exact
`origin/develop` push. Run focused checks when possible and record the reason
in a follow-up issue or PR after service is stable.

## Local merge checks

Before merging, run `scripts/check-commit` for the PR commit range and run the
focused module checks listed in its module memory. Desktop changes include
`pnpm --dir desktop test:node` plus the relevant Rust format, lint, and test
commands. Record the commands and results in the PR's Evidence section.
