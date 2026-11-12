import type { FastifyInstance } from "fastify";
import { requireUserRow } from "./auth-service.js";
import { listProviderOptions } from "./domain-service.js";
import { importOutlookForUser } from "./outlook-pool.js";
import { asRecord, forbidden, ok, readEnum, readInteger, readOptionalString, readString } from "./http-utils.js";
import { listOnlineHosts, listOnlinePlatforms } from "./online-play-service.js";
import {
  acquireMailboxForUser,
  claimMailbox,
  updateMailboxTags,
  clearInbox,
  deleteMessage,
  generateMailboxesForUser,
  getOwnedMailboxId,
  listUserMailboxes,
  mailboxMessageDetail,
  mailboxMessages,
  releaseMailbox
} from "./mailbox-service.js";

export function registerMeRoutes(app: FastifyInstance): void {
  app.get("/api/me/providers", async (request) => {
    requireUserRow(request);
    return ok(listProviderOptions());
  });

  // ── 在线播放（第三方聚合接口）：需管理员或该账号被授予 canOnlinePlay 权限 ──
  const assertOnlinePlay = (request: Parameters<typeof requireUserRow>[0]) => {
    const user = requireUserRow(request);
    if (user.role !== "admin" && Number(user.can_online_play ?? 0) !== 1) {
      throw forbidden("当前账号没有「在线播放」权限，请联系管理员开通");
    }
    return user;
  };

  app.get("/api/me/online-play/platforms", async (request) => {
    assertOnlinePlay(request);
    return ok(await listOnlinePlatforms());
  });

  app.get("/api/me/online-play/hosts", async (request) => {
    assertOnlinePlay(request);
    const query = request.query as { platform?: string };
    return ok(await listOnlineHosts(readString(query.platform, "平台", 128)));
  });

  app.get("/api/me/mailboxes", async (request) => {
    const user = requireUserRow(request);
    return ok(listUserMailboxes(user.id));
  });

  app.post("/api/me/mailboxes/import", async (request) => {
    const user = requireUserRow(request);
    const body = asRecord(request.body);
    const text = readString(body.text, "导入内容", 1_000_000);
    return ok(importOutlookForUser(user, text));
  });

  app.post("/api/me/mailboxes/generate", async (request) => {
    const user = requireUserRow(request);
    const body = asRecord(request.body);
    const providerId = readString(body.providerId, "服务商", 128);
    const prefix = readOptionalString(body.prefix, "前缀", 64);
    const count = readInteger(body.count, "生成数量", { min: 1, max: 5, fallback: 1 });
    return ok(await generateMailboxesForUser(user, { providerId, prefix, count }));
  });

  app.post("/api/me/mailboxes/acquire", async (request) => {
    const user = requireUserRow(request);
    const body = asRecord(request.body);
    const kind = readEnum(body.kind, "邮箱类型", ["outlook", "domain", "temp"] as const);
    const providerId = readOptionalString(body.providerId, "服务商", 128);
    return ok(await acquireMailboxForUser(user, { kind, providerId }));
  });

  app.post("/api/me/mailboxes/claim", async (request) => {
    const user = requireUserRow(request);
    return ok({ mailbox: claimMailbox(user) });
  });

  app.post("/api/me/mailboxes/:id/release", async (request) => {
    const user = requireUserRow(request);
    const params = request.params as { id: string };
    await releaseMailbox(user, params.id);
    return ok({ ok: true });
  });

  app.patch("/api/me/mailboxes/:id/tags", async (request) => {
    const user = requireUserRow(request);
    const params = request.params as { id: string };
    const mailboxId = getOwnedMailboxId(user.id, params.id);
    const body = asRecord(request.body);
    return ok(updateMailboxTags(mailboxId, body.tags));
  });

  app.get("/api/me/mailboxes/:id/messages", async (request) => {
    const user = requireUserRow(request);
    const params = request.params as { id: string };
    const mailboxId = getOwnedMailboxId(user.id, params.id);
    return ok(await mailboxMessages(mailboxId));
  });

  app.get("/api/me/mailboxes/:id/messages/:messageId", async (request) => {
    const user = requireUserRow(request);
    const params = request.params as { id: string; messageId: string };
    const mailboxId = getOwnedMailboxId(user.id, params.id);
    return ok(await mailboxMessageDetail(mailboxId, params.messageId));
  });

  app.delete("/api/me/mailboxes/:id/messages/:messageId", async (request) => {
    const user = requireUserRow(request);
    const params = request.params as { id: string; messageId: string };
    const mailboxId = getOwnedMailboxId(user.id, params.id);
    await deleteMessage(mailboxId, params.messageId);
    return ok({ deleted: true });
  });

  app.delete("/api/me/mailboxes/:id/messages", async (request) => {
    const user = requireUserRow(request);
    const params = request.params as { id: string };
    const mailboxId = getOwnedMailboxId(user.id, params.id);
    await clearInbox(mailboxId);
    return ok({ cleared: true });
  });
}
