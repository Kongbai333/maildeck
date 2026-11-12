import type { FastifyInstance } from "fastify";
import {
  changeOwnPassword,
  clearSessionCookie,
  createSession,
  destroySession,
  isSecureRequest,
  readCookie,
  readIdentity,
  requireUserRow,
  serializeSessionCookie,
  SESSION_COOKIE,
  toSessionUser,
  verifyCredentials
} from "./auth-service.js";
import { asRecord, invalid, ok, readString, unauthorized } from "./http-utils.js";

export function registerAuthRoutes(app: FastifyInstance): void {
  app.post("/api/auth/login", async (request, reply) => {
    const body = asRecord(request.body);
    const username = readString(body.username, "用户名", 64);
    const password = readString(body.password, "密码", 128);
    const row = verifyCredentials(username, password, request.ip);
    const session = createSession(row.id, {
      userAgent: String(request.headers["user-agent"] ?? ""),
      ip: request.ip
    });
    reply.header(
      "set-cookie",
      serializeSessionCookie(session.token, isSecureRequest(request.protocol, request.headers["x-forwarded-proto"]))
    );
    return ok(toSessionUser(row));
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    if (token) {
      destroySession(token);
    }
    reply.header(
      "set-cookie",
      clearSessionCookie(isSecureRequest(request.protocol, request.headers["x-forwarded-proto"]))
    );
    return ok({ ok: true });
  });

  app.get("/api/auth/me", async (request) => {
    const identity = readIdentity(request.headers);
    if (!identity) {
      throw unauthorized("登录状态已失效，请重新登录");
    }
    if (!identity.userId) {
      throw unauthorized("请使用账号登录后访问");
    }
    const row = requireUserRow(request);
    return ok(toSessionUser(row));
  });

  app.post("/api/auth/password", async (request, reply) => {
    const row = requireUserRow(request);
    const body = asRecord(request.body);
    if (body.currentPassword === undefined || body.newPassword === undefined) {
      throw invalid("请填写当前密码与新密码");
    }
    changeOwnPassword(row.id, body.currentPassword, body.newPassword);
    reply.header(
      "set-cookie",
      clearSessionCookie(isSecureRequest(request.protocol, request.headers["x-forwarded-proto"]))
    );
    return ok({ ok: true });
  });
}
