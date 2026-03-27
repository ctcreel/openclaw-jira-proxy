## Purpose

Defines the infrastructure-as-code requirements for Sc0red service deployment.

## Requirements

### Requirement: AWS CDK

The template MUST use AWS CDK for all infrastructure definitions. CDK code MUST:
- Use L2/L3 constructs (no L1/Cfn* without documented justification)
- Accept environment configuration as props (no hardcoded values)
- Include proper tagging on all resources
- Define outputs for key resource identifiers
- Live in an `infra/` directory with its own dependency management

#### Scenario: Hardcoded Account ID
- **GIVEN** A CDK stack contains a hardcoded AWS account ID
- **WHEN** CodeRabbit reviews the PR
- **THEN** CodeRabbit MUST flag it as a violation requiring CDK context or environment variables

### Requirement: Environment Configuration

The CDK app MUST support four environments with configuration loaded from CDK context or environment variables:
- AWS account ID and region per environment
- Environment-specific settings (removal policy, log retention, monitoring, backups)
- All environments MUST use us-east-1 region

#### Scenario: New Environment Deployment
- **GIVEN** CDK_ENVIRONMENT is set to "testing"
- **WHEN** CDK synth runs
- **THEN** The synthesized template MUST use the testing account ID, DESTROY removal policy, 14-day log retention, and monitoring enabled
