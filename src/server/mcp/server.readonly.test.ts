import { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { createWorkersOAuthMcpProps } from "@/server/mcp/context";
import {
  createOpenSeoMcpServer,
  READ_ONLY_TOOL_NAMES,
} from "@/server/mcp/server";

vi.mock("cloudflare:workers", () => ({
  env: {},
  DurableObject: class {
    readonly ctx = null;
  },
}));

const props = createWorkersOAuthMcpProps({
  userId: "access-service-token:client.access",
  userEmail: "client.access",
  organizationId: "shared-workspace",
  role: "member",
  baseUrl: "https://seo.example.com",
});

type Registered = {
  name: string;
  config: { description?: string; annotations?: { readOnlyHint?: boolean } };
};

function registeredTools(options?: { readOnly?: boolean }): Registered[] {
  const spy = vi.spyOn(McpServer.prototype, "registerTool");
  try {
    createOpenSeoMcpServer(props, options);
    return spy.mock.calls.map(([name, config]) => ({ name, config }));
  } finally {
    spy.mockRestore();
  }
}

describe("createOpenSeoMcpServer read-only mode", () => {
  it("CONTRACT: a read-only identity is offered exactly the stored-data read tools", () => {
    const names = registeredTools({ readOnly: true }).map((tool) => tool.name);

    expect(new Set(names)).toEqual(READ_ONLY_TOOL_NAMES);
    expect(names).toHaveLength(READ_ONLY_TOOL_NAMES.size);
    for (const paid of [
      "research_keywords",
      "get_backlinks_overview",
      "get_backlinks_profile",
      "run_rank_tracker",
      "run_site_audit",
      "get_audit_status",
      "save_report",
      "update_project_context",
      "create_project",
    ]) {
      expect(names).not.toContain(paid);
    }
  });

  it("CONTRACT: every read-only tool is annotated read-only and documented as free (no credits)", () => {
    const tools = registeredTools({ readOnly: true });

    for (const tool of tools) {
      expect(tool.config.annotations?.readOnlyHint, tool.name).toBe(true);
      expect(tool.config.description ?? "", tool.name).toMatch(
        /no credits|free/i,
      );
    }
  });

  it("keeps the full tool set, including get_project_overview, for people", () => {
    const names = registeredTools().map((tool) => tool.name);

    expect(names).toContain("get_project_overview");
    expect(names).toContain("research_keywords");
    expect(names.length).toBeGreaterThan(READ_ONLY_TOOL_NAMES.size);
  });
});
