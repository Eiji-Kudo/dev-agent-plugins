# dev-agent-plugins

Reusable development workflow skills for Codex CLI and Claude Code. One shared `skills/` tree is distributed through native marketplace manifests for both tools.

## Included skills

- `gtr-new`: issue or branch to worktree, implementation, pull request, tests, CI, and review automation
- `critics-reviewer`: parallel critical pull request review
- `loop-critics-fix`: repeat review and fixes until no new findings remain
- `review-comment-analysis`: analyze, fix, reply to, and resolve review comments
- `suggest-skill`: identify reusable workflows from the current session
- Supporting skills used by these workflows, including PR descriptions, test planning, AI review requests, and review summaries

## Requirements

- A recent Codex CLI or Claude Code release with plugin marketplace support
- GitHub CLI (`gh`) authenticated for GitHub workflows
- `git gtr` for the worktree workflows
- Project-specific instructions such as `AGENTS.md` or `CLAUDE.md`

## Install for Codex CLI

```bash
codex plugin marketplace add Eiji-Kudo/dev-agent-plugins --ref main
codex plugin add dev-agent-plugins@eiji-dev-tools
```

Invoke a skill by name, for example:

```text
$dev-agent-plugins:gtr-new 123
$dev-agent-plugins:loop-critics-fix 456
```

## Install for Claude Code

```bash
claude plugin marketplace add Eiji-Kudo/dev-agent-plugins
claude plugin install dev-agent-plugins@eiji-dev-tools
```

Invoke a skill through the plugin namespace:

```text
/dev-agent-plugins:gtr-new 123
/dev-agent-plugins:loop-critics-fix 456
```

## Runtime compatibility

The skills use the runtime's available filesystem, shell, web, and sub-agent mechanisms. References to an `Agent` or a background agent mean Claude Code's Agent tools or Codex CLI's collaboration sub-agents, depending on the active runtime.

Skill arguments mean `$ARGUMENTS` in Claude Code and the text following the selected skill in Codex CLI.

## Development

Validate the Claude Code marketplace and plugin:

```bash
claude plugin validate .
claude plugin validate ./plugins/dev-agent-plugins
```

Test the Claude Code plugin without installation:

```bash
claude --plugin-dir ./plugins/dev-agent-plugins
```

Test the Codex marketplace locally:

```bash
codex plugin marketplace add .
codex plugin add dev-agent-plugins@eiji-dev-tools
```

## License

MIT
