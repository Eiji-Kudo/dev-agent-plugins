---
name: pr-local-qa-screenshot
description: Verify visual PR changes in a local browser, capture screenshots, embed them in the PR description through immutable commit URLs, and remove temporary images from the final diff. Use when UI behavior needs visual evidence; do not use for non-visual changes.
---

# PR Local QA Screenshot

Run the changed UI locally, preserve visual evidence in the PR description, and leave the final PR diff free of temporary QA assets.

## Inputs and boundary

- Prefer a canonical PR URL. Resolve a current-branch PR only when the repository and PR are unambiguous.
- Record the expected behavior, affected routes, and relevant test identities or data states before starting.
- Preserve unrelated worktree changes. Do not modify local DB data without explicit approval.
- Use this skill only when a screenshot materially helps review a visual or interaction change.

## Local verification

1. Inspect the PR diff, project instructions, local startup commands, and existing E2E or QA helpers.
2. Identify the smallest set of scenarios that demonstrates the changed behavior and an important unaffected case.
3. Start the real local application and exercise the behavior in a browser, preferably with existing Playwright fixtures and mocks.
4. If existing local test infrastructure is blocked, diagnose it first. A temporary route or script may be used only when it renders the real changed component and is removed exactly after capture. Report any limitation rather than calling a blocked end-to-end flow successful.
5. Assert the expected DOM or interaction state in addition to visually inspecting it.
6. Capture settled screenshots without loading skeletons, developer overlays, secrets, personal data, or unrelated page area. Inspect every image before publication.

Store temporary screenshots under `temp-docs/screenshots/` with PR-scoped names. Do not stage temporary harness files, caches, traces, or reports.

## Publish without leaving image files in the final diff

Perform this lifecycle after ordinary code and CI changes are final, but before requesting AI review:

1. Revalidate the canonical PR identity, local head, raw remote head, base, and clean scope before each mutation.
2. Commit and push only the approved screenshots. Record the full screenshot commit OID.
3. Add the screenshots to the PR description with URLs pinned to that immutable OID:

   `https://github.com/<owner>/<repo>/blob/<screenshot-commit-oid>/<path>?raw=true`

4. Re-read the PR description and verify the exact image URLs. Confirm each historical file with the GitHub contents API using `ref=<screenshot-commit-oid>`.
5. Delete the temporary PNG files from the branch, commit the deletions, and push with the same identity and lease checks.
6. Verify that the final PR file list contains neither the screenshots nor temporary Markdown or harness files, the worktree is clean, and both historical image URLs still resolve.

The screenshot commit must remain reachable. Do not squash, rebase, or otherwise rewrite it after publication. If later history rewriting is unavoidable, repeat the publication lifecycle and update the PR description to a new reachable commit OID.

## PR description

- Keep the repository's PR template and existing relevant content.
- State which local scenarios were verified and distinguish browser verification from blocked full E2E execution.
- Put screenshots near the behavior they support, with concise alt text.
- Keep CI-derived checks out of manual QA checklists.

## Completion report

Report:

- scenarios and local URLs tested;
- assertions and visual results;
- screenshot commit OID and PR description verification;
- confirmation that temporary routes, scripts, Markdown, PNGs, caches, and traces were excluded from the final diff;
- any local infrastructure limitation that prevented a true end-to-end path.
