# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- Before creating an issue, read `mem:workflow/creating-issues`.
- Create an issue with `gh issue create --title "..." --body "..."`.
- Read an issue with `gh issue view <number> --comments`.
- List issues with `gh issue list`, using suitable state and label filters.
- Comment with `gh issue comment <number> --body "..."`.
- Apply or remove labels with `gh issue edit`.
- Close an issue with `gh issue close <number> --comment "..."`.
- Infer the repository from `git remote -v`.

## Pull requests as a triage surface

**PRs as a request surface: no.**

When changed to `yes`, external pull requests use the same labels and states as issues:

- Read a PR with `gh pr view <number> --comments` and `gh pr diff <number>`.
- List external PRs with `gh pr list`.
- Use `gh pr comment`, `gh pr edit`, and `gh pr close` for updates.
- Keep only requests from external contributors when building a triage queue.

GitHub shares one number space across issues and pull requests. Resolve an unclear `#42` with `gh pr view 42`, then fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue after following `mem:workflow/creating-issues`.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

The map is one GitHub issue with child issues as tickets.

- **Map:** an issue labelled `wayfinder:map`.
- **Child ticket:** a GitHub sub-issue labelled `wayfinder:<type>`, where type is `research`, `prototype`, `grilling`, or `task`.
- **Fallback child link:** if sub-issues are unavailable, add the child to a task list in the map and add `Part of #<map>` to the child.
- **Blocking:** use GitHub issue dependencies. If unavailable, add `Blocked by: #<n>, #<n>` near the top of the child body.
- **Frontier:** choose the first open child in map order that has no open blockers and no assignee.
- **Claim:** run `gh issue edit <n> --add-assignee @me`.
- **Resolve:** comment with the answer, close the child, then add a context pointer to the map's Decisions-so-far section.
