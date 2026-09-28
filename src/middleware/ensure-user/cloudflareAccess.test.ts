import type * as Jose from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCloudflareAccessContext } from "./cloudflareAccess";

const mocks = vi.hoisted(() => ({
  env: {} as Record<string, string | undefined>,
  jwtVerify: vi.fn(),
  resolveSharedWorkspaceContext: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: mocks.env }));

vi.mock("jose", async (importOriginal) => ({
  ...(await importOriginal<typeof Jose>()),
  createRemoteJWKSet: () => ({}),
  jwtVerify: mocks.jwtVerify,
}));

vi.mock("./delegated", () => ({
  resolveSharedWorkspaceContext: mocks.resolveSharedWorkspaceContext,
}));

const SERVICE_TOKEN = "efd3f67bba64d342278a0371011aa0ae.access";
const ACTION_TOKEN = "0123456789abcdef0123456789abcdef.access";

function accessHeaders() {
  return new Headers({ "cf-access-jwt-assertion": "signed.jwt.value" });
}

// Cloudflare Access service-token JWTs carry the client id as common_name, an
// empty sub and no email.
function servicePayload(commonName = SERVICE_TOKEN) {
  return { payload: { sub: "", common_name: commonName, type: "app" } };
}

describe("resolveCloudflareAccessContext", () => {
  beforeEach(() => {
    mocks.env.TEAM_DOMAIN = "https://team.cloudflareaccess.com";
    mocks.env.POLICY_AUD = "aud-tag";
    mocks.env.ACCESS_READONLY_SERVICE_TOKENS = ` other.access , ${SERVICE_TOKEN}`;
    mocks.env.ACCESS_ACTION_SERVICE_TOKENS = undefined;
    mocks.resolveSharedWorkspaceContext.mockImplementation(
      (userId: string, userEmail: string) =>
        Promise.resolve({
          userId,
          userEmail,
          emailVerified: true,
          organizationId: "shared-workspace",
          role: "owner",
        }),
    );
  });

  it("CONTRACT: a listed service token resolves to a read-only member of the shared workspace on MCP", async () => {
    mocks.jwtVerify.mockResolvedValue(servicePayload());

    const context = await resolveCloudflareAccessContext(accessHeaders(), {
      allowServiceToken: true,
    });

    expect(context).toEqual({
      userId: `access-service-token:${SERVICE_TOKEN}`,
      userEmail: SERVICE_TOKEN,
      emailVerified: true,
      organizationId: "shared-workspace",
      role: "member",
      readOnlyServiceToken: true,
    });
    // Read-only: the service identity never upserts a user or workspace.
    expect(mocks.resolveSharedWorkspaceContext).not.toHaveBeenCalled();
  });

  it("matches a configured client id with or without the .access suffix", async () => {
    mocks.env.ACCESS_READONLY_SERVICE_TOKENS =
      "efd3f67bba64d342278a0371011aa0ae";
    mocks.jwtVerify.mockResolvedValue(servicePayload());

    const context = await resolveCloudflareAccessContext(accessHeaders(), {
      allowServiceToken: true,
    });

    expect(context.readOnlyServiceToken).toBe(true);
  });

  it("CONTRACT: server functions and API routes still reject a listed service token", async () => {
    mocks.jwtVerify.mockResolvedValue(servicePayload());

    await expect(
      resolveCloudflareAccessContext(accessHeaders()),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("CONTRACT: an unlisted service token is rejected on MCP", async () => {
    mocks.jwtVerify.mockResolvedValue(servicePayload("stranger.access"));

    await expect(
      resolveCloudflareAccessContext(accessHeaders(), {
        allowServiceToken: true,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("CONTRACT: no service token is accepted when none is configured", async () => {
    mocks.env.ACCESS_READONLY_SERVICE_TOKENS = undefined;
    mocks.jwtVerify.mockResolvedValue(servicePayload());

    await expect(
      resolveCloudflareAccessContext(accessHeaders(), {
        allowServiceToken: true,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("keeps a person on the shared workspace with full access", async () => {
    mocks.jwtVerify.mockResolvedValue({
      payload: { sub: "user-1", email: "person@autograf.ca" },
    });

    const context = await resolveCloudflareAccessContext(accessHeaders(), {
      allowServiceToken: true,
    });

    expect(context.readOnlyServiceToken).toBeUndefined();
    expect(context.role).toBe("owner");
    expect(mocks.resolveSharedWorkspaceContext).toHaveBeenCalledWith(
      "user-1",
      "person@autograf.ca",
    );
  });

  it("CONTRACT: an action-listed service token resolves to an action member (never read-only, never a person)", async () => {
    mocks.env.ACCESS_READONLY_SERVICE_TOKENS = SERVICE_TOKEN;
    mocks.env.ACCESS_ACTION_SERVICE_TOKENS = ACTION_TOKEN;
    mocks.jwtVerify.mockResolvedValue(servicePayload(ACTION_TOKEN));

    const context = await resolveCloudflareAccessContext(accessHeaders(), {
      allowServiceToken: true,
    });

    expect(context).toEqual({
      userId: `access-service-token:${ACTION_TOKEN}`,
      userEmail: ACTION_TOKEN,
      emailVerified: true,
      organizationId: "shared-workspace",
      role: "member",
      actionServiceToken: true,
    });
    expect(context.readOnlyServiceToken).toBeUndefined();
    expect(mocks.resolveSharedWorkspaceContext).not.toHaveBeenCalled();
  });

  it("CONTRACT: the read-only token stays read-only, even when it is also on the action list", async () => {
    mocks.env.ACCESS_READONLY_SERVICE_TOKENS = SERVICE_TOKEN;
    mocks.env.ACCESS_ACTION_SERVICE_TOKENS = `${ACTION_TOKEN},${SERVICE_TOKEN}`;
    mocks.jwtVerify.mockResolvedValue(servicePayload());

    const context = await resolveCloudflareAccessContext(accessHeaders(), {
      allowServiceToken: true,
    });

    expect(context.readOnlyServiceToken).toBe(true);
    expect(context.actionServiceToken).toBeUndefined();
  });

  it("CONTRACT: server functions and API routes reject an action token too", async () => {
    mocks.env.ACCESS_ACTION_SERVICE_TOKENS = ACTION_TOKEN;
    mocks.jwtVerify.mockResolvedValue(servicePayload(ACTION_TOKEN));

    await expect(
      resolveCloudflareAccessContext(accessHeaders()),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
});
