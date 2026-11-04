import { sortBy } from "remeda";
import { z } from "zod";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import { AppError } from "@/server/lib/errors";
import { mcpResponse } from "@/server/mcp/formatters";
import { buildProjectMeta } from "@/server/mcp/context";
import {
  looseObjectOutputSchema,
  optionalMetaOutputSchema,
} from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";

// One history query per keyword: keep a single call well inside D1's
// per-invocation query budget. Callers page larger trackers with
// trackingKeywordIds.
export const MAX_HISTORY_KEYWORDS = 100;

const inputSchema = {
  projectId: projectIdSchema,
  trackerId: z
    .string()
    .uuid()
    .describe("Rank tracker config ID from get_rank_tracker."),
  trackingKeywordIds: z
    .array(z.string().uuid())
    .min(1)
    .max(MAX_HISTORY_KEYWORDS)
    .optional()
    .describe(
      `Tracking keyword IDs (from get_rank_tracker) to return. If omitted, returns the tracker's first ${MAX_HISTORY_KEYWORDS} keywords.`,
    ),
  sinceDays: z
    .number()
    .int()
    .min(1)
    .max(400)
    .default(90)
    .describe("How many days of history to return (default 90, max 400)."),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

type Device = "desktop" | "mobile";

function devicesFor(setting: "both" | Device): Device[] {
  return setting === "both" ? ["desktop", "mobile"] : [setting];
}

// Stable, oldest first.
function byAt<T extends { at: string }>(rows: T[]): T[] {
  return sortBy(rows, (row) => row.at);
}

export const getRankHistoryTool = {
  name: "get_rank_history",
  config: {
    title: "Get rank history",
    description:
      "Read-only stored rank history for one rank tracker: every completed check per tracked keyword over the last `sinceDays` days (default 90, max 400), oldest first, plus the per-run position distribution. `position: null` means the keyword was checked but not found within the tracker's search depth. Trend buckets are cumulative (top10 includes top3, top20 includes top10); `not_ranking` is positions past 20 or not found. Uses no credits — reads OpenSEO's database only and never runs a check.",
    inputSchema,
    outputSchema: {
      config: looseObjectOutputSchema,
      keywords: z.array(
        z
          .object({
            keyword: z.string(),
            trackingKeywordId: z.string(),
            checks: z.array(looseObjectOutputSchema),
          })
          .passthrough(),
      ),
      trend: z.array(looseObjectOutputSchema),
      truncated: z.boolean(),
      ...optionalMetaOutputSchema,
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: Args, context) => {
    const sinceDays = args.sinceDays ?? 90;
    const config = await RankTrackingRepository.getConfigById({
      configId: args.trackerId,
      projectId: args.projectId,
    });
    if (!config) {
      throw new AppError("NOT_FOUND", "Rank tracking config not found");
    }

    const tracked = await RankTrackingRepository.getKeywordsForConfig(
      config.id,
    );
    let selected = tracked;
    if (args.trackingKeywordIds) {
      const wanted = new Set(args.trackingKeywordIds);
      selected = tracked.filter((k) => wanted.has(k.id));
      const known = new Set(selected.map((k) => k.id));
      const unknown = args.trackingKeywordIds.filter((id) => !known.has(id));
      if (unknown.length > 0) {
        throw new AppError(
          "VALIDATION_ERROR",
          `Not tracked by this tracker: ${unknown.join(", ")}`,
        );
      }
    }
    const truncated = selected.length > MAX_HISTORY_KEYWORDS;
    selected = selected.slice(0, MAX_HISTORY_KEYWORDS);

    const keywords = await Promise.all(
      selected.map(async (k) => {
        const rows = await RankTrackingRepository.getKeywordHistory(
          config.id,
          k.id,
          sinceDays,
        );
        const checks = byAt(
          rows.map((row) => ({
            at: row.checkedAt,
            device: row.device,
            position: row.position ?? null,
            url: row.url ?? null,
          })),
        );
        return { keyword: k.keyword, trackingKeywordId: k.id, checks };
      }),
    );

    const trendByDevice = await Promise.all(
      devicesFor(config.devices).map(async (device) => {
        const rows = await RankTrackingRepository.getConfigTrend(
          config.id,
          device,
          sinceDays,
        );
        // SQLite sum()/count() can come back as strings; coerce.
        return rows.map((row) => {
          const top3 = Number(row.top3) || 0;
          const top10 = top3 + (Number(row.top4to10) || 0);
          const top20 = top10 + (Number(row.top11to20) || 0);
          const total = Number(row.total) || 0;
          return {
            at: row.checkedAt,
            device,
            top3,
            top10,
            top20,
            not_ranking: Math.max(0, total - top20),
            total,
          };
        });
      }),
    );
    const trend = byAt(trendByDevice.flat());

    const text = [
      `Rank history for tracker ${config.id} (${config.domain}${config.locationName ? `, ${config.locationName}` : ""}), last ${sinceDays} days:`,
      `Keywords: ${keywords.length}${truncated ? ` of ${tracked.length} (pass trackingKeywordIds for the rest)` : ""}, runs in trend: ${trend.length}`,
      ...keywords.map((k) => {
        const latest = k.checks.at(-1);
        return `- ${k.keyword}: ${k.checks.length} checks${latest ? `, latest ${latest.position ?? "not found"} (${latest.device}, ${latest.at})` : ""}`;
      }),
    ].join("\n");

    return mcpResponse({
      text,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/rank-tracking/${config.id}`,
      ),
      structuredContent: {
        config: {
          id: config.id,
          locationName: config.locationName,
          devices: config.devices,
          scheduleInterval: config.scheduleInterval,
        },
        keywords,
        trend,
        truncated,
      },
    });
  }),
};
