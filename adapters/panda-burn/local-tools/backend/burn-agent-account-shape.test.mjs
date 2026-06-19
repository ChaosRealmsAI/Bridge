import assert from "node:assert/strict";
import { test } from "node:test";

import {
  availabilityQuotaSummary,
  emptyAvailabilityQuota,
  withQuotaWindowFields,
} from "./burn-agent-account-shape.mjs";

test("quota summary exposes 5h and weekly remaining fields without losing used fields", () => {
  const quota = withQuotaWindowFields({
    source_kind: "fixture",
    authoritative: true,
    live_status: "live",
    allowed: true,
    plan_type: "pro",
    remaining_display: "40%",
    windows: [
      {
        limit_id: "five_hour",
        kind: "primary",
        used_percent: 60,
        remaining_percent: 40,
        window_minutes: 300,
        resets_at: "2026-06-20T05:00:00.000Z",
      },
      {
        limit_id: "seven_day",
        kind: "secondary",
        used_percent: 25,
        remaining_percent: 75,
        window_minutes: 10080,
        resets_at: "2026-06-27T00:00:00.000Z",
      },
    ],
  });

  assert.equal(quota.five_hour_remaining_display, "40%");
  assert.equal(quota.five_hour_resets_at, "2026-06-20T05:00:00.000Z");
  assert.equal(quota.weekly_remaining_display, "75%");
  assert.equal(quota.weekly_resets_at, "2026-06-27T00:00:00.000Z");
  assert.equal(quota.windows[0].used_percent, 60);
  assert.equal(quota.windows[0].remaining_percent, 40);
  assert.equal(quota.windows[1].used_percent, 25);
  assert.equal(quota.windows[1].remaining_percent, 75);
});

test("quota summary chooses the tightest remaining window for duplicate window durations", () => {
  const summary = availabilityQuotaSummary({
    windows: [
      { limit_id: "five_hour_a", remaining_percent: 90, window_minutes: 300 },
      { limit_id: "five_hour_b", remaining_percent: 35, window_minutes: 300 },
      { limit_id: "weekly_a", remaining_percent: 70, window_minutes: 10080 },
      { limit_id: "weekly_b", remaining_percent: 20, window_minutes: 10080 },
    ],
  });

  assert.equal(summary.five_hour_remaining_display, "35%");
  assert.equal(summary.weekly_remaining_display, "20%");
});

test("unknown quota keeps fields present but empty", () => {
  const quota = emptyAvailabilityQuota({
    source_kind: "claude_local_auth_status",
    live_status: "subscription_status_only",
    allowed: true,
  });

  assert.equal(quota.five_hour_remaining_display, "");
  assert.equal(quota.five_hour_resets_at, "");
  assert.equal(quota.weekly_remaining_display, "");
  assert.equal(quota.weekly_resets_at, "");
  assert.deepEqual(quota.windows, []);
});
