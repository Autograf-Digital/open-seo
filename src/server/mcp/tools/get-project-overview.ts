import { DashboardService } from "@/server/features/dashboard/services/DashboardService";
import { mcpResponse } from "@/server/mcp/formatters";
import { buildProjectMeta } from "@/server/mcp/context";
import {
  looseObjectOutputSchema,
  optionalMetaOutputSchema,
} from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import type { z } from "zod";

const inputSchema = { projectId: projectIdSchema } as const;

// The project dashboard's stored summary: rank-tracking movement, the latest
// site audit, and the most recent backlink snapshot. Reads only what OpenSEO
// already saved — it never refreshes the backlink snapshot (that refresh is a
// metered DataForSEO call the dashboard makes on visit).
export const getProjectOverviewTool = {
  name: "get_project_overview",
  config: {
    title: "Get project overview",
    description:
      "Reads a project's stored dashboard summary: rank-tracking movement (tracked keywords, improved, declined, top 10, last check), the latest site audit (status, pages crawled, top issue types) and the most recent saved backlink snapshot (rank, backlinks, referring domains, new/lost, capturedAt, stale). Uses no credits — reads OpenSEO's database only and never refreshes the backlink snapshot. Sections are null when nothing has been stored yet.",
    inputSchema,
    outputSchema: {
      rank: looseObjectOutputSchema.nullable(),
      audit: looseObjectOutputSchema.nullable(),
      backlinks: looseObjectOutputSchema.nullable(),
      ...optionalMetaOutputSchema,
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(
    async (args: z.infer<z.ZodObject<typeof inputSchema>>, context) => {
      const overview = await DashboardService.getOverview({
        projectId: args.projectId,
        domain: context.project.domain,
      });
      const backlinks = overview.backlinks;
      const text = [
        overview.rank
          ? `Rank tracking: ${overview.rank.trackedKeywords} tracked, ${overview.rank.improved} improved, ${overview.rank.declined} declined, ${overview.rank.top10} in top 10 (last check ${overview.rank.lastCheckedAt ?? "never"}).`
          : "Rank tracking: no trackers.",
        overview.audit
          ? `Site audit: ${overview.audit.status}, ${overview.audit.pagesCrawled} pages crawled (started ${overview.audit.startedAt}), ${overview.audit.totalIssueTypes} issue types.`
          : "Site audit: none.",
        backlinks
          ? `Backlinks (${backlinks.domain}, captured ${backlinks.capturedAt}${backlinks.stale ? ", stale" : ""}): ${backlinks.backlinks ?? "?"} backlinks, ${backlinks.referringDomains ?? "?"} referring domains.`
          : "Backlinks: no stored snapshot.",
      ].join("\n");
      return mcpResponse({
        text,
        meta: buildProjectMeta(context, args.projectId, `/p/${args.projectId}`),
        structuredContent: overview,
      });
    },
  ),
};
