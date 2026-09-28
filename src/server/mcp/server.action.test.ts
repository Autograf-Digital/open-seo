import { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { createWorkersOAuthMcpProps } from "@/server/mcp/context";
import { recordDataforseoSpend } from "@/server/lib/dataforseo/spend-scope";
import {
  ACTION_TOOL_NAMES,
  createOpenSeoMcpServer,
  READ_ONLY_TOOL_NAMES,
} from "@/server/mcp/server";

vi.mock("cloudflare:workers", () => ({
  env: {},
  waitUntil: () => {},
  DurableObject: class {
    readonly ctx = null;
  },
}));

// Pass handlers straight through so a call reaches the action wrapper without
// analytics or DB side effects.
vi.mock("@/server/mcp/instrumentation", () => ({
  instrumentMcpToolHandler: (
    _name: string,
    _schema: unknown,
    handler: unknown,
  ) => handler,
}));

// A research tool that bills two DataForSEO calls, as the real one does per
// seed, without a database or network.
vi.mock("@/server/mcp/tools/research-keywords", () => ({
  researchKeywordsTool: {
    name: "research_keywords",
    config: { inputSchema: {} },
    handler: async () => {
      recordDataforseoSpend({ costUsd: 0.0101, path: ["labs"] });
      recordDataforseoSpend({ costUsd: 0.02, path: ["labs"] });
      return {
        content: [{ type: "text", text: "ok" }],
        _meta: { url: "https://seo.example.com/p/x/keywords" },
      };
    },
  },
}));

const props = createWorkersOAuthMcpProps({
  userId: "access-service-token:action.access",
  userEmail: "action.access",
  organizationId: "shared-workspace",
  role: "member",
  baseUrl: "https://seo.example.com",
});

type Callback = (
  args: unknown,
  context: unknown,
) => Promise<{
  _meta?: Record<string, unknown>;
}>;

function registered(options?: { readOnly?: boolean; action?: boolean }) {
  const spy = vi.spyOn(McpServer.prototype, "registerTool");
  try {
    createOpenSeoMcpServer(props, options);
    return new Map(
      spy.mock.calls.map(([name, , callback]) => [
        name,
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the SDK types the callback per tool; tests call it with plain args
        callback as unknown as Callback,
      ]),
    );
  } finally {
    spy.mockRestore();
  }
}

const NEVER_FOR_SERVICE_TOKENS = [
  "create_project",
  "update_project_context",
  "save_keywords",
  "save_report",
  "save_report_template",
  "get_serp_results",
  "get_backlinks_overview",
  "search_local_businesses",
  "get_local_rank_grid",
  "get_search_console_performance",
  "inspect_urls",
  "get_google_analytics_organic_overview",
];

describe("createOpenSeoMcpServer action mode", () => {
  it("CONTRACT: an action identity is offered exactly the read tools plus the action allowlist", () => {
    const names = [...registered({ action: true }).keys()];

    expect(new Set(names)).toEqual(
      new Set([...READ_ONLY_TOOL_NAMES, ...ACTION_TOOL_NAMES]),
    );
    for (const name of NEVER_FOR_SERVICE_TOKENS) {
      expect(names, name).not.toContain(name);
    }
  });

  it("CONTRACT: the read-only identity still gets no action tool", () => {
    const names = [...registered({ readOnly: true }).keys()];

    for (const name of ACTION_TOOL_NAMES) {
      expect(names, name).not.toContain(name);
    }
    // Read-only wins when both options are passed.
    const both = [...registered({ readOnly: true, action: true }).keys()];
    expect(new Set(both)).toEqual(READ_ONLY_TOOL_NAMES);
  });

  it("CONTRACT: an action identity cannot create a scheduled tracker or approve scheduled cost", async () => {
    const tools = registered({ action: true });

    await expect(
      tools.get("create_rank_tracker")!(
        { projectId: "p", scheduleInterval: "daily" },
        {},
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      tools.get("add_rank_tracking_keywords")!(
        {
          projectId: "p",
          trackerId: "t",
          keywords: ["a"],
          maxEstimatedScheduledCheckCredits: 5,
        },
        {},
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("CONTRACT: an action tool result reports the DataForSEO spend it caused", async () => {
    const tools = registered({ action: true });

    const result = await tools.get("research_keywords")!({}, {});

    expect(result._meta).toEqual({
      url: "https://seo.example.com/p/x/keywords",
      dataforseoSpend: { costUsd: 0.0301, calls: 2 },
    });
  });

  it("leaves people on the full tool set without the spend wrapper", async () => {
    const tools = registered();

    expect(tools.has("save_report")).toBe(true);
    const result = await tools.get("research_keywords")!({}, {});
    expect(result._meta).toEqual({
      url: "https://seo.example.com/p/x/keywords",
    });
  });
});
