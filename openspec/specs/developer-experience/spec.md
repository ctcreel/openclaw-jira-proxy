## Purpose

Defines the developer experience requirements that make the template easy to use for both human and AI developers.

## Requirements

### Requirement: One-Command Setup

The template MUST be fully set up with a single install command followed by `make check-all` to verify. Prerequisites MUST be documented in README.md.

#### Scenario: Fresh Clone
- **GIVEN** A developer clones the repository
- **WHEN** They run the install command and then `make check-all`
- **THEN** All checks MUST pass with zero configuration beyond documented prerequisites

### Requirement: Git Bot Identity

The template MUST support the SignalField Claude GitHub App bot identity for AI-authored commits. Scripts MUST be provided for:
- Generating GitHub App installation tokens
- Pushing as the bot identity
- The pre-commit gate MUST enforce bot identity on Claude Code commits

#### Scenario: AI Pushes Code
- **GIVEN** Claude Code has made changes and committed as the bot
- **WHEN** The push script runs
- **THEN** The commit MUST appear as authored by `signalfield-claude[bot]` in GitHub

### Requirement: Branch Initialization

The template MUST include a script to initialize the four-branch strategy (development, testing, demo, production) and set development as the default branch.

### Requirement: Branch Protection Setup

The template MUST include a script to configure GitHub branch protection rules matching the environment protection levels defined in the CI/CD spec.

### Requirement: OpenSpec Integration

The template MUST be initialized with OpenSpec for spec-driven development. The OpenSpec setup MUST include:
- Claude Code slash commands (/opsx:propose, /opsx:apply, /opsx:explore, /opsx:archive)
- Empty specs/ directory for baseline specifications
- Empty changes/ directory for feature proposals
- The specs/ directory MUST contain the baseline specifications describing the template itself

#### Scenario: New Feature Development
- **GIVEN** A developer wants to add a feature to a repo created from this template
- **WHEN** They run /opsx:propose
- **THEN** OpenSpec MUST guide them through creating a proposal, design, and task list before any code is written

### Requirement: AGENTS.md Compatibility

The template SHOULD include an AGENTS.md file at the repository root for compatibility with non-Claude AI coding tools. AGENTS.md follows the Linux Foundation open standard and MUST contain: build commands, test commands, lint commands, architecture overview (under 10 lines), file organization conventions, and key constraints. AGENTS.md MUST be kept in sync with CLAUDE.md — they describe the same project but AGENTS.md is tool-agnostic.

#### Scenario: Non-Claude AI Agent Onboarding
- **GIVEN** A developer uses a non-Claude AI coding tool (Cursor, Copilot, Gemini)
- **WHEN** The tool reads AGENTS.md
- **THEN** The tool MUST have sufficient context to run builds, tests, and understand the project structure
