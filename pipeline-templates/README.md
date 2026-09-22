# Pipeline templates

Copy these into `.github/workflows/` in your own repository, one file per
promotion hop (dev-to-qa, qa-to-prod). They are kept here rather than under
`.github/` so the repository can be pushed with a token that has no `workflow`
permission — activating a pipeline should be a deliberate act, not something
that happens because a branch was pushed.

The CI/CD adapter resolves workflow files by the naming convention
`salesforce-<source>-to-<target>.yml`, so keep those names.

Required repository secrets:

| Secret | Purpose |
|---|---|
| `SF_QA_AUTH_URL` | `sf org display --verbose --target-org qa` → Sfdx Auth Url |
| `SF_PROD_AUTH_URL` | same, for production |
| `COPILOT_WEBHOOK_URL` | where Moon listens, e.g. the ngrok https URL |
| `COPILOT_WEBHOOK_TOKEN` | shared secret for the pipeline callback |

Set GitHub **environment protection rules** on the production environment —
required reviewers there are the last line of defence, independent of Moon.
