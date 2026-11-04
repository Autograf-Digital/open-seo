import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getRankHistoryTool, MAX_HISTORY_KEYWORDS } from "./get-rank-history";
import { makeToolContext } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  getConfigById: vi.fn(),
  getKeywordsForConfig: vi.fn(),
  getKeywordHistoryForKeywords: vi.fn(),
  getConfigTrend: vi.fn(),
  createDataforseoClient: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));
vi.mock(
  "@/server/features/rank-tracking/repositories/RankTrackingRepository",
  () => ({
    RankTrackingRepository: {
      getConfigById: mocks.getConfigById,
      getKeywordsForConfig: mocks.getKeywordsForConfig,
      getKeywordHistoryForKeywords: mocks.getKeywordHistoryForKeywords,
      getConfigTrend: mocks.getConfigTrend,
    },
  }),
);
// Any provider call from this tool is a bug: fail loudly if one is attempted.
vi.mock("@/server/lib/dataforseo", () => ({
  createDataforseoClient: mocks.createDataforseoClient,
}));

const projectId = "11111111-1111-4111-8111-111111111111";
const trackerId = "22222222-2222-4222-8222-222222222222";
const kwA = "33333333-3333-4333-8333-333333333333";
const kwB = "44444444-4444-4444-8444-444444444444";

const toolContext = makeToolContext();
const parseInput = (input: unknown) =>
  z.object(getRankHistoryTool.config.inputSchema).parse(input);

const config = {
  id: trackerId,
  projectId,
  domain: "example.com",
  locationName: "Calgary,Alberta,Canada",
  devices: "both",
  scheduleInterval: "weekly",
  serpDepth: 40,
};

describe("get_rank_history", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProjectForOrganization.mockResolvedValue({
      id: projectId,
      domain: "example.com",
    });
    mocks.getConfigById.mockResolvedValue(config);
    mocks.getKeywordsForConfig.mockResolvedValue([
      { id: kwA, keyword: "barber calgary" },
      { id: kwB, keyword: "fade haircut" },
    ]);
    mocks.getKeywordHistoryForKeywords.mockImplementation(
      async (_configId: string, keywordIds: string[]) =>
        keywordIds.includes(kwA)
          ? [
              // Deliberately out of order: the tool must return oldest first.
              {
                trackingKeywordId: kwA,
                device: "mobile",
                checkedAt: "2026-10-20 10:00:00",
                position: 4,
                url: "https://example.com/",
              },
              {
                trackingKeywordId: kwA,
                device: "desktop",
                checkedAt: "2026-10-06 10:00:00",
                position: null,
                url: null,
              },
              {
                trackingKeywordId: kwA,
                device: "desktop",
                checkedAt: "2026-10-13 10:00:00",
                position: 12,
                url: "https://example.com/barbers",
              },
            ]
          : [],
    );
    mocks.getConfigTrend.mockImplementation(
      async (_configId: string, device: string) =>
        device === "desktop"
          ? [
              {
                runId: "run_2",
                checkedAt: "2026-10-13 10:00:00",
                total: "10",
                top3: "1",
                top4to10: "2",
                top11to20: "3",
              },
            ]
          : [
              {
                runId: "run_1",
                checkedAt: "2026-10-06 10:00:00",
                total: 10,
                top3: 0,
                top4to10: 0,
                top11to20: 1,
              },
            ],
    );
  });

  it("returns the documented shape, oldest first, keeping null positions", async () => {
    const result = await getRankHistoryTool.handler(
      parseInput({ projectId, trackerId }),
      toolContext,
    );

    expect(result.structuredContent).toMatchObject({
      config: {
        id: trackerId,
        locationName: "Calgary,Alberta,Canada",
        devices: "both",
        scheduleInterval: "weekly",
      },
      keywords: [
        {
          keyword: "barber calgary",
          trackingKeywordId: kwA,
          checks: [
            {
              at: "2026-10-06 10:00:00",
              device: "desktop",
              position: null,
              url: null,
            },
            {
              at: "2026-10-13 10:00:00",
              device: "desktop",
              position: 12,
              url: "https://example.com/barbers",
            },
            {
              at: "2026-10-20 10:00:00",
              device: "mobile",
              position: 4,
              url: "https://example.com/",
            },
          ],
        },
        { keyword: "fade haircut", trackingKeywordId: kwB, checks: [] },
      ],
      trend: [
        {
          at: "2026-10-06 10:00:00",
          device: "mobile",
          top3: 0,
          top10: 0,
          top20: 1,
          not_ranking: 9,
          total: 10,
        },
        {
          at: "2026-10-13 10:00:00",
          device: "desktop",
          top3: 1,
          top10: 3,
          top20: 6,
          not_ranking: 4,
          total: 10,
        },
      ],
      truncated: false,
    });
    expect(
      z
        .object(getRankHistoryTool.config.outputSchema)
        .safeParse(result.structuredContent).success,
    ).toBe(true);
    expect(mocks.createDataforseoClient).not.toHaveBeenCalled();
  });

  it("defaults sinceDays to 90 and bounds it to 1..400", async () => {
    expect(parseInput({ projectId, trackerId }).sinceDays).toBe(90);
    expect(parseInput({ projectId, trackerId, sinceDays: 400 }).sinceDays).toBe(
      400,
    );
    for (const sinceDays of [0, 401, 1.5]) {
      expect(() => parseInput({ projectId, trackerId, sinceDays })).toThrow();
    }

    await getRankHistoryTool.handler(
      parseInput({ projectId, trackerId, sinceDays: 30 }),
      toolContext,
    );
    expect(mocks.getKeywordHistoryForKeywords).toHaveBeenCalledWith(
      trackerId,
      [kwA, kwB],
      30,
    );
    expect(mocks.getConfigTrend).toHaveBeenCalledWith(trackerId, "desktop", 30);
  });

  it("only queries the requested keywords and the tracker's own devices", async () => {
    mocks.getConfigById.mockResolvedValue({ ...config, devices: "mobile" });

    const result = await getRankHistoryTool.handler(
      parseInput({ projectId, trackerId, trackingKeywordIds: [kwB] }),
      toolContext,
    );

    expect(mocks.getKeywordHistoryForKeywords).toHaveBeenCalledTimes(1);
    expect(mocks.getKeywordHistoryForKeywords).toHaveBeenCalledWith(
      trackerId,
      [kwB],
      90,
    );
    expect(mocks.getConfigTrend).toHaveBeenCalledTimes(1);
    expect(mocks.getConfigTrend).toHaveBeenCalledWith(trackerId, "mobile", 90);
    expect(result.structuredContent).toMatchObject({
      keywords: [{ trackingKeywordId: kwB }],
    });
  });

  it("rejects keyword ids the tracker does not own", async () => {
    await expect(
      getRankHistoryTool.handler(
        parseInput({
          projectId,
          trackerId,
          trackingKeywordIds: ["55555555-5555-4555-8555-555555555555"],
        }),
        toolContext,
      ),
    ).rejects.toThrow();
    expect(mocks.getKeywordHistoryForKeywords).not.toHaveBeenCalled();
  });

  it("refuses a tracker outside the project (same check as get_rank_tracker)", async () => {
    mocks.getConfigById.mockResolvedValue(null);

    await expect(
      getRankHistoryTool.handler(
        parseInput({ projectId, trackerId }),
        toolContext,
      ),
    ).rejects.toThrow();
    expect(mocks.getConfigById).toHaveBeenCalledWith({
      configId: trackerId,
      projectId,
    });
    expect(mocks.getKeywordHistoryForKeywords).not.toHaveBeenCalled();
  });

  it("refuses a project the caller cannot access", async () => {
    mocks.getProjectForOrganization.mockResolvedValue(null);

    await expect(
      getRankHistoryTool.handler(
        parseInput({ projectId, trackerId }),
        toolContext,
      ),
    ).rejects.toThrow();
    expect(mocks.getConfigById).not.toHaveBeenCalled();
  });

  it("caps the keywords per call and flags truncation", async () => {
    mocks.getKeywordsForConfig.mockResolvedValue(
      Array.from({ length: MAX_HISTORY_KEYWORDS + 5 }, (_, i) => ({
        id: `kw_${i}`,
        keyword: `keyword ${i}`,
      })),
    );

    const result = await getRankHistoryTool.handler(
      parseInput({ projectId, trackerId }),
      toolContext,
    );

    // One batched repository call for all capped keywords, not one per keyword.
    expect(mocks.getKeywordHistoryForKeywords).toHaveBeenCalledTimes(1);
    expect(mocks.getKeywordHistoryForKeywords.mock.calls[0]?.[1]).toHaveLength(
      MAX_HISTORY_KEYWORDS,
    );
    expect(result.structuredContent).toMatchObject({ truncated: true });
  });
});
