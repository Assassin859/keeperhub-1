# Code Sandbox Scaling Notes

Reference for deciding how to scale the `keeperhub-sandbox` service. Captures
what bounds today's capacity, the options, and their cost so the pod sizing
call can be made on data rather than guesswork.

## What exists today

The sandbox runs user Code-node JavaScript. Each `/run` request spawns a fresh
Node child process (`sandbox/src/run-code.ts`), runs the user code with a
wall-clock timeout (default 60s, max 120s), and returns the result.

Concurrency is gated per pod by an in-flight counter
(`sandbox/src/index.ts`). When in-flight runs reach the cap, the pod sheds
load with `429 sandbox at capacity` plus `Retry-After: 1`, before it reads the
body or spawns a child (so a shed request is cheap on the server).

Current numbers:

- Per-pod cap: `DEFAULT_MAX_CONCURRENT_RUNS = 8`, overridable via
  `SANDBOX_MAX_CONCURRENT_RUNS`.
- Prod `replicaCount: 2`, so effective cluster ceiling is `8 x 2 = 16`
  concurrent runs. Staging runs 1 replica (ceiling 8).
- Per-pod resources: requests `100m / 128Mi`, limits `500m / 512Mi`.
- Pods are pinned to a dedicated, taint-isolated Karpenter nodepool.

## What actually binds the limit

The `8` is CPU derived, not arbitrary, and memory is a secondary risk:

- CPU: `500m` is half a core. Eight concurrent child processes, each paying an
  ~80ms V8 startup and compile cost, already oversubscribe it. Raising
  concurrency without raising CPU trades 429s for slow runs and wall-clock
  timeouts, which is worse for the caller.
- Memory: at 8 runs of roughly 60MB baseline each, a pod sits near 480MB of its
  512Mi limit before user code allocates anything. There is no per-run heap
  cap, so one run can grow until the pod-wide cgroup OOM-kills the container,
  taking every in-flight run on that pod down with it.

Cost is driven by Kubernetes requests, not limits, because Karpenter bin-packs
on requests. Today's requests are tiny, so the whole service is effectively one
small mostly-idle node.

## Per concurrent run, the cost model

One concurrent slot is one full Node process:

- About 60 to 65m of CPU to hold the 8-per-500m ratio.
- About 60MB of baseline memory plus whatever headroom user code needs.
- No isolation beyond the OS process, one shared pod cgroup.

To raise concurrency reliably, move CPU and memory together and keep those
ratios. Sixteen runs per pod means roughly 1000m CPU and 1Gi memory.

## Options

### 1. Client retry on 429 (shipping in the linked PR)

The main-app client now honors the `Retry-After` the sandbox already sends:
bounded retries (default 3, via `SANDBOX_MAX_RETRIES`) with jitter, abort-aware.
Only a capacity 429 is retried since the run never started, so resending is
safe. Any other failure is terminal.

- Cost: zero infra. The retry runs in the main app over the existing keep-alive
  socket, and only fires on a 429.
- Buys: absorbs sub-second micro-bursts (the overshoot cases) so they never
  surface to the customer. Does not add capacity. Pairs with autoscaling by
  covering the seconds while a new pod becomes ready.

### 2. Vertical, burstable (raise limits only)

Set per-pod limits to `1000m / 1Gi`, leave requests at `100m / 128Mi`.

- Cost: about zero. Requests unchanged, so bin-packing and the node footprint do
  not change.
- Behavior: 16 per pod works only when the node happens to have spare CPU. Under
  contention the kernel throttles the pod back toward its 100m request, so the
  16 runs crawl. Burstable, not guaranteed.

### 3. Vertical, guaranteed (raise requests to match limits)

Set requests and limits both to `1000m / 1Gi`.

- Cost: roughly +45 to +90 per month. Karpenter must reserve about 2 vCPU and
  2Gi for the two pods, forcing a larger node that is paid for 24/7 even when
  the sandbox is idle.
- Behavior: 16 per pod always has the CPU reserved, predictable under load.
- Downside: the reservation is sized for peak but the sandbox is mostly idle, so
  you pay for headroom that sits unused most of the time. Still a fixed ceiling;
  33 concurrent runs still hit 429, and one pod crash now drops 16 runs.

### 4. Horizontal autoscaling (the durable answer)

Keep pods at their current size. Scale replicas on saturation, not CPU.

- The 429 is fired by the in-flight concurrency counter, which does not track
  CPU or memory utilization. Code nodes are frequently I/O bound (user code
  awaits external `fetch`), so a pod can be at full slots and shedding 429s
  while CPU sits at 30 to 40 percent. A CPU based autoscaler would miss exactly
  the moment capacity is needed.
- Correct signal: pool saturation (`inFlightRuns / max`) or the 429 rate. The
  sandbox already tracks `inFlightRuns` via `getInFlightRuns()`; it just needs a
  `/metrics` endpoint to expose it, then KEDA or an HPA custom metric scaling on
  it (target around 70 percent), with CPU as a secondary trigger.
- Shape: `minReplicas: 2` for a small always-on floor, scale out during bursts,
  scale back down after. Aggressive scale-up, conservative scale-down to avoid
  flapping.
- Cost: tracks actual load. You pay the small floor when idle and burst capacity
  only while a burst is happening, instead of reserving peak around the clock.
- Caveat: HPA plus pod cold start is 30 to 60s, while bursts are sub-second, so
  option 1 (the retry) is what bridges the gap until a new pod is ready.

### 5. Per-run heap cap (do regardless)

Add `--max-old-space-size` to the child spawn so one run that balloons fails
itself rather than OOM-killing the pod and every run on it. Also keeps a pod
OOM from muddying the autoscaler signal. Small change, unconditionally correct.

## Recommendation

Layered, by value per effort:

1. Client 429 retry. Zero cost, removes most customer-visible errors. Shipping
   now.
2. Per-child heap cap. Removes the pod-wide OOM blast radius.
3. Memory limit bump `512Mi` to `1Gi`. Free (limit only), buys real headroom per
   pod.
4. Saturation-based autoscaling with `minReplicas: 2`. The real capacity fix,
   sized to load instead of a fixed reservation. Needs the `/metrics` endpoint
   first.

Vertical scaling (options 2 and 3) is a reasonable stopgap if a quick bump is
wanted, but it is a taller fixed wall, not elastic, and the guaranteed variant
pays for idle peak capacity. Prefer horizontal.

Before locking the autoscaler `maxReplicas` and saturation target, pull the
actual peak concurrent runs and current 429 rate from metrics and Sentry. The
numbers above are sized from the resource model, not live demand.
