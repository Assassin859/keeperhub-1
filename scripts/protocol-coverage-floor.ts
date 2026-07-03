/**
 * Executed-test floor for the protocol-coverage CI step.
 *
 * Every protocol suite self-skips when its infra gates (fork URLs,
 * funder key, database) are absent, so a green exit code can mean
 * "ran nothing" - which is how coverage silently collapsed to ~35
 * executed tests without anyone noticing. This script reads the vitest
 * JSON results, fails when the executed count drops below the floor,
 * and publishes run/skip counts to the GitHub step summary.
 *
 * Usage: tsx scripts/protocol-coverage-floor.ts <vitest.json> <floor>
 */

import { appendFileSync, readFileSync } from "node:fs";

function main(): void {
  const [file, floorArg] = process.argv.slice(2);
  if (!(file && floorArg)) {
    process.stderr.write(
      "usage: tsx scripts/protocol-coverage-floor.ts <vitest.json> <floor>\n"
    );
    process.exit(2);
  }
  const floor = Number(floorArg);
  if (!(Number.isFinite(floor) && floor >= 0)) {
    // NaN would make `executed < floor` always false, silently disabling
    // the guard - the exact failure mode this script exists to prevent.
    process.stderr.write(
      `invalid floor argument "${floorArg}": expected a non-negative number\n`
    );
    process.exit(2);
  }
  const raw = JSON.parse(readFileSync(file, "utf8")) as {
    testResults?: Array<{
      assertionResults?: Array<{ status: string }>;
    }>;
  };
  let executed = 0;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const tr of raw.testResults ?? []) {
    for (const a of tr.assertionResults ?? []) {
      if (a.status === "passed") {
        passed += 1;
        executed += 1;
      } else if (a.status === "failed") {
        failed += 1;
        executed += 1;
      } else {
        skipped += 1;
      }
    }
  }

  const summary = `Protocol coverage: executed ${executed} (passed ${passed}, failed ${failed}), skipped ${skipped}, floor ${floor}`;
  process.stdout.write(`${summary}\n`);
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    appendFileSync(
      summaryFile,
      `### Protocol coverage\n\n| Executed | Passed | Failed | Skipped | Floor |\n|---|---|---|---|---|\n| ${executed} | ${passed} | ${failed} | ${skipped} | ${floor} |\n`
    );
  }

  if (executed < floor) {
    process.stderr.write(
      `FAIL: executed ${executed} tests, below the floor of ${floor}. ` +
        "The suites are self-skipping - check the infra gates " +
        "(ANVIL_FORK_MAINNET_URL, TESTNET_FUNDER_PK, PROTOCOL_E2E_SEPOLIA_FORK, DATABASE_URL) " +
        "before trusting this green.\n"
    );
    process.exit(1);
  }
}

main();
