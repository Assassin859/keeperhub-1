/**
 * Process Memory Instrumentation
 *
 * Tracks Node.js process memory and exposes it as per-pod gauges.
 *
 * Why a sampler rather than a plain read at scrape time: prod containers have
 * been OOM-killed between two consecutive cadvisor samples, which are 60s
 * apart. A gauge read only when Prometheus scrapes has the same blind spot at
 * its own 30s interval - the allocation that crosses the limit starts and ends
 * inside one gap, so nothing records it. This module samples every second and
 * keeps a high-water mark, so a spike that lasts a few seconds still reaches
 * the scrape that follows it.
 *
 * Started lazily on the first /api/metrics/api scrape, the same way
 * startRpcHealthProbe() is.
 */

import "server-only";

import { processMemoryMetrics } from "../collectors/prometheus";

const SAMPLE_INTERVAL_MS = 1000;

type MemoryPeak = {
  rss: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
};

// Hot-reload safe: keep the timer and the running peak on globalThis so a dev
// restart does not spawn a second sampler or lose the window.
const globalForMemory = globalThis as unknown as {
  processMemoryTimer: ReturnType<typeof setInterval> | undefined;
  processMemoryPeak: MemoryPeak | undefined;
};

function readUsage(): MemoryPeak {
  const usage = process.memoryUsage();
  return {
    rss: usage.rss,
    heapUsed: usage.heapUsed,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
  };
}

function mergePeak(
  peak: MemoryPeak | undefined,
  sample: MemoryPeak
): MemoryPeak {
  if (!peak) {
    return sample;
  }
  return {
    rss: Math.max(peak.rss, sample.rss),
    heapUsed: Math.max(peak.heapUsed, sample.heapUsed),
    external: Math.max(peak.external, sample.external),
    arrayBuffers: Math.max(peak.arrayBuffers, sample.arrayBuffers),
  };
}

/**
 * Take one sample and fold it into the running peak.
 */
export function sampleProcessMemory(): void {
  globalForMemory.processMemoryPeak = mergePeak(
    globalForMemory.processMemoryPeak,
    readUsage()
  );
}

/**
 * Start the 1s sampler. Idempotent, so repeated scrapes do not stack timers.
 * The timer is unref'd, so it never keeps the process alive on its own.
 */
export function startProcessMemorySampler(): void {
  if (globalForMemory.processMemoryTimer !== undefined) {
    return;
  }

  sampleProcessMemory();
  globalForMemory.processMemoryTimer = setInterval(
    sampleProcessMemory,
    SAMPLE_INTERVAL_MS
  );
  globalForMemory.processMemoryTimer.unref();
}

/**
 * Stop the sampler and drop the running peak. Used by tests.
 */
export function stopProcessMemorySampler(): void {
  if (globalForMemory.processMemoryTimer !== undefined) {
    clearInterval(globalForMemory.processMemoryTimer);
    globalForMemory.processMemoryTimer = undefined;
  }
  globalForMemory.processMemoryPeak = undefined;
}

/**
 * Publish the current reading and the peak of the window that just ended, then
 * open a new window.
 *
 * The new window is seeded with the reading taken here rather than with zero,
 * so the peak gauges never report below the instantaneous ones when a scrape
 * lands before the first tick of the next window.
 */
export function updateProcessMemoryGauges(): void {
  const current = readUsage();
  const peak = mergePeak(globalForMemory.processMemoryPeak, current);

  processMemoryMetrics.rss.set(current.rss);
  processMemoryMetrics.heapUsed.set(current.heapUsed);
  processMemoryMetrics.external.set(current.external);
  processMemoryMetrics.arrayBuffers.set(current.arrayBuffers);

  processMemoryMetrics.rssPeak.set(peak.rss);
  processMemoryMetrics.heapUsedPeak.set(peak.heapUsed);
  processMemoryMetrics.externalPeak.set(peak.external);
  processMemoryMetrics.arrayBuffersPeak.set(peak.arrayBuffers);

  globalForMemory.processMemoryPeak = current;
}
