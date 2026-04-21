## Purpose

Defines the continuous integration and deployment pipeline that clawndom MUST implement.

## Requirements

### Requirement: GitHub Actions Workflow Architecture

The repository MUST use reusable GitHub Actions workflows with this structure:
- `_ci-checks.yml` — Reusable workflow for lint, test, security, SonarCloud
- `_naming-validation.yml` — Reusable workflow for branch-name and naming-convention checks
- `pull-request.yml` — Orchestrator that calls the reusable workflows on PR events
- `deploy-ec2.yml` — Runs on every push to `main`: CI checks, then SSH-deploys to the EC2 host via `scripts/deploy.sh`

#### Scenario: Pull Request Opened
- **GIVEN** A developer opens a pull request against `main`
- **WHEN** GitHub Actions triggers
- **THEN** `_ci-checks.yml` and `_naming-validation.yml` MUST both run and the PR MUST surface a summary of their results

#### Scenario: Merge to main
- **GIVEN** A pull request is merged into `main`
- **WHEN** The push event fires
- **THEN** `deploy-ec2.yml` MUST run CI checks, then SSH to the EC2 host and invoke `sudo -u clawndom bash /opt/clawndom/scripts/deploy.sh`, and the job MUST fail if `/api/health` does not return 200 after the restart

### Requirement: Single-Branch Model

The repository MUST operate against a single long-lived branch (`main`). There are no separate development/testing/demo/production branches; the EC2 host is a single dev instance. Feature work lands on short-lived branches named `{type}/{description}` per `docs/guides/BRANCHING.md` and is merged via pull request.

#### Scenario: Feature Branch Merge
- **GIVEN** A feature branch named `feature/new-provider`
- **WHEN** Its PR to `main` passes CI and is merged
- **THEN** `deploy-ec2.yml` MUST immediately roll the new commit onto the EC2 host

### Requirement: Secrets Management in CI

CI MUST load all secrets from 1Password via `1password/load-secrets-action@v2`. The only GitHub-level secret MUST be `OP_SERVICE_ACCOUNT_TOKEN`. SSH credentials for the deploy job MUST be stored as GitHub Actions repo secrets (`EC2_HOST`, `EC2_USER`, `EC2_SSH_PRIVATE_KEY`) rather than 1Password — they are deploy-target identity, not application secrets.

#### Scenario: CI Accesses SonarCloud Token
- **GIVEN** The SonarCloud job runs in `_ci-checks.yml`
- **WHEN** The secrets loading step runs
- **THEN** It MUST resolve `op://Engineering/SONAR_TOKEN/credential` from 1Password using `OP_SERVICE_ACCOUNT_TOKEN`
