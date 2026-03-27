# Environment Variables

## Application

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `development` | Runtime environment |
| `PORT` | `8000` | Local dev server port |
| `LOG_LEVEL` | `info` | Logging level (debug, info, warn, error) |
| `LOG_FORMAT` | `json` | Log format (json, human) |
| `SERVICE_NAME` | `sc0red-api` | Service identifier for logs |

## Database

| Variable | Required | Description |
|----------|----------|-------------|
| `DB_HOST` | Yes | MongoDB host |
| `DB_USER` | Yes | MongoDB username |
| `DB_PASS` | Yes | MongoDB password |
| `DB_NAME` | Yes | Database name |

## Infrastructure

| Variable | Required | Description |
|----------|----------|-------------|
| `CDK_ENVIRONMENT` | Yes | Target environment |
| `AWS_ACCOUNT_ID` | Yes | AWS account ID |
| `AWS_REGION` | Yes | AWS region (default: us-east-1) |

## Validation

All environment variables are validated at startup using Zod schemas in `src/config.ts`.
