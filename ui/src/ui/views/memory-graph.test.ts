/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderMemoryGraph, type MemoryGraphProps } from "./memory-graph.ts";

function createProps(overrides: Partial<MemoryGraphProps> = {}): MemoryGraphProps {
  return {
    selectedAgentId: "main",
    agentOptions: [{ id: "main", label: "Main" }],
    loading: false,
    statusError: null,
    wikiLoading: false,
    wikiError: null,
    shortTermEntries: [
      {
        key: "alpha",
        path: "memory/2026-06-26.md",
        startLine: 1,
        endLine: 2,
        snippet: "Matt wants the memory graph dashboard ported.",
        recallCount: 2,
        dailyCount: 1,
        groundedCount: 0,
        totalSignalCount: 3,
        lightHits: 1,
        remHits: 0,
        phaseHitCount: 1,
      },
    ],
    promotedEntries: [
      {
        key: "bravo",
        path: "MEMORY.md",
        startLine: 10,
        endLine: 14,
        snippet: "Use builtin memory first before adding an adjunct graph store.",
        recallCount: 4,
        dailyCount: 0,
        groundedCount: 1,
        totalSignalCount: 5,
        lightHits: 0,
        remHits: 1,
        phaseHitCount: 1,
      },
    ],
    shortTermCount: 1,
    promotedTotal: 1,
    totalSignalCount: 8,
    wikiMemoryPalace: {
      totalItems: 1,
      totalPages: 1,
      pageCounts: { entity: 1, concept: 0, source: 0, synthesis: 0, report: 0 },
      totalClaims: 1,
      totalQuestions: 1,
      totalContradictions: 0,
      clusters: [
        {
          key: "entity",
          label: "Entities",
          itemCount: 1,
          claimCount: 1,
          questionCount: 1,
          contradictionCount: 0,
          items: [
            {
              pagePath: "wiki/matt.md",
              title: "Matt Wallace",
              kind: "entity",
              claimCount: 1,
              questionCount: 1,
              contradictionCount: 0,
              claims: ["Matt asked for the dashboard port."],
              questions: ["Should PyKEEN become an adjunct store?"],
              contradictions: [],
            },
          ],
        },
      ],
    },
    onRefresh: () => undefined,
    onSelectAgent: () => undefined,
    onOpenDreaming: () => undefined,
    ...overrides,
  };
}

describe("memory graph view", () => {
  it("renders graph stats, search, and selectable node details", async () => {
    const container = document.createElement("div");
    const update = vi.fn(() => render(renderMemoryGraph(props), container));
    const props = createProps({ onRequestUpdate: update });

    render(renderMemoryGraph(props), container);
    await Promise.resolve();

    expect(container.querySelector(".memory-graph-canvas")).toBeInstanceOf(HTMLElement);
    expect(container.textContent).toContain("Nodes");
    expect(container.textContent).toContain("Edges");
    expect(container.textContent).toContain("Short Term");
    expect(container.textContent).toContain("Wiki Items");

    const search = container.querySelector<HTMLInputElement>("input[type='search']");
    expect(search).toBeInstanceOf(HTMLInputElement);
    search!.value = "PyKEEN";
    search!.dispatchEvent(new InputEvent("input", { bubbles: true }));
    render(renderMemoryGraph(props), container);
    await Promise.resolve();

    expect(container.textContent).toContain("Should PyKEEN become an…");
    expect(container.querySelector(".memory-graph-node--match")).not.toBeNull();

    const wikiNode = [...container.querySelectorAll<SVGGElement>(".memory-graph-node")].find(
      (node) => node.getAttribute("aria-label")?.includes("Matt Wallace"),
    );
    expect(wikiNode).not.toBeNull();
    wikiNode!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    render(renderMemoryGraph(props), container);
    await Promise.resolve();

    expect(container.querySelector(".memory-graph-detail")?.textContent).toContain("Matt Wallace");
  });

  it("keeps local search and selection separate from data refresh", async () => {
    const container = document.createElement("div");
    const refresh = vi.fn();
    const requestUpdate = vi.fn();
    const props = createProps({ onRefresh: refresh, onRequestUpdate: requestUpdate });

    render(renderMemoryGraph(props), container);
    await Promise.resolve();

    const search = container.querySelector<HTMLInputElement>("input[type='search']");
    search!.value = "dashboard";
    search!.dispatchEvent(new InputEvent("input", { bubbles: true }));

    expect(refresh).not.toHaveBeenCalled();
    expect(requestUpdate).toHaveBeenCalledTimes(1);

    const refreshButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Refresh",
    );
    refreshButton?.click();

    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
