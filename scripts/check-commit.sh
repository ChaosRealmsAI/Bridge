#!/usr/bin/env bash
set -euo pipefail

echo "check-commit: release contract"
npm run check:release-contract

echo "check-commit: open-source hygiene"
npm run check:open-source
