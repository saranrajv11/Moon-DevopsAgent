# Setup — what you need to do

Ordered. Each step is independently verifiable.

## Try it first (no org needed)

Demo mode runs the whole system — tools, gates, confirmation flow, RCA — against
seeded data. No Salesforce, no GitHub App, no CI/CD.

    cd server
    # .env already has DEMO_MODE=true and CICD_PROVIDER=mock
    # add your Claude key:
    #   ANTHROPIC_API_KEY=sk-ant-...
    npm run dev

Three seeded stories: **0001** ready for QA, **0002** failed in QA (exercises RCA),
**0003** blocked on a failing check and a changes-requested review.

Set `DEMO_MODE=false` when you point it at a real org.

## ⚠️ Do not deploy to foodbridge2

Tried on 2026-09-20. The deploy reports `Succeeded` but silently drops every
field that is not required or a master-detail relationship — 92 fields in source,
13 in the org. Objects then cannot be deleted either: the Metadata API reports
`No CustomObject named: X found` while `describe` still returns them. Seven
phantom objects are sitting in that org now; remove them by hand in Setup →
Object Manager if they bother you. They hold no data.

Use a fresh Developer Edition or a sandbox instead.

## Org aliases for validation

`validate_pr_against_org` runs a real check-only deploy, so the server needs an
authenticated CLI connection per environment:

    sf org login web --alias dev
    sf org login web --alias qa
    sf org login web --alias prod

Aliases default to the lowercase environment name; override with `SF_ORG_DEV`,
`SF_ORG_QA`, `SF_ORG_PROD` in `.env` if yours are named differently.

`WORKSPACE_ROOT` (default `/tmp/sfdevops-workspaces`) is where the repo is cloned
and the PR's head commit checked out. `SOURCE_PATH` (default `force-app`) is the
metadata root inside your repo.

## 0. Prerequisites

- [x] **Node 22** — installed (v22.23.2), keg-only path added to `~/.zshrc`.
      Server builds clean and boots. Nothing further needed here.

## 1. Salesforce org

- [ ] Decide which org this targets. If it's a demo org where custom fields
      don't surface, tell me — the data model needs rebuilding on standard objects.
- [ ] `cd sf-metadata && sf project deploy start --target-org <alias>`
- [ ] Create a dedicated **integration user** (not your own login).
- [ ] Assign `DevOps_Copilot_Integration` to that user only.
- [ ] Create three more permission sets for humans — `DevOps_Copilot_Developer`,
      `DevOps_Copilot_Release_Manager`, `DevOps_Copilot_Admin`. `auth.ts` maps
      these names to roles; clone `DevOps_Copilot_Reader` and adjust.
- [ ] Assign the right set to each human who will use the chatbot.

## 2. Salesforce connected app (JWT auth)

- [ ] `openssl req -x509 -sha256 -nodes -days 3650 -newkey rsa:2048 -keyout server/secrets/sf-server.key -out server/secrets/sf-server.crt`
- [ ] Setup → App Manager → New Connected App. Enable OAuth, upload the `.crt`,
      check **Use digital signatures**. Scopes: `api`, `refresh_token`.
- [ ] Manage → Edit Policies → Permitted Users = *Admin approved users are pre-authorized*.
- [ ] Manage → Profiles/Permission Sets → add the integration user.
- [ ] Copy the Consumer Key into `SF_CLIENT_ID`.

## 3. GitHub App

- [ ] Create a GitHub App (org settings → Developer settings → GitHub Apps).
- [ ] Repository permissions: **Contents** read, **Pull requests** read,
      **Checks** read, **Actions** read+write, **Administration** read
      (needed for branch-protection rules).
- [ ] Subscribe to events: `push`, `pull_request`, `pull_request_review`, `check_suite`.
- [ ] Webhook URL: `https://<your-host>/api/webhooks/git`. Set a webhook secret.
- [ ] Install it on your Salesforce repo. Note the installation ID from the URL.
- [ ] Generate a private key, save to `server/secrets/github-app.pem`.

## 4. Branch convention

- [ ] Confirm your team uses `feature/0001`. If your branches look different
      (`feature/ABC-123`, `US-0001`), change `FEATURE_BRANCH_PATTERN` in `.env` —
      the regex's first capture group must yield the Feature ID.
- [ ] Confirm your environment tracking branches. `compare_environments` assumes
      `develop`/`qa`/`stage`/`main`; edit `branchFor` in `server/src/tools/index.ts` if not.

## 5. CI/CD

- [ ] Tell me which system you use. Adapters exist for GitHub Actions and
      Jenkins; `mock` runs the whole flow end-to-end without real deployments.
- [ ] For GitHub Actions: copy `pipeline-templates/salesforce-dev-to-qa.yml` into
      `.github/workflows/`, once per hop (dev-to-qa, qa-to-stage, stage-to-prod).
      The adapter resolves workflow files by that naming convention.
- [ ] Add repo secrets: `SF_QA_AUTH_URL` etc. (one per org, from
      `sf org display --verbose --target-org <alias>`), plus `COPILOT_WEBHOOK_URL`
      and `COPILOT_WEBHOOK_TOKEN`.
- [ ] Set GitHub **environment protection rules** on PROD — required reviewers
      there are your last line of defense, independent of this system.

## 6. Run it

- [ ] `cp server/.env.example server/.env` and fill in every value.
- [ ] `cd server && npm run dev`
- [ ] `curl localhost:3001/health`
- [ ] Local testing without Salesforce auth: `DEV_IMPERSONATE=005xx:alice:developer npm run dev`
      (refuses to run when `NODE_ENV=production`).

## 7. Expose the server with ngrok

Salesforce and GitHub both need to reach your laptop over HTTPS.

- [ ] `brew install ngrok` and sign up for a free authtoken.
- [ ] `ngrok config add-authtoken <your token>`
- [ ] `ngrok http 3001` — leave it running, copy the `https://....ngrok-free.app` URL.
- [ ] **The URL changes every restart on the free plan.** When it does, update the
      Named Credential and the GitHub App webhook URL. A paid static domain
      avoids this.

## 8. Named Credential (how the LWC reaches the server)

The LWC cannot call your Node service directly, so Apex proxies through a Named
Credential. It carries a shared secret that proves the identity headers came
from your org's Apex rather than a forged request.

- [ ] Generate a secret and put it in `server/.env` as `APEX_SHARED_SECRET`:

      APEX_SHARED_SECRET=<generate one: openssl rand -hex 32>

- [ ] Setup → Named Credentials → **External Credentials** → New
      - Label / Name: `DevOps Copilot` / `DevOps_Copilot`
      - Authentication Protocol: **Custom**
      - Add a Principal named `DevOpsCopilotPrincipal`, sequence 1
      - On that principal add an **Authentication Parameter**:
        Name `Secret`, Value = the secret above
- [ ] External Credential → Permission Sets → add `DevOps_Copilot_Reader`
      (and the developer/release-manager sets) so users can use the credential.
- [ ] Setup → Named Credentials → New
      - Label / Name: `DevOps Copilot` / `DevOps_Copilot`
      - URL: your ngrok https URL (no trailing slash)
      - External Credential: `DevOps Copilot`
      - **Uncheck** "Generate Authorization Header"
      - **Check** "Allow Formulas in HTTP Header"

## 9. Add the LWC to a Lightning page

- [ ] Setup → Lightning App Builder → New → App Page → one region
- [ ] Drag **DevOps Copilot** onto it, save, activate.

## 10. Still to build

- [ ] **Conversation persistence** — in-process memory today, so the server is
      single-instance and loses history on restart. Fine for local; needs Redis
      before it is shared.
- [ ] **Webhook auth on `/api/webhooks/pipeline`** — the Git webhook verifies its
      HMAC signature; the pipeline callback accepts its bearer token without
      checking it. Fix before exposing beyond ngrok.
- [ ] **Live model turn untested** — no Claude API key was available in my
      environment, so the orchestrator's real tool loop has never run end to end.
      The polling transport around it is tested with a stub.

## Decisions (settled)

| Question | Answer |
|---|---|
| Git host | GitHub — `saranrajv11/Moon-DevopsAgent` |
| CI/CD | GitHub Actions |
| Server | Local + ngrok |
| UI | LWC inside Lightning |
| Org | Real org, custom objects fine |
