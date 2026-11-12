import type { FastifyInstance } from "fastify";
import {
  createUser,
  deleteUser,
  listUsers,
  requireAdminIdentity,
  updateUser
} from "./auth-service.js";
import {
  createProvider,
  deleteProvider,
  generateMailboxBatch,
  listProviderDomains,
  listProviderTypes,
  listProviders,
  refreshPublicProviderKeys
} from "./domain-service.js";
import {
  asRecord,
  HttpError,
  invalid,
  ok,
  readEnum,
  readInteger,
  readOptionalString,
  readString,
  readStringArray
} from "./http-utils.js";
import {
  applyBulkAction,
  assignMailbox,
  deleteMailboxes,
  getAdminMailboxViews,
  getAdminMailboxId,
  getOverview,
  getStats,
  importMailboxes,
  listAdminMailboxes,
  listUserMailboxesForAdmin,
  mailboxMessageDetail,
  mailboxMessages,
  updateMailbox,
  updateMailboxTags
} from "./mailbox-service.js";
import { importOutlookAccounts } from "./outlook-pool.js";

function asBadRequest(error: unknown): never {
  if (error instanceof HttpError) {
    throw error;
  }
  throw new HttpError(400, "INVALID_REQUEST", error instanceof Error ? error.message : String(error));
}

async function asUpstream<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    throw new HttpError(502, "UPSTREAM", error instanceof Error ? error.message : String(error), true);
  }
}

export function registerAdminRoutes(app: FastifyInstance): void {
  app.get("/api/admin/overview", async (request) => {
    requireAdminIdentity(request);
    return ok(getOverview());
  });

  app.get("/api/admin/stats", async (request) => {
    requireAdminIdentity(request);
    return ok(getStats());
  });

  // ── 用户 ──
  app.get("/api/admin/users", async (request) => {
    requireAdminIdentity(request);
    const query = request.query as { q?: string };
    return ok(listUsers(typeof query.q === "string" ? query.q : undefined));
  });

  app.post("/api/admin/users", async (request) => {
    requireAdminIdentity(request);
    const body = asRecord(request.body);
    return ok(
      createUser({
        username: body.username,
        password: body.password,
        role: body.role,
        mailboxQuota: body.mailboxQuota,
        quotas: body.quotas,
        resetUsage: body.resetUsage,
        canOnlinePlay: body.canOnlinePlay
      })
    );
  });

  app.patch("/api/admin/users/:id", async (request) => {
    requireAdminIdentity(request);
    const params = request.params as { id: string };
    const body = asRecord(request.body);
    return ok(
      updateUser(params.id, {
        password: body.password,
        role: body.role,
        status: body.status,
        mailboxQuota: body.mailboxQuota,
        quotas: body.quotas,
        resetUsage: body.resetUsage,
        canOnlinePlay: body.canOnlinePlay
      })
    );
  });

  app.delete("/api/admin/users/:id", async (request) => {
    const identity = requireAdminIdentity(request);
    const params = request.params as { id: string };
    deleteUser(params.id, identity.userId ?? "");
    return ok({ ok: true });
  });

  app.get("/api/admin/users/:id/mailboxes", async (request) => {
    requireAdminIdentity(request);
    const params = request.params as { id: string };
    return ok(listUserMailboxesForAdmin(params.id));
  });

  // ── 邮箱池（默认只含 Outlook 账号）──
  app.get("/api/admin/mailboxes", async (request) => {
    requireAdminIdentity(request);
    const query = request.query as { status?: string; q?: string; kind?: string };
    return ok(
      listAdminMailboxes({
        status: typeof query.status === "string" ? query.status : undefined,
        q: typeof query.q === "string" ? query.q : undefined,
        kind: typeof query.kind === "string" ? query.kind : undefined
      })
    );
  });

  // ── Outlook 账号池：导入微软账号（email----password----clientId----refreshToken）──
  app.post("/api/admin/outlook/import", async (request) => {
    requireAdminIdentity(request);
    const body = asRecord(request.body);
    const text = readString(body.text, "导入内容", 10 * 1024 * 1024);
    const userId = readOptionalString(body.userId, "用户", 128) ?? null;
    return ok(importOutlookAccounts(text, userId));
  });

  app.post("/api/admin/mailboxes/generate", async (request) => {
    requireAdminIdentity(request);
    const body = asRecord(request.body);
    const providerId = readString(body.providerId, "服务商", 128);
    const count = readInteger(body.count, "生成数量", { min: 1, max: 20, fallback: 1 });
    const prefix = readOptionalString(body.prefix, "前缀", 64);
    const domain = readOptionalString(body.domain, "域名", 128);
    const remark = readOptionalString(body.remark, "备注", 500);
    const result = await generateMailboxBatch({ providerId, prefix, domain, count, remark });
    return ok({
      created: getAdminMailboxViews(result.mailboxes.map((item) => item.id)),
      errors: result.errors
    });
  });

  app.post("/api/admin/mailboxes/import", async (request) => {
    const identity = requireAdminIdentity(request);
    const body = asRecord(request.body);
    const providerId = readString(body.providerId, "服务商", 128);
    const text = readString(body.text, "导入内容", 2_000_000);
    return ok(importMailboxes({ providerId, text, actorId: identity.userId ?? "" }));
  });

  // ── 邮箱池批量操作（delete / disable / enable / assign / unassign）──
  app.post("/api/admin/mailboxes/bulk", async (request) => {
    const identity = requireAdminIdentity(request);
    const body = asRecord(request.body);
    const action = readEnum(body.action, "操作", ["delete", "disable", "enable", "assign", "unassign"] as const);
    const ids = readStringArray(body.ids, "ids", 5_000);
    const userId = body.userId === null || body.userId === undefined ? null : readString(body.userId, "用户", 128);
    return ok(applyBulkAction({ action, ids, userId, actorId: identity.userId ?? "" }));
  });

  app.post("/api/admin/mailboxes/bulk-delete", async (request) => {
    const identity = requireAdminIdentity(request);
    const body = asRecord(request.body);
    const ids = readStringArray(body.ids, "ids", 5_000);
    return ok({ deleted: deleteMailboxes(ids, identity.userId ?? "") });
  });

  app.post("/api/admin/mailboxes/:id/assign", async (request) => {
    const identity = requireAdminIdentity(request);
    const params = request.params as { id: string };
    const body = asRecord(request.body);
    const userId =
      body.userId === null || body.userId === undefined ? null : readString(body.userId, "用户", 128);
    return ok(assignMailbox(params.id, userId, identity.userId ?? ""));
  });

  app.patch("/api/admin/mailboxes/:id", async (request) => {
    const identity = requireAdminIdentity(request);
    const params = request.params as { id: string };
    const body = asRecord(request.body);
    const remark = readOptionalString(body.remark, "备注", 500);
    const status =
      body.status === undefined
        ? undefined
        : readEnum(body.status, "状态", ["available", "disabled", "assigned"] as const);
    if (remark === undefined && status === undefined) {
      throw invalid("没有需要修改的字段");
    }
    return ok(updateMailbox(params.id, { remark, status }, identity.userId ?? ""));
  });

  app.patch("/api/admin/mailboxes/:id/tags", async (request) => {
    requireAdminIdentity(request);
    const params = request.params as { id: string };
    const body = asRecord(request.body);
    getAdminMailboxId(params.id);
    return ok(updateMailboxTags(params.id, body.tags));
  });

  app.delete("/api/admin/mailboxes/:id", async (request) => {
    const identity = requireAdminIdentity(request);
    const params = request.params as { id: string };
    deleteMailboxes([params.id], identity.userId ?? "");
    return ok({ ok: true });
  });

  app.get("/api/admin/mailboxes/:id/messages", async (request) => {
    requireAdminIdentity(request);
    const params = request.params as { id: string };
    const mailboxId = getAdminMailboxId(params.id);
    return ok(await mailboxMessages(mailboxId));
  });

  app.get("/api/admin/mailboxes/:id/messages/:messageId", async (request) => {
    requireAdminIdentity(request);
    const params = request.params as { id: string; messageId: string };
    const mailboxId = getAdminMailboxId(params.id);
    return ok(await mailboxMessageDetail(mailboxId, params.messageId));
  });

  // ── 服务商 ──
  app.get("/api/admin/provider-types", async (request) => {
    requireAdminIdentity(request);
    return ok(listProviderTypes());
  });

  app.get("/api/admin/providers", async (request) => {
    requireAdminIdentity(request);
    return ok(listProviders());
  });

  app.post("/api/admin/providers", async (request) => {
    requireAdminIdentity(request);
    const body = asRecord(request.body);
    try {
      return ok(
        createProvider({
          name: readOptionalString(body.name, "名称", 64) ?? "",
          type: readString(body.type, "服务商类型", 64),
          baseUrl: readOptionalString(body.baseUrl, "Base URL", 256),
          apiKey: readOptionalString(body.apiKey, "API Key / 密码", 512) ?? "",
          apiKeys: body.apiKeys,
          keyMode: body.keyMode === "personal" ? "personal" : "public",
          meta: body.meta
        })
      );
    } catch (error) {
      asBadRequest(error);
    }
  });

  app.delete("/api/admin/providers/:id", async (request) => {
    requireAdminIdentity(request);
    const params = request.params as { id: string };
    try {
      return ok(deleteProvider(params.id));
    } catch (error) {
      asBadRequest(error);
    }
  });

  app.post("/api/admin/providers/refresh-keys", async (request) => {
    requireAdminIdentity(request);
    return ok({ refreshed: await refreshPublicProviderKeys() });
  });

  app.get("/api/admin/providers/:id/domains", async (request) => {
    requireAdminIdentity(request);
    const params = request.params as { id: string };
    return ok(await asUpstream(listProviderDomains(params.id)));
  });
}
