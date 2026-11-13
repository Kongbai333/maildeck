import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import type {
  AccountInput,
  AccountUpdateInput,
  ListMessagesOptions
} from "../../shared/mail-contracts.js";
import { parseAccountImport } from "../../shared/import-parser.js";
import {
  deleteAccount,
  listAccounts,
  previewAccounts,
  updateAccount,
  upsertAccounts
} from "./account-service.js";
import { ensureAdminUser, readIdentity, setIdentity } from "./auth-service.js";
import { clearCache, getCacheStats } from "./cache-service.js";
import { createGroup, deleteGroup, listGroups } from "./group-service.js";
import {
  clearMailbox,
  createProvider,
  deleteMailbox,
  deleteMailboxMessage,
  deleteProvider,
  ensureDefaultPublicProvider,
  fetchProviderPublicKey,
  generateMailbox,
  getMailboxMessage,
  listMailboxMessages,
  listMailboxes,
  listProviderDomains,
  listProviders,
  listProviderTypes,
  refreshPublicProviderKeys
} from "./domain-service.js";
import { serverConfig } from "./config.js";
import {
  beginDeviceCode,
  cancelDeviceCode,
  getDeviceCodeState
} from "./device-code-service.js";
import {
  asRecord,
  HttpError,
  ok,
  readString,
  readStringArray,
  toErrorPayload
} from "./http-utils.js";
import {
  downloadAttachment,
  getMessage,
  listAttachments,
  listFolders,
  listMessages,
  refreshMany,
  testAccount,
  testFallback,
  testMany
} from "./mail-service.js";
import { registerAdminRoutes } from "./routes-admin.js";
import { registerAuthRoutes } from "./routes-auth.js";
import { registerMeRoutes } from "./routes-me.js";
import { registerOnlinePlayFollowRoutes } from "./online-play-follows.js";
import { getSettings, updateSettings } from "./settings-service.js";

const PUBLIC_API_PATHS = new Set(["/api/health", "/api/auth/login", "/api/auth/logout"]);

function readImportText(value: unknown): string {
  const text = readString(value, "text", 10 * 1024 * 1024);
  if (Buffer.byteLength(text, "utf8") > 10 * 1024 * 1024) {
    throw new HttpError(400, "INVALID_REQUEST", "导入文件不能超过 10 MiB");
  }
  return text;
}

function readTags(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new HttpError(400, "INVALID_REQUEST", "tags 必须是字符串数组");
  }
  return value as string[];
}

function readAccountInput(value: unknown): AccountInput {
  const input = asRecord(value);
  return {
    email: readString(input.email, "email"),
    clientId: readString(input.clientId, "clientId"),
    refreshToken: readString(input.refreshToken, "refreshToken"),
    remark: typeof input.remark === "string" ? input.remark : undefined,
    group: typeof input.group === "string" ? input.group : undefined,
    tags: readTags(input.tags)
  };
}

function readAccountUpdate(value: unknown, id: string): AccountUpdateInput {
  const input = asRecord(value);
  return {
    id,
    email: readString(input.email, "email"),
    clientId: readString(input.clientId, "clientId"),
    refreshToken: typeof input.refreshToken === "string" ? input.refreshToken : undefined,
    remark: typeof input.remark === "string" ? input.remark : undefined,
    group: typeof input.group === "string" ? input.group : undefined,
    tags: readTags(input.tags)
  };
}

/** 会话/角色统一入口：/api/me 放行任意登录用户，/api/admin 与遗留接口只放行管理员。 */
function registerAccessPolicy(app: FastifyInstance): void {
  app.addHook("onRequest", async (request, reply) => {
    const url = request.url.split("?")[0] ?? "";
    if (!url.startsWith("/api") || request.method === "OPTIONS" || PUBLIC_API_PATHS.has(url)) {
      return;
    }
    const identity = readIdentity(request.headers);
    if (!identity) {
      return reply.status(401).send({
        ok: false,
        error: { code: "UNAUTHORIZED", message: "请先登录", retryable: false }
      });
    }
    const needsUserSession = url.startsWith("/api/me") || url === "/api/auth/me" || url === "/api/auth/password";
    if (needsUserSession && !identity.userId) {
      return reply.status(403).send({
        ok: false,
        error: { code: "FORBIDDEN", message: "请使用账号登录后访问", retryable: false }
      });
    }
    const needsAdmin =
      url.startsWith("/api/admin") ||
      url.startsWith("/api/auth/device-code") ||
      (!needsUserSession && !url.startsWith("/api/auth/"));
    if (needsAdmin && identity.role !== "admin") {
      return reply.status(403).send({
        ok: false,
        error: { code: "FORBIDDEN", message: "需要管理员权限", retryable: false }
      });
    }
    setIdentity(request, identity);
  });
}

export function buildServer(): FastifyInstance {
  const app = Fastify({
    logger: true,
    bodyLimit: 12 * 1024 * 1024
  });

  void app.register(cors, {
    origin: serverConfig.corsOrigins,
    credentials: true
  });

  // 允许空 body 的 JSON 请求：DELETE/无参 POST 带上 application/json 时不再直接 400。
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    const text = typeof body === "string" ? body.trim() : "";
    if (text === "") {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(text) as unknown);
    } catch (error) {
      done(error instanceof Error ? error : new Error(String(error)), undefined);
    }
  });

  registerAccessPolicy(app);

  app.setErrorHandler((error, request, reply) => {
    const payload = toErrorPayload(error);
    const candidate = error as { statusCode?: unknown };
    const statusCode =
      error instanceof HttpError
        ? error.statusCode
        : typeof candidate.statusCode === "number" && candidate.statusCode >= 400
          ? candidate.statusCode
          : 500;
    if (statusCode >= 500) {
      request.log.error(error);
    } else {
      request.log.info({ err: error, url: request.url }, "request rejected");
    }
    reply.status(statusCode).send({ ok: false, error: payload });
  });

  app.get("/api/health", async () => ({
    ok: true,
    value: {
      service: "maildeck-server",
      version: "0.4.0",
      time: new Date().toISOString(),
      dataDir: serverConfig.dataDir
    }
  }));

  registerAuthRoutes(app);
  registerMeRoutes(app);
  registerOnlinePlayFollowRoutes(app);
  registerAdminRoutes(app);

  // ── 遗留接口：桌面端/旧网页使用的账号与邮件能力，仅管理员或 Bearer Token 可访问 ──
  app.get("/api/accounts", async () => ok(listAccounts()));

  app.get("/api/groups", async () => ok(listGroups()));

  app.post("/api/groups", async (request) => {
    const body = asRecord(request.body);
    const name = readString(body.name, "name");
    const category = typeof body.category === "string" ? body.category : "all";
    return ok(createGroup(name, category));
  });

  app.delete("/api/groups/:id", async (request) => {
    const params = request.params as { id: string };
    return ok(deleteGroup(params.id));
  });

  app.get("/api/domain-provider-types", async () => ok(listProviderTypes()));

  app.get("/api/domain-public-key", async (request) => {
    const query = request.query as { type?: string; baseUrl?: string };
    return ok(await fetchProviderPublicKey(readString(query.type, "type"), query.baseUrl));
  });

  app.get("/api/domain-providers", async () => ok(listProviders()));

  app.post("/api/domain-providers/refresh-keys", async () =>
    ok({ refreshed: await refreshPublicProviderKeys() })
  );

  app.post("/api/domain-providers", async (request) => {
    const body = asRecord(request.body);
    return ok(
      createProvider({
        name: typeof body.name === "string" ? body.name : "",
        type: readString(body.type, "type"),
        baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : undefined,
        apiKey: readString(body.apiKey, "apiKey"),
        keyMode: body.keyMode === "personal" ? "personal" : "public"
      })
    );
  });

  app.delete("/api/domain-providers/:id", async (request) => {
    const params = request.params as { id: string };
    return ok(deleteProvider(params.id));
  });

  app.get("/api/domain-providers/:id/domains", async (request) => {
    const params = request.params as { id: string };
    return ok(await listProviderDomains(params.id));
  });

  app.get("/api/domain-mailboxes", async () => ok(listMailboxes()));

  app.post("/api/domain-mailboxes", async (request) => {
    const body = asRecord(request.body);
    return ok(
      await generateMailbox({
        providerId: readString(body.providerId, "providerId"),
        prefix: typeof body.prefix === "string" ? body.prefix : undefined,
        domain: typeof body.domain === "string" ? body.domain : undefined,
        remark: typeof body.remark === "string" ? body.remark : undefined
      })
    );
  });

  app.delete("/api/domain-mailboxes/:id", async (request) => {
    const params = request.params as { id: string };
    return ok(deleteMailbox(params.id));
  });

  app.get("/api/domain-mailboxes/:id/messages", async (request) => {
    const params = request.params as { id: string };
    return ok(await listMailboxMessages(params.id));
  });

  app.get("/api/domain-mailboxes/:id/messages/:messageId", async (request) => {
    const params = request.params as { id: string; messageId: string };
    return ok(await getMailboxMessage(params.id, params.messageId));
  });

  app.delete("/api/domain-mailboxes/:id/messages/:messageId", async (request) => {
    const params = request.params as { id: string; messageId: string };
    await deleteMailboxMessage(params.id, params.messageId);
    return ok({ deleted: true });
  });

  app.delete("/api/domain-mailboxes/:id/messages", async (request) => {
    const params = request.params as { id: string };
    await clearMailbox(params.id);
    return ok({ cleared: true });
  });

  app.post("/api/accounts/preview", async (request) => {
    const body = asRecord(request.body);
    return ok(previewAccounts(parseAccountImport(readImportText(body.text))));
  });

  app.post("/api/accounts/import", async (request) => {
    const body = asRecord(request.body);
    return ok(upsertAccounts(parseAccountImport(readImportText(body.text))));
  });

  app.post("/api/accounts", async (request) => {
    const body = asRecord(request.body);
    return ok(upsertAccounts([readAccountInput(body.input)]));
  });

  app.patch("/api/accounts/:id", async (request) => {
    const params = request.params as { id: string };
    return ok(updateAccount(readAccountUpdate(request.body, params.id)));
  });

  app.delete("/api/accounts/:id", async (request) => {
    const params = request.params as { id: string };
    return ok(deleteAccount(params.id));
  });

  app.post("/api/accounts/:id/test", async (request) => {
    const params = request.params as { id: string };
    return ok(await testAccount(params.id));
  });

  app.post("/api/accounts/:id/test-fallback", async (request) => {
    const params = request.params as { id: string };
    return ok(await testFallback(params.id));
  });

  app.post("/api/accounts/test-many", async (request) => {
    const body = asRecord(request.body);
    return ok(await testMany(readStringArray(body.accountIds, "accountIds")));
  });

  app.post("/api/accounts/refresh-many", async (request) => {
    const body = asRecord(request.body);
    return ok(await refreshMany(readStringArray(body.accountIds, "accountIds")));
  });

  app.get("/api/mail/folders", async (request) => {
    const query = request.query as { accountId?: string };
    return ok(await listFolders(readString(query.accountId, "accountId")));
  });

  app.post("/api/mail/list", async (request) => {
    const body = asRecord(request.body);
    const options = body as unknown as ListMessagesOptions;
    if (typeof options.accountId !== "string" || !options.accountId) {
      throw new HttpError(400, "INVALID_REQUEST", "accountId 必须是非空字符串");
    }
    return ok(await listMessages(options));
  });

  app.post("/api/mail/message", async (request) => {
    const body = asRecord(request.body);
    const accountId = readString(body.accountId, "accountId");
    const messageId = readString(body.messageId, "messageId");
    return ok(
      await getMessage({
        accountId,
        messageId,
        folderId: typeof body.folderId === "string" ? body.folderId : undefined
      })
    );
  });

  app.post("/api/mail/attachments", async (request) => {
    const body = asRecord(request.body);
    return ok(
      await listAttachments({
        accountId: readString(body.accountId, "accountId"),
        messageId: readString(body.messageId, "messageId"),
        folderId: typeof body.folderId === "string" ? body.folderId : undefined
      })
    );
  });

  app.get("/api/mail/attachment", async (request, reply) => {
    const query = request.query as {
      accountId?: string;
      messageId?: string;
      attachmentId?: string;
      name?: string;
      contentType?: string;
    };
    const bytes = await downloadAttachment(
      readString(query.accountId, "accountId"),
      readString(query.messageId, "messageId"),
      readString(query.attachmentId, "attachmentId")
    );
    reply.header("Content-Type", query.contentType || "application/octet-stream");
    reply.header(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(query.name || "attachment")}`
    );
    return reply.send(Buffer.from(bytes));
  });

  app.get("/api/mail/cache-stats", async () => ok(getCacheStats()));

  app.delete("/api/mail/cache", async (request) => {
    const query = request.query as { accountId?: string };
    clearCache(query.accountId);
    return ok({ cleared: query.accountId ?? "all" });
  });

  app.get("/api/settings", async () => ok(getSettings()));

  app.put("/api/settings", async (request) => {
    const body = asRecord(request.body);
    return ok(updateSettings(body));
  });

  app.post("/api/jobs/cancel", async (request) => {
    const body = asRecord(request.body);
    const kind = typeof body.kind === "string" ? body.kind : "refresh";
    return ok({ canceled: kind, count: 0 });
  });

  app.post("/api/auth/device-code/start", async () => ok(await beginDeviceCode()));
  app.get("/api/auth/device-code/state", async () => ok(getDeviceCodeState()));
  app.post("/api/auth/device-code/cancel", async () => ok(cancelDeviceCode()));

  // ── 静态前端：托管 webapp/dist 网页构建产物 ──
  const webRoot = serverConfig.webRoots
    .map((candidate) => path.resolve(process.cwd(), candidate))
    .find((candidate) => existsSync(path.join(candidate, "index.html")));

  if (webRoot) {
    void app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/"
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api")) {
        reply
          .status(404)
          .send({ ok: false, error: { code: "NOT_FOUND", message: "接口不存在", retryable: false } });
        return;
      }
      void reply.sendFile("index.html");
    });
  }

  ensureAdminUser();

  return app;
}

async function main() {
  const app = buildServer();
  try {
    await app.listen({ host: serverConfig.host, port: serverConfig.port });
    console.log(`MailDeck server listening on http://${serverConfig.host}:${serverConfig.port}`);
    console.log(`Data directory: ${serverConfig.dataDir}`);
    void ensureDefaultPublicProvider()
      .then(() => refreshPublicProviderKeys())
      .then((count: number) => {
        if (count > 0) {
          console.log(`Refreshed ${count} public mailbox API key(s)`);
        }
      })
      .catch((refreshError: unknown) => {
        console.warn("Public mailbox key refresh skipped", refreshError);
      });
  } catch (error) {
    app.log.error(error);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
