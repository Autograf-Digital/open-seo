import { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { MCP_AUTH_CONTEXT_PROP } from "@/server/mcp/context";
import { handleSelfHostedOpenSeoMcpRequest } from "@/server/mcp/transport";

const mocks = vi.hoisted(() => ({
  resolveCloudflareAccessContext: vi.fn(),
  createOpenSeoMcpServer: vi.fn(),
}));

vi.mock("@/server/auth/repositories/AuthRepository", () => ({
  AuthRepository: {},
}));

vi.mock("@/server/auth/default-hosted-organization", () => ({
  resolveExistingActiveHostedOrganization: vi.fn(),
}));

vi.mock("@/middleware/ensure-user/cloudflareAccess", () => ({
  resolveCloudflareAccessContext: mocks.resolveCloudflareAccessContext,
}));

vi.mock("@/middleware/ensure-user/delegated", () => ({
  resolveLocalNoAuthContext: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getHostedBaseUrl: () => "https://open-seo.test",
}));

vi.mock("@/server/mcp/server", () => ({
  createOpenSeoMcpServer: (props: unknown, options: unknown) => {
    mocks.createOpenSeoMcpServer(props, options);
    return new McpServer({ name: "OpenSEO MCP", version: "0.0.0" });
  },
}));

vi.mock("agents/mcp/server", () => ({
  createMcpHandler: () => async () => Response.json({}, { status: 202 }),
}));

const ctx: ExecutionContext = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
};

function legacyToolsListRequest() {
  return new Request("https://open-seo.test/mcp", {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

describe("self-hosted MCP transport for Access service tokens", () => {
  it("CONTRACT: an Access service token gets a read-only MCP server as a member", async () => {
    mocks.resolveCloudflareAccessContext.mockResolvedValue({
      userId: "access-service-token:client.access",
      userEmail: "client.access",
      emailVerified: true,
      organizationId: "shared-workspace",
      role: "member",
      readOnlyServiceToken: true,
    });

    const response = await handleSelfHostedOpenSeoMcpRequest(
      legacyToolsListRequest(),
      "cloudflare_access",
      {},
      ctx,
    );

    expect(response.status).toBe(200);
    expect(mocks.resolveCloudflareAccessContext).toHaveBeenCalledWith(
      expect.any(Headers),
      { allowReadOnlyServiceToken: true },
    );
    expect(mocks.createOpenSeoMcpServer).toHaveBeenCalledWith(
      {
        [MCP_AUTH_CONTEXT_PROP]: {
          userId: "access-service-token:client.access",
          userEmail: "client.access",
          organizationId: "shared-workspace",
          role: "member",
          baseUrl: "https://open-seo.test",
        },
      },
      { readOnly: true },
    );
  });

  it("keeps people on the full tool set", async () => {
    mocks.resolveCloudflareAccessContext.mockResolvedValue({
      userId: "user-1",
      userEmail: "person@autograf.ca",
      emailVerified: true,
      organizationId: "shared-workspace",
      role: "owner",
    });

    await handleSelfHostedOpenSeoMcpRequest(
      legacyToolsListRequest(),
      "cloudflare_access",
      {},
      ctx,
    );

    expect(mocks.createOpenSeoMcpServer).toHaveBeenCalledWith(
      expect.any(Object),
      undefined,
    );
  });
});
