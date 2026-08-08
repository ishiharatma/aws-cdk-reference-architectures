<!-- Thanks for contributing! Fill in what's relevant and delete the rest. -->

## Summary

<!-- What does this PR change, and why? A couple of sentences is enough. -->

## Type of change

- [ ] New reference architecture (new workspace under `infrastructure/workspaces/`)
- [ ] Enhancement to an existing workspace
- [ ] Bug fix
- [ ] Documentation only
- [ ] Chore / refactor / CI

## Affected workspace(s)

<!-- e.g. infrastructure/workspaces/sns-basic -->

## Testing

- [ ] `npm run build -w workspaces/<name>`
- [ ] `npm test -w workspaces/<name>` (unit / snapshot / compliance all pass)
- [ ] `npm run lint -w workspaces/<name>`
- [ ] `cdk synth` succeeds
- [ ] Manually verified against a real AWS account

<!-- If you deployed and exercised it manually (e.g. via a test script), briefly
     describe what you ran and what you observed. -->

## New-architecture checklist

<!-- Skip this section entirely if this PR is not adding a new workspace. -->

- [ ] `README.md` and `README.ja.md` are both present and cover the same sections
- [ ] `pages/patterns.json` has an entry for this workspace (`id`/`link` match the
      workspace directory name, `level` matches the README)
- [ ] dev.to draft(s) added under `docs/.tmp/` (`published: false`)
- [ ] CDK Nag (`AwsSolutionsChecks`) passes, with a documented reason for every suppression
- [ ] README includes a cost estimate

## Breaking changes

- [ ] Yes — describe the impact and migration steps below
- [ ] No

## Additional context

<!-- Architecture notes, screenshots, follow-up work, related issues, etc. -->
