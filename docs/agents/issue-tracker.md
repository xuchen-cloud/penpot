# Issue tracker: GitHub

Issues and PRDs for this repo live in `xuchen-cloud/penpot` GitHub Issues. Use the `gh` CLI with `--repo xuchen-cloud/penpot` for all operations. Never read from or write to the upstream `penpot/penpot` repository.

## Conventions

- Before creating an issue, read `mem:workflow/creating-issues`.
- Create an issue with `gh issue create --repo xuchen-cloud/penpot --title "..." --body "..."`.
- Read an issue with `gh issue view <number> --repo xuchen-cloud/penpot --comments`.
- List issues with `gh issue list --repo xuchen-cloud/penpot`, using suitable state and label filters.
- Comment with `gh issue comment <number> --repo xuchen-cloud/penpot --body "..."`.
- Apply or remove labels with `gh issue edit <number> --repo xuchen-cloud/penpot`.
- Close an issue with `gh issue close <number> --repo xuchen-cloud/penpot --comment "..."`.
- Verify that `git remote get-url origin` points to `xuchen-cloud/penpot`, then pass `--repo xuchen-cloud/penpot` explicitly.

## Pull requests as a triage surface

**PRs as a request surface: no.**

When changed to `yes`, external pull requests use the same labels and states as issues:

- Read a PR with `gh pr view <number> --repo xuchen-cloud/penpot --comments` and `gh pr diff <number> --repo xuchen-cloud/penpot`.
- List external PRs with `gh pr list --repo xuchen-cloud/penpot`.
- Use `gh pr comment <number> --repo xuchen-cloud/penpot`, `gh pr edit <number> --repo xuchen-cloud/penpot`, and `gh pr close <number> --repo xuchen-cloud/penpot` for updates.
- Keep only requests from external contributors when building a triage queue.

GitHub shares one number space across issues and pull requests. Resolve an unclear `#42` with `gh pr view 42 --repo xuchen-cloud/penpot`, then fall back to `gh issue view 42 --repo xuchen-cloud/penpot`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue after following `mem:workflow/creating-issues`.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --repo xuchen-cloud/penpot --comments`.

## Wayfinding operations

The map is one GitHub issue with child issues as tickets.

- **Map:** an issue labelled `wayfinder:map`.
- **Child ticket:** a GitHub sub-issue labelled `wayfinder:<type>`, where type is `research`, `prototype`, `grilling`, or `task`.
- **Fallback child link:** if sub-issues are unavailable, add the child to a task list in the map and add `Part of #<map>` to the child.
- **Blocking:** use GitHub issue dependencies. If unavailable, add `Blocked by: #<n>, #<n>` near the top of the child body.
- **Frontier:** choose the first open child in map order that has no open blockers and no assignee.
- **Claim:** run `gh issue edit <n> --repo xuchen-cloud/penpot --add-assignee @me`.
- **Resolve:** comment with the answer, close the child, then add a context pointer to the map's Decisions-so-far section.
