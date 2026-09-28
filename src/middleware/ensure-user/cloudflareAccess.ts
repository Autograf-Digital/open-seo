import { env } from "cloudflare:workers";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { AppError } from "@/server/lib/errors";
import { validateTeamDomain } from "@/shared/selfhost-checks";
import { classifyAccessVerificationError } from "./accessTokenErrors";
import { SHARED_WORKSPACE_ORGANIZATION_ID } from "@/server/auth/delegated-organization";
import { resolveSharedWorkspaceContext } from "./delegated";
import type { EnsuredUserContext } from "./types";

const jwksByTeamDomain = new Map<
  string,
  ReturnType<typeof createRemoteJWKSet>
>();

function getJwks(teamDomain: string) {
  const existing = jwksByTeamDomain.get(teamDomain);
  if (existing) {
    return existing;
  }

  const jwks = createRemoteJWKSet(
    new URL(`${teamDomain}/cdn-cgi/access/certs`),
  );

  jwksByTeamDomain.set(teamDomain, jwks);

  return jwks;
}

function getValidatedTeamDomain(teamDomain: string) {
  const result = validateTeamDomain(teamDomain);

  if (!result.ok) {
    throw new AppError("AUTH_CONFIG_MISSING", result.message);
  }

  return result.origin;
}

// Access service tokens admitted to MCP. A service token's JWT carries its
// client id as `common_name` and has no email, so it is never a person: it
// gets a synthetic identity in the shared workspace and (in transport.ts) a
// fixed tool set. Two explicit, comma-separated lists of client ids, e.g.
// "abc123.access"; unset means no service token is accepted:
//   ACCESS_READONLY_SERVICE_TOKENS - only the tools reading OpenSEO's own DB.
//   ACCESS_ACTION_SERVICE_TOKENS   - those plus the ACTION_TOOL_NAMES allowlist
//                                    (metered research, rank tracking, audits).
// A client id on both lists stays read-only: the narrower grant wins.
// Cloudflare shows client ids as "<hex>.access"; compare without the suffix so
// either spelling in the config matches the JWT's common_name.
function normalizeServiceTokenId(value: string) {
  return value.trim().replace(/\.access$/, "");
}

function serviceTokenIds(list: string | undefined) {
  return new Set(
    (list ?? "").split(",").map(normalizeServiceTokenId).filter(Boolean),
  );
}

function resolveServiceTokenContext(
  payload: JWTPayload,
): EnsuredUserContext | null {
  const commonName =
    typeof payload.common_name === "string" ? payload.common_name : null;
  if (!commonName || typeof payload.email === "string") return null;
  const id = normalizeServiceTokenId(commonName);
  const readOnly = serviceTokenIds(env.ACCESS_READONLY_SERVICE_TOKENS).has(id);
  const action =
    !readOnly && serviceTokenIds(env.ACCESS_ACTION_SERVICE_TOKENS).has(id);
  if (!readOnly && !action) return null;

  return {
    userId: `access-service-token:${commonName}`,
    userEmail: commonName,
    emailVerified: true,
    // Not ensureSharedWorkspaceOrganization(): a service identity never
    // creates the workspace, and when it does not exist there is nothing to
    // read or act on.
    organizationId: SHARED_WORKSPACE_ORGANIZATION_ID,
    role: "member",
    ...(readOnly
      ? { readOnlyServiceToken: true as const }
      : { actionServiceToken: true as const }),
  };
}

// `allowServiceToken` is set only by the MCP transport. Server functions and
// API routes keep rejecting every service token, read-only or action.
export async function resolveCloudflareAccessContext(
  headers: Headers,
  options: { allowServiceToken?: boolean } = {},
): Promise<EnsuredUserContext> {
  const teamDomain = env.TEAM_DOMAIN
    ? getValidatedTeamDomain(env.TEAM_DOMAIN)
    : null;
  const policyAud = env.POLICY_AUD?.trim() || null;

  if (!teamDomain || !policyAud) {
    const missing = [
      teamDomain ? null : "TEAM_DOMAIN",
      policyAud ? null : "POLICY_AUD",
    ]
      .filter(Boolean)
      .join(" and ");
    throw new AppError(
      "AUTH_CONFIG_MISSING",
      `Missing Cloudflare Access configuration: set ${missing} on the deployment. See docs/SELF_HOSTING_CLOUDFLARE.md.`,
    );
  }

  const token = headers.get("cf-access-jwt-assertion");

  if (!token) {
    // With Access enabled in front of the deployment, every request carries
    // this header — its absence means Access is not actually protecting the
    // route, which is a setup problem, not a signed-out user.
    throw new AppError(
      "AUTH_CONFIG_MISSING",
      "No Cloudflare Access token on the request. Cloudflare Access is not enabled in front of this deployment — add an Access application covering this hostname in Zero Trust, or set AUTH_MODE=local_noauth if you intend to run without auth on a private network.",
    );
  }

  // Only the token verification itself is classified — anything thrown past
  // this block (user resolution, DB access) is an app fault, and classifying
  // it here would mislabel a DB outage as an auth-config problem.
  let payload: JWTPayload;
  try {
    const jwks = getJwks(teamDomain);
    ({ payload } = await jwtVerify(token, jwks, {
      issuer: teamDomain,
      audience: policyAud,
    }));
  } catch (error) {
    // The classified AppError carries operator guidance; log the raw jose
    // error too, since it is the only place the underlying cause survives.
    console.error("Cloudflare Access token verification failed:", error);

    throw classifyAccessVerificationError(error);
  }

  const userId = typeof payload.sub === "string" ? payload.sub : null;
  const userEmail = typeof payload.email === "string" ? payload.email : null;

  if (!userId || !userEmail) {
    const service = options.allowServiceToken
      ? resolveServiceTokenContext(payload)
      : null;
    if (service) return service;
    throw new AppError("UNAUTHENTICATED");
  }

  return resolveSharedWorkspaceContext(userId, userEmail);
}
