# Moon — DevOps Agent

An AI DevOps engineer over Salesforce, Git and CI/CD. Ask about a User Story
and get one answer across all three systems. Ask to deploy, and it drives the
organisation's existing pipeline through gates it cannot bypass.

## The join key

Every User Story records the Git branch the developer actually used — any name
they like. That stored branch is what ties the systems together:

    DevOps_User_Story__c.Feature_Branch__c = "saran/payment-validation"
        -> the pull request whose head is that branch
        -> its commits, reviews, checks and changed files
        -> the exact components a promotion would deploy

No naming convention, no ID embedded in the branch name.

## Layout

    server/src/
      orchestrator/   Claude tool loop and system prompt
      tools/          the 13 tools Claude can call
      policy/         15 gates, RBAC, audit, confirmation tokens
      connectors/     Salesforce, GitHub, CI/CD, git workspace
    force-app/        Salesforce metadata: 8 objects, LWC, Apex
    .github/workflows/  pipeline template, one per promotion hop

## Why deployment is safe

Claude cannot write Salesforce metadata — no tool does that. It can only ask
the CI/CD pipeline to run. Three mechanisms enforce this, none of which depend
on the model behaving well:

1. **Two-phase commit.** `request_deployment` validates and mints a token but
   deploys nothing; `execute_deployment` requires that token. The model cannot
   forge one, so it cannot skip confirmation.
2. **Tool-layer RBAC.** Permission is checked against the *human* caller at
   request time and again at execution, inside `runTool()`.
3. **PROD approval record** bound to an exact commit SHA. No role substitutes
   for it.

Every tool call is written to `DevOps_Audit_Log__c`.

## Promotion path

    DEV -> QA -> PROD

One hop at a time; the promotion-path gate rejects skips.

## Getting started

See [SETUP.md](SETUP.md). In short: deploy the metadata with `./deploy.sh <org-alias>`,
configure `server/.env` from `server/.env.example`, then `npm run chat` in
`server/` to talk to it from a terminal, or add the **Moon** Lightning page for
the in-Salesforce experience.

`DEMO_MODE=true` runs the whole system against seeded data with no org, no
GitHub App and no CI/CD — useful for evaluating it before wiring anything up.
