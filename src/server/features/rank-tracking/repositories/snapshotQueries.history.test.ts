import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as SnapshotQueriesModule from "./snapshotQueries";

// Real in-memory SQLite: checks the batched history query returns the same
// rows the per-keyword query does, while issuing one statement per chunk.

vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: "d1" },
}));

let client: Client;
let testDb: ReturnType<typeof drizzle>;
let queries: typeof SnapshotQueriesModule;

const KEYWORD_COUNT = 185; // 3 chunks of 90
const recent = "2099-01-01 00:00:00"; // always inside the cutoff
const old = "2000-01-01 00:00:00"; // always outside it

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  testDb = drizzle(client);
  vi.doMock("@/db", () => ({ db: testDb }));

  await client.executeMultiple(`
    CREATE TABLE rank_check_runs (
      id TEXT PRIMARY KEY,
      config_id TEXT NOT NULL,
      status TEXT NOT NULL,
      is_subset_run INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL
    );
    CREATE TABLE rank_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      tracking_keyword_id TEXT NOT NULL,
      keyword TEXT NOT NULL,
      device TEXT NOT NULL,
      position INTEGER,
      url TEXT,
      serp_features TEXT,
      checked_at TEXT NOT NULL
    );
    INSERT INTO rank_check_runs VALUES
      ('run_ok', 'cfg', 'completed', 0, '${recent}'),
      ('run_failed', 'cfg', 'failed', 0, '${recent}'),
      ('run_other', 'other_cfg', 'completed', 0, '${recent}');
  `);

  const values = [];
  for (let i = 0; i < KEYWORD_COUNT; i++) {
    values.push(
      `('run_ok', 'kw_${i}', 'k${i}', 'desktop', ${i === 0 ? "NULL" : i % 50}, ${i === 0 ? "NULL" : `'https://example.com/${i}'`}, '${recent}')`,
    );
  }
  await client.execute(
    `INSERT INTO rank_snapshots (run_id, tracking_keyword_id, keyword, device, position, url, checked_at) VALUES ${values.join(",")}`,
  );
  await client.executeMultiple(`
    INSERT INTO rank_snapshots (run_id, tracking_keyword_id, keyword, device, position, url, checked_at) VALUES
      ('run_ok', 'kw_0', 'k0', 'mobile', 7, 'https://example.com/m', '2098-06-01 00:00:00'),
      ('run_ok', 'kw_1', 'k1', 'mobile', 3, NULL, '${old}'),
      ('run_failed', 'kw_1', 'k1', 'mobile', 1, NULL, '${recent}'),
      ('run_other', 'kw_1', 'k1', 'mobile', 2, NULL, '${recent}');
  `);

  queries = await import("./snapshotQueries");
});

afterAll(() => {
  client.close();
});

function strip<T extends { trackingKeywordId: string }>({
  trackingKeywordId: _id,
  ...row
}: T) {
  return row;
}

describe("getKeywordHistoryForKeywords", () => {
  it("executes ceil(n / 90) statements, not one per keyword", async () => {
    const ids = Array.from({ length: KEYWORD_COUNT }, (_, i) => `kw_${i}`);
    const executed = vi.spyOn(client, "execute");

    const rows = await queries.getKeywordHistoryForKeywords("cfg", ids, 90);

    expect(executed).toHaveBeenCalledTimes(Math.ceil(KEYWORD_COUNT / 90));
    expect(executed).toHaveBeenCalledTimes(3);
    executed.mockRestore();
    expect(new Set(rows.map((r) => r.trackingKeywordId)).size).toBe(
      KEYWORD_COUNT,
    );
  });

  it("matches getKeywordHistory: completed runs of this config, within the cutoff, oldest first, nulls kept", async () => {
    const batched = await queries.getKeywordHistoryForKeywords(
      "cfg",
      ["kw_0", "kw_1"],
      90,
    );

    for (const id of ["kw_0", "kw_1"]) {
      expect(
        batched.filter((r) => r.trackingKeywordId === id).map(strip),
      ).toEqual(await queries.getKeywordHistory("cfg", id, 90));
    }
    expect(batched.filter((r) => r.trackingKeywordId === "kw_0")).toEqual([
      {
        trackingKeywordId: "kw_0",
        device: "mobile",
        checkedAt: "2098-06-01 00:00:00",
        position: 7,
        url: "https://example.com/m",
      },
      {
        trackingKeywordId: "kw_0",
        device: "desktop",
        checkedAt: recent,
        position: null,
        url: null,
      },
    ]);
    // kw_1's old, failed-run and other-config rows are all excluded.
    expect(batched.filter((r) => r.trackingKeywordId === "kw_1")).toHaveLength(
      1,
    );
  });

  it("issues no statement for an empty id list", async () => {
    const executed = vi.spyOn(client, "execute");
    expect(await queries.getKeywordHistoryForKeywords("cfg", [], 90)).toEqual(
      [],
    );
    expect(executed).not.toHaveBeenCalled();
    executed.mockRestore();
  });
});
