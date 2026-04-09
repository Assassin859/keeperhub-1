// Production load test — real scheduler + manual triggers, 7 escalating tiers.
//
// 20 VUs. Each VU creates workflows in tiers: 10, 25, 50, 75, 100, 200, 500.
// ~75% Schedule (triggered by real scheduler-dispatcher every minute)
// ~25% Manual (triggered by k6 via service key every minute)
//
// Between tiers, VUs re-authenticate to avoid session expiry.
// Execution counting tracks IDs to avoid double-counting across tiers.
//
// k6 run execution-load-test.js \
//   -e BASE_URL=https://app-pr-663.keeperhub.com \
//   -e TEST_API_KEY=placeholder -e SERVICE_KEY=<key> \
//   -e CF_ACCESS_CLIENT_ID=... -e CF_ACCESS_CLIENT_SECRET=...

import http from "k6/http";
import { sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";
import exec from "k6/execution";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const TEST_API_KEY = __ENV.TEST_API_KEY || "";
const CF_ID = __ENV.CF_ACCESS_CLIENT_ID || "";
const CF_SECRET = __ENV.CF_ACCESS_CLIENT_SECRET || "";
const SERVICE_KEY = __ENV.SERVICE_KEY || "";
const TARGET_VUS = parseInt(__ENV.TARGET_VUS || "20", 10);
const OBSERVE_SECONDS = parseInt(__ENV.OBSERVE_SECONDS || "180", 10);
const PASSWORD = "K6LoadTest!2024";
const TIERS = (__ENV.TIERS || "10,25,50,75,100,200,500").split(",").map(Number);

// Metrics
const execSuccess = new Counter("exec_success");
const execError = new Counter("exec_error");
const execRate = new Rate("exec_success_rate");
const execDur = new Trend("exec_duration_ms", true);
const manualTriggerOk = new Counter("manual_trigger_ok");
const manualTriggerFail = new Counter("manual_trigger_fail");

// Scenario
const rampSec = TARGET_VUS * 5;
const holdSec = TIERS.length * (OBSERVE_SECONDS + 120) + 300;
export const options = {
  scenarios: {
    load: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: `${rampSec}s`, target: TARGET_VUS },
        { duration: `${holdSec}s`, target: TARGET_VUS },
      ],
      gracefulStop: "120s",
    },
  },
  thresholds: {
    exec_success_rate: [{ threshold: "rate>0.90", abortOnFail: false }],
  },
};

// Headers
function h() {
  const hd = { "Content-Type": "application/json", Origin: BASE_URL, Referer: `${BASE_URL}/` };
  if (TEST_API_KEY) hd["X-Test-API-Key"] = TEST_API_KEY;
  if (CF_ID) hd["CF-Access-Client-Id"] = CF_ID;
  if (CF_SECRET) hd["CF-Access-Client-Secret"] = CF_SECRET;
  return hd;
}
function adminH() { const hd = h(); if (TEST_API_KEY) hd["Authorization"] = `Bearer ${TEST_API_KEY}`; return hd; }
function serviceH() { const hd = h(); if (SERVICE_KEY) hd["X-Service-Key"] = SERVICE_KEY; return hd; }

// Workflow node builders
function act(id, x, y) {
  return { id, type: "action", position: { x, y }, data: { type: "action", label: id, config: {
    actionType: "HTTP Request", endpoint: `${BASE_URL}/api/health`,
    httpMethod: "GET", httpHeaders: "{}", httpBody: "{}" } } };
}
function cnd(id, x, y) {
  return { id, type: "action", position: { x, y }, data: { type: "action", label: id, config: {
    actionType: "Condition", condition: "1 === 1" } } };
}
function sched() {
  return { id: "t", type: "trigger", position: { x: 0, y: 0 }, data: { type: "trigger", label: "Schedule",
    config: { triggerType: "Schedule", scheduleCron: "* * * * *", scheduleTimezone: "UTC" } } };
}
function manual() {
  return { id: "t", type: "trigger", position: { x: 0, y: 0 }, data: { type: "trigger", label: "Manual",
    config: { triggerType: "Manual" } } };
}
function e(id, s, t) { return { id, source: s, target: t, type: "default" }; }

// 10 patterns: 7 Schedule + 3 Manual (~75/25)
const PATTERNS = [
  { trig: sched, n: (t) => [t(), act("a1",200,0)], e: [e("e1","t","a1")], type: "Schedule" },
  { trig: sched, n: (t) => [t(), act("a1",200,0), cnd("c1",400,0), act("a2",600,0)],
    e: [e("e1","t","a1"), e("e2","a1","c1"), e("e3","c1","a2")], type: "Schedule" },
  { trig: sched, n: (t) => [t(), cnd("c1",200,0), act("a1",400,0)],
    e: [e("e1","t","c1"), e("e2","c1","a1")], type: "Schedule" },
  { trig: sched, n: (t) => [t(), act("a1",200,-50), act("a2",200,50), cnd("c1",400,-50), cnd("c2",400,50), act("a3",600,-50), act("a4",600,50)],
    e: [e("e1","t","a1"), e("e2","t","a2"), e("e3","a1","c1"), e("e4","a2","c2"), e("e5","c1","a3"), e("e6","c2","a4")], type: "Schedule" },
  { trig: sched, n: (t) => [t(), act("a1",200,0), act("a2",400,0), act("a3",600,0)],
    e: [e("e1","t","a1"), e("e2","a1","a2"), e("e3","a2","a3")], type: "Schedule" },
  { trig: sched, n: (t) => [t(), act("a1",200,0), cnd("c1",400,0), act("a2",600,-50), act("a3",600,50)],
    e: [e("e1","t","a1"), e("e2","a1","c1"), e("e3","c1","a2"), e("e4","c1","a3")], type: "Schedule" },
  { trig: sched, n: (t) => [t(), act("a1",200,0)], e: [e("e1","t","a1")], type: "Schedule" },
  { trig: manual, n: (t) => [t(), act("a1",200,0)], e: [e("e1","t","a1")], type: "Manual" },
  { trig: manual, n: (t) => [t(), act("a1",200,0), cnd("c1",400,0), act("a2",600,0)],
    e: [e("e1","t","a1"), e("e2","a1","c1"), e("e3","c1","a2")], type: "Manual" },
  { trig: manual, n: (t) => [t(), act("a1",200,0), act("a2",400,0), act("a3",600,0)],
    e: [e("e1","t","a1"), e("e2","a1","a2"), e("e3","a2","a3")], type: "Manual" },
];

// Per-VU state
let myEmail = "";
let allWfIds = [];
let manualWfIds = [];
let countedExecIds = {};
let completedTiers = 0;

function retryPost(url, body, max) {
  for (let a = 1; a <= max; a++) {
    const r = http.post(url, body, { headers: h() });
    if (r.status === 200) return r;
    if (r.status === 429) { sleep(a * 5); continue; }
    return r;
  }
  return { status: 0, body: "retries exhausted" };
}

function authenticate() {
  const v = exec.vu.idInTest;

  if (!myEmail) {
    // First time: signup + verify
    myEmail = `k6-vu${v}-${Date.now()}@techops.services`;
    const su = retryPost(`${BASE_URL}/api/auth/sign-up/email`,
      JSON.stringify({ email: myEmail, password: PASSWORD, name: `k6-${v}` }), 5);
    if (su.status !== 200) { console.error(`VU${v}: signup ${su.status}`); return false; }
    sleep(1);

    let otp = null;
    for (let i = 0; i < 10; i++) {
      const r = http.get(`${BASE_URL}/api/admin/test/otp?email=${encodeURIComponent(myEmail)}`, { headers: adminH() });
      if (r.status === 200) { otp = JSON.parse(r.body).otp; break; }
      sleep(1);
    }
    if (!otp) { console.error(`VU${v}: no OTP`); return false; }

    const vr = retryPost(`${BASE_URL}/api/auth/email-otp/verify-email`,
      JSON.stringify({ email: myEmail, otp }), 5);
    if (vr.status !== 200) { console.error(`VU${v}: verify ${vr.status}`); return false; }
  }

  // Sign in (works for both first time and re-auth)
  const sr = retryPost(`${BASE_URL}/api/auth/sign-in/email`,
    JSON.stringify({ email: myEmail, password: PASSWORD }), 5);
  if (sr.status !== 200) { console.error(`VU${exec.vu.idInTest}: signin ${sr.status}`); return false; }
  return true;
}

function createWorkflows(count) {
  const v = exec.vu.idInTest;
  let created = 0;
  const startIdx = allWfIds.length;

  for (let w = 0; w < count; w++) {
    const pIdx = (startIdx + w) % PATTERNS.length;
    const p = PATTERNS[pIdx];
    const nm = `k6-vu${v}-t${completedTiers}-w${startIdx + w}`;

    const cr = http.post(`${BASE_URL}/api/workflows/create`,
      JSON.stringify({ name: nm, description: "load test", nodes: p.n(p.trig), edges: p.e }), { headers: h() });
    if (cr.status !== 200) {
      console.error(`VU${v}: wf create failed ${cr.status}`);
      continue;
    }

    const wfId = JSON.parse(cr.body).id;

    // Enable via admin (creates schedule record)
    const en = http.post(`${BASE_URL}/api/admin/test/enable-workflow`,
      JSON.stringify({ workflowId: wfId }), { headers: adminH() });
    if (en.status !== 200) {
      console.error(`VU${v}: enable failed ${en.status}`);
      continue;
    }

    allWfIds.push({ id: wfId, type: p.type });
    if (p.type === "Manual") manualWfIds.push(wfId);
    created++;
  }

  console.log(`VU${v}: created ${created} workflows (total: ${allWfIds.length}, manual: ${manualWfIds.length})`);
}

function triggerManuals() {
  for (const wfId of manualWfIds) {
    const r = http.post(`${BASE_URL}/api/workflow/${wfId}/execute`, JSON.stringify({}), { headers: serviceH() });
    if (r.status === 200 || r.status === 201) manualTriggerOk.add(1);
    else manualTriggerFail.add(1);
  }
}

function collectNewResults(tier) {
  const v = exec.vu.idInTest;
  let s = 0, er = 0, tot = 0;

  for (const wf of allWfIds) {
    const r = http.get(`${BASE_URL}/api/workflows/${wf.id}/executions`, { headers: serviceH() });
    if (r.status !== 200) continue;

    let execs;
    try { execs = JSON.parse(r.body); } catch { continue; }
    if (!Array.isArray(execs)) continue;

    for (const ex of execs) {
      // Skip already counted
      if (countedExecIds[ex.id]) continue;

      if (ex.status === "success") {
        s++; tot++; execSuccess.add(1); execRate.add(true);
        if (ex.duration) execDur.add(parseFloat(ex.duration));
        countedExecIds[ex.id] = true;
      } else if (ex.status === "error") {
        er++; tot++; execError.add(1); execRate.add(false);
        countedExecIds[ex.id] = true;
      }
      // Skip pending/running — not done yet
    }
  }

  const pct = tot > 0 ? Math.round(100 * s / tot) : 0;
  console.log(`VU${v}: TIER ${tier} wf/vu | ${tot} new executions | ${s} success | ${er} error | ${pct}% | ${allWfIds.length} workflows`);
}

// Main loop
export default function () {
  // Authenticate (first time: signup+verify+signin, subsequent: re-signin)
  if (!myEmail || completedTiers > 0) {
    const ok = authenticate();
    if (!ok) { sleep(30); return; }
    if (completedTiers === 0) {
      console.log(`VU${exec.vu.idInTest}: authenticated`);
    }
  }

  if (completedTiers >= TIERS.length) {
    sleep(30);
    return;
  }

  const tierTarget = TIERS[completedTiers];
  const toCreate = tierTarget - allWfIds.length;

  if (toCreate > 0) {
    createWorkflows(toCreate);
  }

  // Observe: trigger manuals every 60s, scheduler-dispatcher handles schedules.
  // Assumes the scheduler poll interval is <= ~60s so newly-enabled schedules
  // fire at least twice within OBSERVE_SECONDS (default 180s). If the dispatcher
  // poll interval is increased, raise OBSERVE_SECONDS proportionally or this
  // test will silently under-count successful executions per tier.
  console.log(`VU${exec.vu.idInTest}: TIER ${tierTarget} | observing ${OBSERVE_SECONDS}s | ${allWfIds.length} total | ${manualWfIds.length} manual`);

  const startTime = Date.now();
  while ((Date.now() - startTime) / 1000 < OBSERVE_SECONDS) {
    triggerManuals();
    const elapsed = (Date.now() - startTime) / 1000;
    const waitTime = Math.min(60, OBSERVE_SECONDS - elapsed);
    if (waitTime > 0) sleep(waitTime);
  }

  sleep(15);
  collectNewResults(tierTarget);
  completedTiers++;
}

// Teardown
export function teardown() {
  console.log("Cleaning up...");
  const r = http.post(`${BASE_URL}/api/admin/test/cleanup`, JSON.stringify({}), { headers: adminH() });
  if (r.status === 200) {
    try {
      const d = JSON.parse(r.body).deleted;
      console.log(`Cleaned: ${d.users} users, ${d.workflows} workflows`);
    } catch {
      console.log(`Cleanup response: ${r.body}`);
    }
  } else {
    console.error(`Cleanup failed: ${r.status}`);
  }
}
