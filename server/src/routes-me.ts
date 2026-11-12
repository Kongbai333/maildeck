import type { FastifyInstance } from "fastify";
import { Readable } from "node:stream";
import { requireUserRow } from "./auth-service.js";
import { listProviderOptions } from "./domain-service.js";
import { importOutlookForUser } from "./outlook-pool.js";
import {
  asRecord,
  forbidden,
  HttpError,
  invalid,
  ok,
  readEnum,
  readInteger,
  readOptionalString,
  readString
} from "./http-utils.js";
import { isKnownStreamHost, listOnlineHosts, listOnlinePlatforms } from "./online-play-service.js";
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

  /**
   * 直播流同源代理。
   * 目的：① HTTPS 页面里播放 http:// 直播流会被浏览器按混合内容拦截，代理后变成同源同协议；
   *      ② 代理到上游由服务端建连（不限 6 条/主机），前端可用 HTTP/2 复用连接，多路预览才跑得起来。
   * 只允许代理「频道列表里出现过的主机」，避免被当成任意 URL 代理。
   */
  app.get("/api/me/online-play/stream", async (request, reply) => {
    assertOnlinePlay(request);
    const query = request.query as { url?: string };
    const raw = readString(query.url, "流地址", 4096);

    let target: URL;
    try {
      target = new URL(raw);
    } catch {
      throw invalid("流地址不合法");
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      throw invalid("只支持 http/https 直播流");
    }
    if (!/\.(flv|ts)(\?|$)/iu.test(target.pathname)) {
      throw invalid("只支持 flv / ts 直播流");
    }
    if (!isKnownStreamHost(target.host)) {
      throw forbidden("该流地址不在已知频道列表内");
    }

    const controller = new AbortController();
    const abort = (): void => controller.abort();
    request.raw.once("close", abort);
    reply.raw.once("close", abort);

    try {
      const upstream = await fetch(target.toString(), {
        headers: {
          "user-agent": "Mozilla/5.0 MailDeck/0.4",
          accept: "*/*",
          referer: `${target.protocol}//${target.host}/`
        },
        redirect: "follow",
        signal: controller.signal
      });
      if (!upstream.ok || upstream.body === null) {
        throw new HttpError(502, "UPSTREAM", `上游直播流返回 HTTP ${upstream.status}`, true);
      }
      reply.header("content-type", upstream.headers.get("content-type") || "video/x-flv");
      reply.header("cache-control", "no-store");
      reply.header("x-accel-buffering", "no");
      return reply.send(Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]));
    } catch (error) {
      if (controller.signal.aborted) {
        return reply.send();
      }
      throw new HttpError(
        502,
        "UPSTREAM",
        `无法连接直播流：${error instanceof Error ? error.message : String(error)}`,
        true
      );
    }
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
