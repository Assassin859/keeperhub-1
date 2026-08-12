import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `server-only` throws on import outside a React Server Component, which is the
// whole point of the marker. Stub it so the guard stays in the source.
vi.mock("server-only", () => ({}));

// vi.mock is hoisted above the imports, so the gauge stubs have to be hoisted
// with it rather than declared as ordinary top-level consts.
const { processMemoryMetrics } = vi.hoisted(() => {
  const gauge = () => ({ set: vi.fn() });
  return {
    processMemoryMetrics: {
      rss: gauge(),
      heapUsed: gauge(),
      external: gauge(),
      arrayBuffers: gauge(),
      rssPeak: gauge(),
      heapUsedPeak: gauge(),
      externalPeak: gauge(),
      arrayBuffersPeak: gauge(),
    },
  };
});

// The real module pulls in prom-client and `server-only`. The sampler logic is
// what this suite covers, so the gauges are stubbed out entirely.
vi.mock("@/lib/metrics/collectors/prometheus", () => ({
  processMemoryMetrics,
}));

import {
  sampleProcessMemory,
  startProcessMemorySampler,
  stopProcessMemorySampler,
  updateProcessMemoryGauges,
} from "@/lib/metrics/instrumentation/process-memory";

type Usage = {
  rss: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
};

function usage(u: Usage): NodeJS.MemoryUsage {
  return {
    rss: u.rss,
    heapTotal: u.heapUsed * 2,
    heapUsed: u.heapUsed,
    external: u.external,
    arrayBuffers: u.arrayBuffers,
  };
}

function mockUsage(u: Usage): void {
  vi.spyOn(process, "memoryUsage").mockReturnValue(usage(u));
}

const BASE: Usage = {
  rss: 700,
  heapUsed: 300,
  external: 80,
  arrayBuffers: 40,
};

const SPIKE: Usage = {
  rss: 4000,
  heapUsed: 900,
  external: 2600,
  arrayBuffers: 2400,
};

describe("Process Memory Instrumentation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stopProcessMemorySampler();
    for (const g of Object.values(processMemoryMetrics)) {
      g.set.mockClear();
    }
  });

  afterEach(() => {
    stopProcessMemorySampler();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("peak tracking", () => {
    it("reports a spike that has already passed by the time of the scrape", () => {
      mockUsage(BASE);
      startProcessMemorySampler();

      // The spike opens and closes entirely between two scrapes.
      mockUsage(SPIKE);
      vi.advanceTimersByTime(2000);
      mockUsage(BASE);
      vi.advanceTimersByTime(2000);

      updateProcessMemoryGauges();

      expect(processMemoryMetrics.rss.set).toHaveBeenCalledWith(BASE.rss);
      expect(processMemoryMetrics.rssPeak.set).toHaveBeenCalledWith(SPIKE.rss);
      expect(processMemoryMetrics.arrayBuffersPeak.set).toHaveBeenCalledWith(
        SPIKE.arrayBuffers
      );
    });

    it("tracks each bucket independently", () => {
      mockUsage(BASE);
      startProcessMemorySampler();

      mockUsage({ ...BASE, external: 5000 });
      vi.advanceTimersByTime(1000);
      mockUsage({ ...BASE, heapUsed: 2500 });
      vi.advanceTimersByTime(1000);

      updateProcessMemoryGauges();

      expect(processMemoryMetrics.externalPeak.set).toHaveBeenCalledWith(5000);
      expect(processMemoryMetrics.heapUsedPeak.set).toHaveBeenCalledWith(2500);
      expect(processMemoryMetrics.rssPeak.set).toHaveBeenCalledWith(BASE.rss);
    });

    it("opens a new window on each export so an old spike does not persist", () => {
      mockUsage(BASE);
      startProcessMemorySampler();

      mockUsage(SPIKE);
      vi.advanceTimersByTime(1000);
      mockUsage(BASE);
      updateProcessMemoryGauges();

      expect(processMemoryMetrics.rssPeak.set).toHaveBeenLastCalledWith(
        SPIKE.rss
      );

      vi.advanceTimersByTime(2000);
      updateProcessMemoryGauges();

      expect(processMemoryMetrics.rssPeak.set).toHaveBeenLastCalledWith(
        BASE.rss
      );
    });

    it("never reports a peak below the instantaneous reading", () => {
      mockUsage(BASE);
      startProcessMemorySampler();
      updateProcessMemoryGauges();

      // No tick has run in the new window yet.
      mockUsage(SPIKE);
      updateProcessMemoryGauges();

      expect(processMemoryMetrics.rss.set).toHaveBeenLastCalledWith(SPIKE.rss);
      expect(processMemoryMetrics.rssPeak.set).toHaveBeenLastCalledWith(
        SPIKE.rss
      );
    });

    it("exports without a running sampler", () => {
      mockUsage(BASE);

      updateProcessMemoryGauges();

      expect(processMemoryMetrics.rss.set).toHaveBeenCalledWith(BASE.rss);
      expect(processMemoryMetrics.rssPeak.set).toHaveBeenCalledWith(BASE.rss);
    });
  });

  describe("sampler lifecycle", () => {
    it("starts one timer no matter how many scrapes call it", () => {
      mockUsage(BASE);
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

      startProcessMemorySampler();
      startProcessMemorySampler();
      startProcessMemorySampler();

      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    });

    it("unrefs the timer so it cannot hold the process open", () => {
      mockUsage(BASE);
      startProcessMemorySampler();
      const unref = vi.fn();
      const setIntervalSpy = vi
        .spyOn(globalThis, "setInterval")
        .mockReturnValue({ unref } as unknown as NodeJS.Timeout);

      stopProcessMemorySampler();
      startProcessMemorySampler();

      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(unref).toHaveBeenCalledTimes(1);
    });

    it("drops the running peak when stopped", () => {
      mockUsage(BASE);
      startProcessMemorySampler();
      mockUsage(SPIKE);
      sampleProcessMemory();

      stopProcessMemorySampler();

      mockUsage(BASE);
      updateProcessMemoryGauges();

      expect(processMemoryMetrics.rssPeak.set).toHaveBeenCalledWith(BASE.rss);
    });

    it("stops sampling after stopProcessMemorySampler", () => {
      mockUsage(BASE);
      startProcessMemorySampler();
      stopProcessMemorySampler();

      mockUsage(SPIKE);
      vi.advanceTimersByTime(5000);
      mockUsage(BASE);
      updateProcessMemoryGauges();

      expect(processMemoryMetrics.rssPeak.set).toHaveBeenCalledWith(BASE.rss);
    });
  });
});
