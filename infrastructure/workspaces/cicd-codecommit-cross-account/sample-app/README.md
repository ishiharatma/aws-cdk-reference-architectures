# Sample App

This is the initial content seeded into the CodeCommit repository created by
this workspace (`cicd-codecommit-cross-account`). It exists only to give the
three pipelines (dev/stg/prd) something to build and deploy.

- `buildspec-test.yml` — Test stage (echo only)
- `buildspec-build.yml` — Build stage (echo only, writes `build-info.txt`)
- `buildspec-deploy.yml` — Deploy stage: assumes the target account's
  cross-account deploy role and runs `aws sts get-caller-identity` to prove
  the deployment is running under that account's credentials

Push to one of the following branches to trigger the matching pipeline:

| Branch    | Pipeline / target account |
| --------- | -------------------------- |
| `develop` | dev                         |
| `staging` | stg                         |
| `main`    | prd                         |

Replace the `echo` commands in each buildspec with real build/test/deploy
commands for your application.
