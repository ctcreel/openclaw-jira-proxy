## Purpose

Defines the continuous integration and deployment pipeline that every Sc0red template repository MUST implement.

## Requirements

### Requirement: GitHub Actions Workflow Architecture

The template MUST use reusable GitHub Actions workflows with this structure:
- `_ci-checks.yml` — Reusable workflow for lint, test, security, SonarCloud
- `_deploy.yml` — Parameterized deploy workflow with environment approval gates
- `_naming-validation.yml` — Reusable workflow for naming convention checks
- `pull-request.yml` — Orchestrator that calls reusable workflows on PR events
- `post-merge.yml` — Auto-deployment on merge to long-lived branches
- `gitstream.yml` — gitStream PR automation

#### Scenario: Pull Request Opened
- **GIVEN** A developer opens a pull request against the development branch
- **WHEN** GitHub Actions triggers
- **THEN** CI checks, naming validation, and deployment validation MUST all run in parallel

### Requirement: Environment-Aware Deployment

The template MUST support four deployment environments with increasing protection:

| Environment | Branch | Approvals | Admin Enforcement |
|-------------|--------|-----------|-------------------|
| Development | development | 0 | No |
| Testing | testing | 2 | Yes |
| Demo | demo | 2 | Yes |
| Production | production | 3 | Yes |

Each environment MUST have appropriate CDK configuration for:
- Removal policy (DESTROY for dev/test, SNAPSHOT for demo, RETAIN for production)
- Log retention (7d, 14d, 30d, 90d respectively)
- Monitoring (disabled for dev, enabled for test+)
- Tagging (Project, ManagedBy, Environment, CostCenter)

#### Scenario: Production Deployment
- **GIVEN** A PR is opened against the production branch
- **WHEN** The deployment workflow runs
- **THEN** It MUST require 3 approvals, CODEOWNERS review, and all CI checks passing before deployment proceeds

### Requirement: Secrets Management in CI

The template MUST load all secrets from 1Password via `1password/load-secrets-action@v2`. The only GitHub-level secret MUST be `OP_SERVICE_ACCOUNT_TOKEN`. Per-environment AWS credentials MUST be stored in the 1Password Engineering vault.

#### Scenario: CI Accesses AWS Credentials
- **GIVEN** The CI pipeline needs AWS credentials for the testing environment
- **WHEN** The secrets loading step runs
- **THEN** It MUST resolve `op://Engineering/AWS_ACCESS_KEY_ID_TESTING/credential` from 1Password
