# agent-versioning Specification

## Purpose
TBD - created by archiving change spe-2078-tool-use. Update Purpose after archive.
## Requirements
### Requirement: Composite Agent Version Hash

Clawndom MUST compute, at process boot, a single `agent_version` hash identifying the complete materialized state of the running agent's behavior. The hash MUST be a sha256 over a deterministic serialization of every git repository involved in the running configuration. Repositories involved MUST include at minimum:

- The Clawndom checkout itself (the repo from which the running binary was built).
- Each agent's workspace repository (`agent.dir` resolved to its containing repo).
- Each Python package referenced by a `module.python:` tool declaration whose package resolves to a repository outside the agent's workspace repository (e.g., `agency-tools` when consumed as a pip dependency cloned alongside the workspace).

The serialization MUST be order-invariant: repositories sorted by canonical name before concatenation, each line `<name>:<sha>\n`. The resulting hash is stable across boots of the same SHAs and changes if and only if at least one constituent SHA changes.

#### Scenario: Hash Is Stable Across Restarts With Same SHAs
- **GIVEN** Clawndom has booted with a known agent_version hash and the constituent repo SHAs have not changed
- **WHEN** Clawndom restarts
- **THEN** The new agent_version hash MUST equal the previous one

#### Scenario: Hash Changes On Any SHA Change
- **GIVEN** Clawndom has booted with a known agent_version hash
- **WHEN** Clawndom restarts after a commit lands on any of the involved repos
- **THEN** The new agent_version hash MUST differ from the previous one

#### Scenario: Order Invariance
- **GIVEN** Two boots of Clawndom where the iteration order of repos differs but the set of repo SHAs is identical
- **WHEN** Each boot computes the hash
- **THEN** Both hashes MUST be equal

### Requirement: Production Mode Rejects Dirty Repositories

When the runtime environment is `production` (signaled by `CLAWNDOM_ENV=production`), Clawndom MUST verify that every involved repository has no uncommitted changes (i.e., `git status --porcelain` returns empty). If any repository is dirty, boot MUST fail with a clear error naming each dirty repository.

In `development` mode (or when `CLAWNDOM_ENV` is unset), the dirty check is SKIPPED to support iteration.

#### Scenario: Dirty Repo Blocks Production Boot
- **GIVEN** `CLAWNDOM_ENV=production` and the Clawndom checkout has uncommitted changes
- **WHEN** Clawndom boots
- **THEN** Boot MUST fail with an error naming the Clawndom checkout as dirty

#### Scenario: Dirty Repo Allowed In Dev
- **GIVEN** `CLAWNDOM_ENV=development` and the Clawndom checkout has uncommitted changes
- **WHEN** Clawndom boots
- **THEN** Boot MUST succeed; the agent_version hash MUST still be computed but the per-repo breakdown MUST indicate the dirty state

### Requirement: Version Endpoint

Clawndom MUST expose a `GET /version` HTTP endpoint, authenticated with the same Bearer-token scheme as the existing memory routes. The response MUST be a JSON object with shape:

```json
{
  "agent_version": "sha256:<hex>",
  "repos": [
    { "name": "<repo-name>", "sha": "<full-sha>", "dirty": <bool> },
    ...
  ]
}
```

The `repos` array MUST contain one entry per involved repository, ordered by name.

#### Scenario: Endpoint Returns Current Hash
- **GIVEN** Clawndom has booted with a known agent_version hash
- **WHEN** A client requests `GET /version` with valid Bearer auth
- **THEN** The response MUST include the same hash and one entry per involved repo

#### Scenario: Unauthorized Request Rejected
- **GIVEN** Clawndom is running
- **WHEN** A client requests `GET /version` without Bearer auth or with an invalid token
- **THEN** The response MUST be HTTP 401

### Requirement: Version Embedded In Audit Records

Every audit record written by the audit subsystem MUST include the cached `agent_version` hash in its `agent_version` field. The value MUST be the hash captured at boot for the running process; it MUST NOT vary per record within a single boot.

#### Scenario: Audit Records Carry The Boot Version
- **GIVEN** Clawndom has booted with `agent_version: sha256:abc...`
- **WHEN** Multiple tool invocations occur during the process lifetime
- **THEN** Every audit record produced MUST have `agent_version` equal to `sha256:abc...`

