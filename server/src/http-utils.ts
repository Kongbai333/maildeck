export type ErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "INVALID_REQUEST"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "UPSTREAM"
  | "UNKNOWN";

export interface ApiErrorPayload {
  code: ErrorCode;
  message: string;
  retryable: boolean;
}

export interface ApiSuccess<T> {
  ok: true;
  value: T;
}

export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly retryable: boolean;

  constructor(statusCode: number, code: ErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
    this.retryable = retryable;
  }
}

export function invalid(message: string): HttpError {
  return new HttpError(400, "INVALID_REQUEST", message);
}

export function unauthorized(message = "请先登录"): HttpError {
  return new HttpError(401, "UNAUTHORIZED", message);
}

export function forbidden(message = "没有权限执行该操作"): HttpError {
  return new HttpError(403, "FORBIDDEN", message);
}

export function notFound(message = "资源不存在"): HttpError {
  return new HttpError(404, "NOT_FOUND", message);
}

export function conflict(message: string): HttpError {
  return new HttpError(409, "CONFLICT", message);
}

export function rateLimited(message: string): HttpError {
  return new HttpError(429, "RATE_LIMITED", message, true);
}

export function ok<T>(value: T): ApiSuccess<T> {
  return { ok: true, value };
}

export function asRecord(value: unknown, name = "请求体"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(`${name}必须是 JSON 对象`);
  }
  return value as Record<string, unknown>;
}

export function readString(value: unknown, name: string, maxLength = 512): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalid(`${name}必须是非空字符串`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw invalid(`${name}长度不能超过 ${maxLength} 个字符`);
  }
  return trimmed;
}

export function readOptionalString(value: unknown, name: string, maxLength = 512): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw invalid(`${name}必须是字符串`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw invalid(`${name}长度不能超过 ${maxLength} 个字符`);
  }
  return trimmed;
}

export function readInteger(
  value: unknown,
  name: string,
  options: { min?: number; max?: number; fallback?: number } = {}
): number {
  if (value === undefined || value === null || value === "") {
    if (options.fallback !== undefined) {
      return options.fallback;
    }
    throw invalid(`${name}必须是整数`);
  }
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw invalid(`${name}必须是整数`);
  }
  if (options.min !== undefined && parsed < options.min) {
    throw invalid(`${name}不能小于 ${options.min}`);
  }
  if (options.max !== undefined && parsed > options.max) {
    throw invalid(`${name}不能大于 ${options.max}`);
  }
  return parsed;
}

export function readStringArray(value: unknown, name: string, maxItems = 5_000): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw invalid(`${name}必须是字符串数组`);
  }
  if (value.length > maxItems) {
    throw invalid(`${name}最多包含 ${maxItems} 项`);
  }
  return (value as string[]).map((item) => item.trim()).filter(Boolean);
}

export function readEnum<T extends string>(value: unknown, name: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw invalid(`${name}必须是 ${allowed.join(" / ")} 之一`);
  }
  return value as T;
}

export function toErrorPayload(error: unknown): ApiErrorPayload {
  if (error instanceof HttpError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 4_096);
  return { code: "UNKNOWN", message: message || "服务端请求失败", retryable: false };
}
