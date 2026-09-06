#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
# Dedicated disposable containers: see the test guard; never use a production .env here.
export DATABASE_URL=postgresql://postgres:serika-ui184-test@127.0.0.1:55492/serika_ui184_test
export REDIS_URL=redis://127.0.0.1:65492/0
export SESSION_JWT_SECRET=local-social-test-session-key
export INSTANCE_TICKET_SECRET=local-social-test-ticket-key
export ACCOUNTS_INTERNAL_KEY=local-social-test-accounts-key
export SERIKA_SOCIAL_INTEGRATION=1
bun test api/src/default-home.test.ts api/test/home-instance.test.ts gateway/src/instance-admission.test.ts
