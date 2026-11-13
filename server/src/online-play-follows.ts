import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { requireUserRow } from "./auth-service.js";
import { getDb, transaction } from "./db.js";
import { asRecord, conflict, forbidden, invalid, ok, readString } from "./http-utils.js";

interface OnlinePlayFollow {
  id: string;
  title: string;
  cover: string;
  address: string;
  platformAddress: string;
  platformTitle: string;
  createdAt: string;
}

type FollowInput = Omit<OnlinePlayFollow, "id" | "createdAt">;

const MAX_FOLLOWS = 500;
const FOLLOW_COLUMNS = `id, title, cover, address,
  platform_address AS platformAddress, platform_title AS platformTitle,
  created_at AS createdAt`;

function ensureFollowsDb(): ReturnType<typeof getDb> {
  const db = getDb();
  // Ensure on the current connection: tests and restarts may replace the database.
  db.exec(`
    CREATE TABLE IF NOT EXISTS online_play_follows (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      cover TEXT NOT NULL,
      address TEXT NOT NULL,
      platform_address TEXT NOT NULL,
      platform_title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (user_id, platform_address, title)
    )
  `);
  return db;
}

function assertOnlinePlay(request: Parameters<typeof requireUserRow>[0]) {
  const user = requireUserRow(request);
  if (user.role !== "admin" && Number(user.can_online_play ?? 0) !== 1) {
    throw forbidden("当前账号没有「在线播放」权限，请联系管理员开通");
  }
  return user;
}

function readHttpAddress(value: unknown, name: string, allowEmpty = false): string {
  // Upstream hosts may have no cover image; persist that as an empty string.
  if (allowEmpty && typeof value === "string" && value.trim() === "") {
    return "";
  }
  const address = readString(value, name, 8192);
  try {
    const url = new URL(address);
    if (/^https?:\/\//i.test(address) && (url.protocol === "http:" || url.protocol === "https:")) {
      return address;
    }
  } catch {
    // Report malformed URLs with the same request-validation error as other fields.
  }
  throw invalid(`${name}必须是有效的 HTTP(S) 地址`);
}

function readFollowInput(value: unknown): FollowInput {
  const body = asRecord(value);
  const platformAddress = readString(body.platformAddress, "platformAddress", 128);
  if (!/^[A-Za-z0-9_-]+\.txt$/.test(platformAddress)) {
    throw invalid("platformAddress 必须是有效的平台文件名");
  }
  return {
    title: readString(body.title, "title", 256),
    cover: readHttpAddress(body.cover, "cover", true),
    address: readHttpAddress(body.address, "address"),
    platformAddress,
    platformTitle: readString(body.platformTitle, "platformTitle", 256)
  };
}

function upsertFollow(userId: string, input: FollowInput): OnlinePlayFollow {
  const db = ensureFollowsDb();
  return transaction(() => {
    const existing = db.prepare(`
      SELECT id FROM online_play_follows
      WHERE user_id = ? AND platform_address = ? AND title = ?
    `).get(userId, input.platformAddress, input.title);
    if (!existing) {
      const count = db.prepare(
        "SELECT COUNT(*) AS count FROM online_play_follows WHERE user_id = ?"
      ).get(userId) as { count: number };
      if (count.count >= MAX_FOLLOWS) {
        throw conflict(`每个账号最多关注 ${MAX_FOLLOWS} 位主播`);
      }
    }
    const follow = db.prepare(`
      INSERT INTO online_play_follows
        (id, user_id, title, cover, address, platform_address, platform_title, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id, platform_address, title) DO UPDATE SET
        cover = excluded.cover,
        address = excluded.address,
        platform_title = excluded.platform_title
      RETURNING ${FOLLOW_COLUMNS}
    `).get(
      randomUUID(), userId, input.title, input.cover, input.address,
      input.platformAddress, input.platformTitle, new Date().toISOString()
    ) as unknown as OnlinePlayFollow;
    return follow;
  });
}

export function registerOnlinePlayFollowRoutes(app: FastifyInstance): void {
  app.get("/api/me/online-play/follows", async (request) => {
    const user = assertOnlinePlay(request);
    const db = ensureFollowsDb();
    const follows = db.prepare(`
      SELECT ${FOLLOW_COLUMNS} FROM online_play_follows
      WHERE user_id = ? ORDER BY created_at DESC, id DESC
    `).all(user.id) as unknown as OnlinePlayFollow[];
    return ok(follows);
  });

  app.post("/api/me/online-play/follows", async (request) => {
    const user = assertOnlinePlay(request);
    return ok(upsertFollow(user.id, readFollowInput(request.body)));
  });

  app.delete("/api/me/online-play/follows/:id", async (request) => {
    const user = assertOnlinePlay(request);
    const params = request.params as { id: string };
    const id = readString(params.id, "id", 128);
    const db = ensureFollowsDb();
    db.prepare("DELETE FROM online_play_follows WHERE id = ? AND user_id = ?").run(id, user.id);
    return ok({ ok: true });
  });
}
