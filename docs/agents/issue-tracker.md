# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues on `jrflga/boop-agent` (the `fork` remote). Use the `gh` CLI for all operations and pass `--repo jrflga/boop-agent` explicitly — the local clone has two remotes (`fork` for the user's own work, `origin` for the upstream `raroque/boop-agent`), and `gh` defaults to `origin`, which is the wrong target.

## Conventions

- **Create an issue**: `gh issue create --repo jrflga/boop-agent --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --repo jrflga/boop-agent --comments`.
- **List issues**: `gh issue list --repo jrflga/boop-agent --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --repo jrflga/boop-agent --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --repo jrflga/boop-agent --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --repo jrflga/boop-agent --comment "..."`

## When a skill says "publish to the issue tracker"

Create a GitHub issue on `jrflga/boop-agent`.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --repo jrflga/boop-agent --comments`.
