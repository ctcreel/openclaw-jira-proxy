# Sc0red TypeScript Backend Template

Production-ready Express.js + TypeScript backend template deployed on AWS Lambda with MongoDB.

## Prerequisites

- Node.js 22+ (via nvm: `nvm use`)
- pnpm 10+ (`corepack enable`)
- 1Password CLI (`brew install 1password-cli`)
- GitHub CLI (`brew install gh`)
- AWS CLI (`brew install awscli`)

## Setup

```bash
pnpm install
cd infra && pnpm install && cd ..
make check-all   # Verify everything works
```

## Development

```bash
make dev          # Local server on port 8000
make check        # Run all checks
make format       # Auto-fix formatting
```

## Architecture

```
src/
  app.ts           # Express app setup
  lambda.ts        # AWS Lambda handler
  server.ts        # Local dev server
  config.ts        # Zod-validated environment config
  routes/          # Express route definitions
  controllers/     # Request handlers
  services/        # Business logic
  middleware/       # Error handler, request logger, validation
  database/        # MongoDB/Mongoose connection
  lib/
    exceptions/    # Sc0redError hierarchy (RFC 7807)
    logging/       # Pino structured logging
    observability/ # CloudWatch metrics
    utils/         # Retry, cache utilities
```

## Documentation

- [Standards](docs/standards/STANDARDS.md)
- [Naming Conventions](docs/standards/NAMING_CONVENTIONS.md)
- [Branching](docs/guides/BRANCHING.md)
- [Environment Variables](docs/guides/ENVIRONMENT_VARIABLES.md)
- [Secrets Management](docs/guides/SECRETS_MANAGEMENT.md)
- [Design Patterns](docs/design-patterns-guide.md)
