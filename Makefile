.PHONY: install lint-quick lint test security naming check sonar check-all format review dev dev-unsafe cdk-synth cdk-deploy deploy sync-standards smoke help

# ============================================================================
# SETUP
# ============================================================================

install: ## Install all dependencies
	pnpm install
	cd infra && pnpm install

# ============================================================================
# LINTING & TYPE CHECKING
# ============================================================================

lint-quick: ## Quick lint (ESLint + TypeScript type check)
	pnpm exec eslint --ext .ts src/
	pnpm exec tsc --noEmit

lint: lint-quick ## Full lint (includes Prettier format check)
	pnpm exec prettier --check "src/**/*.ts" "tests/**/*.ts"

# ============================================================================
# TESTING
# ============================================================================

test: ## Run tests with 95% coverage threshold
	pnpm exec vitest run --coverage

# ============================================================================
# SECURITY
# ============================================================================

security: ## Security checks
	pnpm audit --audit-level=moderate || true

# ============================================================================
# NAMING CONVENTIONS
# ============================================================================

naming: ## Check naming conventions, abbreviations, and skip comments
	npx tsx scripts/check-naming-conventions.ts
	npx tsx scripts/check-abbreviations.ts
	npx tsx scripts/check-skip-comments.ts

# ============================================================================
# COMBINED CHECKS
# ============================================================================

check: lint test security naming ## All checks (lint + test + security + naming)

# ============================================================================
# SONARCLOUD
# ============================================================================

sonar: ## Run SonarCloud analysis
	@echo "Running SonarCloud analysis..."
	@SONAR_TOKEN=$$(op read "op://Engineering/SONAR_TOKEN/credential" 2>/dev/null || echo "$$SONAR_TOKEN") && \
	pnpm exec vitest run --coverage && \
	sonar-scanner -Dsonar.token=$$SONAR_TOKEN || echo "SonarCloud analysis failed (non-blocking)"

# ============================================================================
# SMOKE TEST
# ============================================================================

smoke: ## Smoke test against running proxy (requires Redis + proxy running)
	@bash scripts/smoke-test.sh

# ============================================================================
# FULL VALIDATION
# ============================================================================

check-all: check sonar ## Full validation (check + sonar) - required before commit

# ============================================================================
# FORMATTING
# ============================================================================

format: ## Auto-fix lint and format code
	pnpm exec eslint --fix --ext .ts src/
	pnpm exec prettier --write "src/**/*.ts" "tests/**/*.ts"

# ============================================================================
# CODE REVIEW
# ============================================================================

review: ## Run CodeRabbit AI review on uncommitted changes
	coderabbit review

# ============================================================================
# DEV COMMANDS
# ============================================================================

dev: lint-quick ## Dev server (enforces lint-quick first)
	pnpm exec tsx watch src/server.ts

dev-unsafe: ## Dev server (no checks - debugging only)
	pnpm exec tsx watch src/server.ts

# ============================================================================
# CDK / INFRASTRUCTURE
# ============================================================================

cdk-synth: ## Synthesize CDK CloudFormation templates
	cd infra && pnpm exec cdk synth

cdk-deploy: check ## Deploy CDK (requires all checks to pass)
	cd infra && pnpm exec cdk deploy --require-approval never

deploy: cdk-deploy ## Alias for cdk-deploy

# ============================================================================
# STANDARDS SYNC
# ============================================================================

sync-standards: ## Pull latest shared specs from sc0red-standards
	@if [ ! -d "../sc0red-standards" ]; then \
		echo "Cloning sc0red-standards..."; \
		git clone git@github.com:SC0RED/sc0red-standards.git ../sc0red-standards 2>/dev/null || \
		echo "Warning: Could not clone. Using local copy if available."; \
	fi
	@if [ -d "../sc0red-standards/specs" ]; then \
		for dir in ../sc0red-standards/specs/*/; do \
			domain=$$(basename "$$dir"); \
			mkdir -p "openspec/specs/$$domain"; \
			cp "$$dir/spec.md" "openspec/specs/$$domain/spec.md"; \
			echo "  Synced $$domain"; \
		done; \
		echo "Standards synced."; \
	else \
		echo "Error: sc0red-standards not found at ../sc0red-standards"; \
		exit 1; \
	fi

# ============================================================================
# HELP
# ============================================================================

help: ## Show this help message
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

.DEFAULT_GOAL := help
