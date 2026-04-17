import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  buildEdgesBySource,
  buildEdgesByTarget,
  getReadyDownstreamIds,
  propagateConvergenceSkips,
  signalConvergenceArrival,
} from "@/lib/convergence-barrier";
import { buildEdgesBySourceHandle } from "@/lib/edge-handle-utils";

describe("convergence barrier", () => {
  describe("basic convergence: A -> [B, C, D] -> E", () => {
    const edges = [
      { source: "A", target: "B" },
      { source: "A", target: "C" },
      { source: "A", target: "D" },
      { source: "B", target: "E" },
      { source: "C", target: "E" },
      { source: "D", target: "E" },
    ];

    it("should detect E as a convergence node with 3 incoming edges", () => {
      const targetMap = buildEdgesByTarget(edges);
      const sources = targetMap.get("E");
      expect(sources).toEqual(["B", "C", "D"]);
      expect(sources?.length).toBe(3);
    });

    it("should block E when only first branch arrives", () => {
      const targetMap = buildEdgesByTarget(edges);
      const arrivals = new Map<string, Set<string>>();
      const visited = new Set<string>();

      const ready = getReadyDownstreamIds(
        "B",
        ["E"],
        targetMap,
        arrivals,
        visited
      );
      expect(ready).toEqual([]);
      expect(arrivals.get("E")?.size).toBe(1);
    });

    it("should block E when two branches have arrived", () => {
      const targetMap = buildEdgesByTarget(edges);
      const arrivals = new Map<string, Set<string>>();
      const visited = new Set<string>();

      getReadyDownstreamIds("B", ["E"], targetMap, arrivals, visited);
      const ready = getReadyDownstreamIds(
        "C",
        ["E"],
        targetMap,
        arrivals,
        visited
      );
      expect(ready).toEqual([]);
      expect(arrivals.get("E")?.size).toBe(2);
    });

    it("should release E when all three branches have arrived", () => {
      const targetMap = buildEdgesByTarget(edges);
      const arrivals = new Map<string, Set<string>>();
      const visited = new Set<string>();

      getReadyDownstreamIds("B", ["E"], targetMap, arrivals, visited);
      getReadyDownstreamIds("C", ["E"], targetMap, arrivals, visited);
      const ready = getReadyDownstreamIds(
        "D",
        ["E"],
        targetMap,
        arrivals,
        visited
      );
      expect(ready).toEqual(["E"]);
      expect(arrivals.get("E")?.size).toBe(3);
    });

    it("should not block non-convergence nodes", () => {
      const targetMap = buildEdgesByTarget(edges);
      const arrivals = new Map<string, Set<string>>();
      const visited = new Set<string>();

      const ready = getReadyDownstreamIds(
        "A",
        ["B", "C", "D"],
        targetMap,
        arrivals,
        visited
      );
      expect(ready).toEqual(["B", "C", "D"]);
    });
  });

  describe("mixed topology: A -> [B, C] -> E, A -> D -> F", () => {
    const edges = [
      { source: "A", target: "B" },
      { source: "A", target: "C" },
      { source: "A", target: "D" },
      { source: "B", target: "E" },
      { source: "C", target: "E" },
      { source: "D", target: "F" },
    ];

    it("should detect E as convergence (2 incoming) but not F (1 incoming)", () => {
      const targetMap = buildEdgesByTarget(edges);
      expect(targetMap.get("E")?.length).toBe(2);
      expect(targetMap.get("F")?.length).toBe(1);
    });

    it("should block E until both B and C arrive", () => {
      const targetMap = buildEdgesByTarget(edges);
      const arrivals = new Map<string, Set<string>>();
      const visited = new Set<string>();

      const first = getReadyDownstreamIds(
        "B",
        ["E"],
        targetMap,
        arrivals,
        visited
      );
      expect(first).toEqual([]);

      const second = getReadyDownstreamIds(
        "C",
        ["E"],
        targetMap,
        arrivals,
        visited
      );
      expect(second).toEqual(["E"]);
    });

    it("should not block F (single incoming edge from D)", () => {
      const targetMap = buildEdgesByTarget(edges);
      const arrivals = new Map<string, Set<string>>();
      const visited = new Set<string>();

      const ready = getReadyDownstreamIds(
        "D",
        ["F"],
        targetMap,
        arrivals,
        visited
      );
      expect(ready).toEqual(["F"]);
    });
  });

  describe("duplicate arrival from same source is idempotent", () => {
    const edges = [
      { source: "B", target: "E" },
      { source: "C", target: "E" },
    ];

    it("should not count duplicate arrivals from the same source", () => {
      const targetMap = buildEdgesByTarget(edges);
      const arrivals = new Map<string, Set<string>>();
      const visited = new Set<string>();

      getReadyDownstreamIds("B", ["E"], targetMap, arrivals, visited);
      getReadyDownstreamIds("B", ["E"], targetMap, arrivals, visited);
      const ready = getReadyDownstreamIds(
        "B",
        ["E"],
        targetMap,
        arrivals,
        visited
      );

      expect(ready).toEqual([]);
      expect(arrivals.get("E")?.size).toBe(1);
    });
  });

  describe("condition skip propagation", () => {
    it("should signal arrival at convergence node from skipped branch", () => {
      // Condition -> [true: B, false: C] -> E
      const edges = [
        { source: "Cond", target: "B" },
        { source: "Cond", target: "C" },
        { source: "B", target: "E" },
        { source: "C", target: "E" },
      ];
      const sourceMap = buildEdgesBySource(edges);
      const targetMap = buildEdgesByTarget(edges);
      const arrivals = new Map<string, Set<string>>();
      const visited = new Set<string>();

      // Condition takes true branch (B), skips false branch (C)
      const unblocked = propagateConvergenceSkips(
        ["C"],
        sourceMap,
        targetMap,
        arrivals,
        visited
      );

      // C's arrival at E was signaled, but E still needs B's arrival
      expect(unblocked).toEqual([]);
      expect(arrivals.get("E")?.has("C")).toBe(true);
      expect(arrivals.get("E")?.size).toBe(1);

      // Now B arrives at E
      const ready = getReadyDownstreamIds(
        "B",
        ["E"],
        targetMap,
        arrivals,
        visited
      );
      expect(ready).toEqual(["E"]);
    });

    it("should unblock convergence when skip is the last arrival", () => {
      // B already arrived, then C gets skipped
      const edges = [
        { source: "B", target: "E" },
        { source: "C", target: "E" },
      ];
      const sourceMap = buildEdgesBySource(edges);
      const targetMap = buildEdgesByTarget(edges);
      const arrivals = new Map<string, Set<string>>();
      const visited = new Set<string>();

      // B arrives first
      signalConvergenceArrival("B", ["E"], targetMap, arrivals, visited);
      expect(arrivals.get("E")?.size).toBe(1);

      // C gets skipped and propagation signals its arrival
      const unblocked = propagateConvergenceSkips(
        ["C"],
        sourceMap,
        targetMap,
        arrivals,
        visited
      );
      expect(unblocked).toEqual(["E"]);
    });

    it("should propagate through chain of non-convergence nodes to reach convergence", () => {
      // Cond -> [true: B, false: C -> D] -> E
      // C is skipped, D is downstream of C and leads to E
      const edges = [
        { source: "Cond", target: "B" },
        { source: "Cond", target: "C" },
        { source: "C", target: "D" },
        { source: "B", target: "E" },
        { source: "D", target: "E" },
      ];
      const sourceMap = buildEdgesBySource(edges);
      const targetMap = buildEdgesByTarget(edges);
      const arrivals = new Map<string, Set<string>>();
      const visited = new Set<string>();

      // Skip C, which chains through D to E
      const unblocked = propagateConvergenceSkips(
        ["C"],
        sourceMap,
        targetMap,
        arrivals,
        visited
      );

      // D is not a convergence node so skip propagates through it
      // E gets arrival from D (via skip chain)
      expect(arrivals.get("E")?.has("D")).toBe(true);
      expect(unblocked).toEqual([]);

      // B arrives at E, completing the barrier
      const ready = getReadyDownstreamIds(
        "B",
        ["E"],
        targetMap,
        arrivals,
        visited
      );
      expect(ready).toEqual(["E"]);
    });
  });

  describe("direct-skip edge into convergence node", () => {
    // Models the prod stall pattern:
    //   Cond -> true  -> X -> nodeB
    //   Cond -> false ------> nodeB   (direct skipped edge into convergence)
    // The direct not-taken edge from the condition must register a skip-arrival
    // at nodeB, otherwise nodeB stalls at 1/2 arrivals once X completes.
    const edges = [
      { source: "Cond", target: "X" },
      { source: "Cond", target: "nodeB" },
      { source: "X", target: "nodeB" },
    ];

    it("signals skip-arrival when condition's not-taken edge targets convergence directly", () => {
      const sourceMap = buildEdgesBySource(edges);
      const targetMap = buildEdgesByTarget(edges);
      const arrivals = new Map<string, Set<string>>();
      const visited = new Set<string>();

      // Condition=true: X is taken (runs), nodeB is the direct skipped target.
      // Caller pre-seeds condition's skip-arrival at direct skipped targets.
      signalConvergenceArrival(
        "Cond",
        ["nodeB"],
        targetMap,
        arrivals,
        visited
      );
      const unblocked = propagateConvergenceSkips(
        ["nodeB"],
        sourceMap,
        targetMap,
        arrivals,
        visited
      );

      expect(unblocked).toEqual([]);
      expect(arrivals.get("nodeB")?.has("Cond")).toBe(true);
      expect(arrivals.get("nodeB")?.size).toBe(1);

      // X completes and arrives at nodeB -- barrier should now release.
      const ready = getReadyDownstreamIds(
        "X",
        ["nodeB"],
        targetMap,
        arrivals,
        visited
      );
      expect(ready).toEqual(["nodeB"]);
    });

    it("releases convergence when condition=false takes direct edge and intermediate arrives via skip", () => {
      // Mirror case:
      //   Cond -> true  ------> nodeB   (direct taken edge into convergence)
      //   Cond -> false -> X -> nodeB
      const mirrorEdges = [
        { source: "Cond", target: "nodeB" },
        { source: "Cond", target: "X" },
        { source: "X", target: "nodeB" },
      ];
      const sourceMap = buildEdgesBySource(mirrorEdges);
      const targetMap = buildEdgesByTarget(mirrorEdges);
      const arrivals = new Map<string, Set<string>>();
      const visited = new Set<string>();

      // Cond takes direct edge to nodeB -- signalConvergenceArrival seeds
      // arrivals[nodeB] = {Cond}; nodeB not yet unblocked (1/2).
      const readyFromTake = getReadyDownstreamIds(
        "Cond",
        ["nodeB"],
        targetMap,
        arrivals,
        visited
      );
      expect(readyFromTake).toEqual([]);
      expect(arrivals.get("nodeB")?.size).toBe(1);

      // X is skipped; propagation walks X -> nodeB, adds X to arrivals.
      signalConvergenceArrival("Cond", ["X"], targetMap, arrivals, visited);
      const unblocked = propagateConvergenceSkips(
        ["X"],
        sourceMap,
        targetMap,
        arrivals,
        visited
      );
      expect(unblocked).toEqual(["nodeB"]);
    });

    it("does not corrupt deeper convergence when direct-skip target is still pending", () => {
      // Cond -> true  -> X -> nodeB -> J -> K
      // Cond -> false ------> nodeB
      // Y -----------------------------> K
      // nodeB is waiting on X. BFS must not walk through nodeB and falsely
      // register J as an arrival at K, otherwise Y's real arrival would
      // unblock K prematurely (before J has actually run).
      const deeperEdges = [
        { source: "Cond", target: "X" },
        { source: "Cond", target: "nodeB" },
        { source: "X", target: "nodeB" },
        { source: "nodeB", target: "J" },
        { source: "J", target: "K" },
        { source: "Y", target: "K" },
      ];
      const sourceMap = buildEdgesBySource(deeperEdges);
      const targetMap = buildEdgesByTarget(deeperEdges);
      const arrivals = new Map<string, Set<string>>();
      const visited = new Set<string>();

      signalConvergenceArrival(
        "Cond",
        ["nodeB"],
        targetMap,
        arrivals,
        visited
      );
      propagateConvergenceSkips(
        ["nodeB"],
        sourceMap,
        targetMap,
        arrivals,
        visited
      );

      // BFS must stop at the not-fully-resolved nodeB; K's arrivals stay empty.
      expect(arrivals.get("K")).toBeUndefined();

      // Y arrives first -- K must remain blocked until J (after nodeB, X) runs.
      const readyFromY = getReadyDownstreamIds(
        "Y",
        ["K"],
        targetMap,
        arrivals,
        visited
      );
      expect(readyFromY).toEqual([]);
      expect(arrivals.get("K")?.size).toBe(1);
    });
  });

  describe("chained conditions, each with a 5-node post-convergence chain", () => {
    // Realistic workflow shape that mirrors the production stall and verifies
    // that a long post-convergence chain drains all the way to the next
    // condition (and eventually End):
    //
    //   Cond1 -> true  -> Allow1 -> M1 (conv) -> D1a -> D2a -> D3a -> D4a -> Cond2
    //   Cond1 -> false ------------> M1
    //   Cond2 -> true  -> Allow2 -> M2 (conv) -> D1b -> D2b -> D3b -> D4b -> Cond3
    //   Cond2 -> false ------------> M2
    //   Cond3 -> true  -> Allow3 -> M3 (conv) -> D1c -> D2c -> D3c -> D4c -> End
    //   Cond3 -> false ------------> M3
    //
    // Each Mi has exactly 2 incoming edges (the condition's false handle +
    // the Allow_i "taken" node). After each convergence there is a chain of
    // five nodes (Mi, D1, D2, D3, D4) before the next condition -- this is
    // the topology the user explicitly asked to verify.
    const edges = [
      { source: "Cond1", target: "Allow1" },
      { source: "Cond1", target: "M1" },
      { source: "Allow1", target: "M1" },
      { source: "M1", target: "D1a" },
      { source: "D1a", target: "D2a" },
      { source: "D2a", target: "D3a" },
      { source: "D3a", target: "D4a" },
      { source: "D4a", target: "Cond2" },

      { source: "Cond2", target: "Allow2" },
      { source: "Cond2", target: "M2" },
      { source: "Allow2", target: "M2" },
      { source: "M2", target: "D1b" },
      { source: "D1b", target: "D2b" },
      { source: "D2b", target: "D3b" },
      { source: "D3b", target: "D4b" },
      { source: "D4b", target: "Cond3" },

      { source: "Cond3", target: "Allow3" },
      { source: "Cond3", target: "M3" },
      { source: "Allow3", target: "M3" },
      { source: "M3", target: "D1c" },
      { source: "D1c", target: "D2c" },
      { source: "D2c", target: "D3c" },
      { source: "D3c", target: "D4c" },
      { source: "D4c", target: "End" },
    ];

    type ConditionSpec = {
      id: string;
      value: boolean;
      trueTargets: string[];
      falseTargets: string[];
    };

    // End-to-end simulator that mirrors the executor's control flow:
    //   - For condition nodes: signal taken arrival, pre-seed skip arrivals at
    //     direct skipped convergence targets, propagate skip through not-taken
    //     subtree.
    //   - For non-condition nodes: getReadyDownstreamIds over downstream.
    // Returns the set of executed nodes in discovery order.
    function runSimulatedWorkflow(
      triggerReady: string[],
      conditions: Map<string, ConditionSpec>,
      edgesBySource: Map<string, string[]>,
      edgesByTarget: Map<string, string[]>
    ): { executed: string[]; visited: Set<string> } {
      const arrivals = new Map<string, Set<string>>();
      const visited = new Set<string>();
      const executed: string[] = [];
      const queue: string[] = [...triggerReady];

      while (queue.length > 0) {
        const nodeId = queue.shift() as string;
        if (visited.has(nodeId)) {
          continue;
        }
        visited.add(nodeId);
        executed.push(nodeId);

        const condSpec = conditions.get(nodeId);
        if (condSpec !== undefined) {
          const taken = condSpec.value
            ? condSpec.trueTargets
            : condSpec.falseTargets;
          const skipped = condSpec.value
            ? condSpec.falseTargets
            : condSpec.trueTargets;
          const readyFromTaken = getReadyDownstreamIds(
            nodeId,
            taken,
            edgesByTarget,
            arrivals,
            visited
          );
          const preSeed = signalConvergenceArrival(
            nodeId,
            skipped,
            edgesByTarget,
            arrivals,
            visited
          );
          const unblockedFromSkip = propagateConvergenceSkips(
            skipped,
            edgesBySource,
            edgesByTarget,
            arrivals,
            visited
          );
          for (const next of [
            ...readyFromTaken,
            ...preSeed,
            ...unblockedFromSkip,
          ]) {
            if (!visited.has(next)) {
              queue.push(next);
            }
          }
          continue;
        }

        const downstream = edgesBySource.get(nodeId) ?? [];
        const ready = getReadyDownstreamIds(
          nodeId,
          downstream,
          edgesByTarget,
          arrivals,
          visited
        );
        for (const next of ready) {
          if (!visited.has(next)) {
            queue.push(next);
          }
        }
      }

      return { executed, visited };
    }

    type Scenario = {
      name: string;
      cond1: boolean;
      cond2: boolean;
      cond3: boolean;
    };

    const scenarios: Scenario[] = [
      { name: "TTT", cond1: true, cond2: true, cond3: true },
      { name: "TTF", cond1: true, cond2: true, cond3: false },
      { name: "TFT", cond1: true, cond2: false, cond3: true },
      { name: "TFF", cond1: true, cond2: false, cond3: false },
      { name: "FTT", cond1: false, cond2: true, cond3: true },
      { name: "FTF", cond1: false, cond2: true, cond3: false },
      { name: "FFT", cond1: false, cond2: false, cond3: true },
      { name: "FFF", cond1: false, cond2: false, cond3: false },
    ];

    for (const scenario of scenarios) {
      it(`reaches End for scenario ${scenario.name} (Cond1=${scenario.cond1}, Cond2=${scenario.cond2}, Cond3=${scenario.cond3})`, () => {
        const sourceMap = buildEdgesBySource(edges);
        const targetMap = buildEdgesByTarget(edges);
        const conditions = new Map<string, ConditionSpec>([
          [
            "Cond1",
            {
              id: "Cond1",
              value: scenario.cond1,
              trueTargets: ["Allow1"],
              falseTargets: ["M1"],
            },
          ],
          [
            "Cond2",
            {
              id: "Cond2",
              value: scenario.cond2,
              trueTargets: ["Allow2"],
              falseTargets: ["M2"],
            },
          ],
          [
            "Cond3",
            {
              id: "Cond3",
              value: scenario.cond3,
              trueTargets: ["Allow3"],
              falseTargets: ["M3"],
            },
          ],
        ]);

        const { executed, visited } = runSimulatedWorkflow(
          ["Cond1"],
          conditions,
          sourceMap,
          targetMap
        );

        // End must be reached in every scenario -- this is the core correctness
        // claim: the stall bug is fixed and the graph drains to its sink.
        expect(visited.has("End")).toBe(true);
        expect(visited.has("M1")).toBe(true);
        expect(visited.has("M2")).toBe(true);
        expect(visited.has("M3")).toBe(true);

        // Each condition ran exactly once.
        expect(executed.filter((id) => id === "Cond1")).toHaveLength(1);
        expect(executed.filter((id) => id === "Cond2")).toHaveLength(1);
        expect(executed.filter((id) => id === "Cond3")).toHaveLength(1);

        // The 4-node post-convergence chain after each Mi must drain fully
        // in every scenario -- this is the core thing the user asked to
        // verify: the workflow keeps running all the way to the next
        // condition (and ultimately End) regardless of which branch each
        // condition took.
        for (const id of [
          "D1a",
          "D2a",
          "D3a",
          "D4a",
          "D1b",
          "D2b",
          "D3b",
          "D4b",
          "D1c",
          "D2c",
          "D3c",
          "D4c",
        ]) {
          expect(visited.has(id)).toBe(true);
        }

        // Allowance nodes (taken chain) run iff their condition was true.
        expect(visited.has("Allow1")).toBe(scenario.cond1);
        expect(visited.has("Allow2")).toBe(scenario.cond2);
        expect(visited.has("Allow3")).toBe(scenario.cond3);
      });
    }
  });

  describe("all-skip convergence should not execute", () => {
    it("should not unblock convergence node when all inputs are from skipped subtree", () => {
      // Cond -> [false: A -> B, false: A -> C] -> D (convergence)
      // Both B and C feed into D, all in the skipped subtree
      const edges = [
        { source: "Cond", target: "A" },
        { source: "A", target: "B" },
        { source: "A", target: "C" },
        { source: "B", target: "D" },
        { source: "C", target: "D" },
      ];
      const sourceMap = buildEdgesBySource(edges);
      const targetMap = buildEdgesByTarget(edges);
      const arrivals = new Map<string, Set<string>>();
      const visited = new Set<string>();

      // Skip A (the false branch root)
      const unblocked = propagateConvergenceSkips(
        ["A"],
        sourceMap,
        targetMap,
        arrivals,
        visited
      );

      // D should NOT be unblocked -- all its inputs are from skipped nodes
      expect(unblocked).toEqual([]);
    });

    it("should unblock convergence node when at least one input is from real execution", () => {
      // Real: X executes and arrives at D
      // Skip: B is skipped and propagates to D
      const edges = [
        { source: "B", target: "D" },
        { source: "X", target: "D" },
      ];
      const sourceMap = buildEdgesBySource(edges);
      const targetMap = buildEdgesByTarget(edges);
      const arrivals = new Map<string, Set<string>>();
      const visited = new Set<string>();

      // X arrives at D via real execution
      signalConvergenceArrival("X", ["D"], targetMap, arrivals, visited);

      // B gets skipped
      const unblocked = propagateConvergenceSkips(
        ["B"],
        sourceMap,
        targetMap,
        arrivals,
        visited
      );

      // D should be unblocked -- X was a real arrival
      expect(unblocked).toEqual(["D"]);
    });

    it("should propagate skip through fully-skipped convergence nodes to downstream", () => {
      // Cond -> [false: A -> B] and [false: A -> C] -> D (convergence) -> E
      // D is all-skip, so skip should continue to E
      const edges = [
        { source: "Cond", target: "A" },
        { source: "A", target: "B" },
        { source: "A", target: "C" },
        { source: "B", target: "D" },
        { source: "C", target: "D" },
        { source: "D", target: "E" },
        { source: "X", target: "E" },
      ];
      const sourceMap = buildEdgesBySource(edges);
      const targetMap = buildEdgesByTarget(edges);
      const arrivals = new Map<string, Set<string>>();
      const visited = new Set<string>();

      // X arrives at E via real execution first
      signalConvergenceArrival("X", ["E"], targetMap, arrivals, visited);

      // Skip A -- should propagate through B, C, D (all-skip), then reach E
      const unblocked = propagateConvergenceSkips(
        ["A"],
        sourceMap,
        targetMap,
        arrivals,
        visited
      );

      // E should be unblocked (X was real, D arrival was skip-propagated)
      expect(unblocked).toEqual(["E"]);
    });
  });

  describe("failure signaling at convergence nodes", () => {
    it("should allow signaling arrival for failed nodes", () => {
      // A -> [B, C] -> E where B fails
      const edges = [
        { source: "B", target: "E" },
        { source: "C", target: "E" },
      ];
      const targetMap = buildEdgesByTarget(edges);
      const arrivals = new Map<string, Set<string>>();
      const visited = new Set<string>();

      // B fails: signal arrival at E (same call the catch block makes)
      signalConvergenceArrival("B", ["E"], targetMap, arrivals, visited);

      // C completes and triggers barrier check
      const ready = getReadyDownstreamIds(
        "C",
        ["E"],
        targetMap,
        arrivals,
        visited
      );
      expect(ready).toEqual(["E"]);
    });
  });

  describe("duplicate edge deduplication", () => {
    it("should not inflate convergence threshold from duplicate edges", () => {
      const edges = [
        { source: "A", target: "B" },
        { source: "A", target: "B" },
        { source: "A", target: "B" },
        { source: "A", target: "B" },
        { source: "A", target: "B" },
        { source: "C", target: "B" },
      ];
      const targetMap = buildEdgesByTarget(edges);
      const arrivals = new Map<string, Set<string>>();
      const visited = new Set<string>();

      // B has 2 unique sources (A, C), not 6
      expect(targetMap.get("B")).toEqual(["A", "C"]);

      // A arrives
      getReadyDownstreamIds("A", ["B"], targetMap, arrivals, visited);
      expect(arrivals.get("B")?.size).toBe(1);

      // C arrives -- barrier should unblock
      const ready = getReadyDownstreamIds(
        "C",
        ["B"],
        targetMap,
        arrivals,
        visited
      );
      expect(ready).toEqual(["B"]);
    });

    it("buildEdgesByTarget returns deduplicated source arrays", () => {
      const edges = [
        { source: "X", target: "Y" },
        { source: "X", target: "Y" },
        { source: "Z", target: "Y" },
      ];
      const targetMap = buildEdgesByTarget(edges);
      expect(targetMap.get("Y")).toEqual(["X", "Z"]);
    });

    it("buildEdgesBySource returns deduplicated target arrays", () => {
      const edges = [
        { source: "A", target: "B" },
        { source: "A", target: "B" },
        { source: "A", target: "C" },
      ];
      const sourceMap = buildEdgesBySource(edges);
      expect(sourceMap.get("A")).toEqual(["B", "C"]);
    });

    it("buildEdgesBySourceHandle deduplicates targets per handle", () => {
      const edges = [
        { source: "Cond", target: "B", sourceHandle: "true" },
        { source: "Cond", target: "B", sourceHandle: "true" },
        { source: "Cond", target: "C", sourceHandle: "false" },
        { source: "Cond", target: "C", sourceHandle: "false" },
        { source: "Cond", target: "C", sourceHandle: "false" },
      ];
      const handleMap = buildEdgesBySourceHandle(edges);
      const condHandles = handleMap.get("Cond");
      expect(condHandles?.get("true")).toEqual(["B"]);
      expect(condHandles?.get("false")).toEqual(["C"]);
    });
  });
});
