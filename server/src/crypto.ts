import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { serverConfig } from "./config.js";

const DEV_KEY_LABEL = "maildeck-local-development-only";
const PREFIX = "v1";

function resolveMasterKey() {
  if (serverConfig.masterKey) {
    const decoded = Buffer.from(serverConfig.masterKey, "base64");
    if (decoded.length !== 32) {
      throw new Error("MAILDECK_MASTER_KEY 必须是 32 字节的 base64 字符串");
    }
    return decoded;
  }

  // 本地开发允许零配置启动；部署时必须显式提供 MAILDECK_MASTER_KEY。
  return createHash("sha256").update(DEV_KEY_LABEL).digest();
}

const masterKey = resolveMasterKey();

export function isUsingDevelopmentKey() {
  return !serverConfig.masterKey;
}

export function encryptSecret(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decryptSecret(value: string): string {
  if (value.startsWith("plain:")) {
    return Buffer.from(value.slice("plain:".length), "base64").toString("utf8");
  }

  const [prefix, ivBase64, tagBase64, ciphertextBase64] = value.split(":");
  if (prefix !== PREFIX || !ivBase64 || !tagBase64 || !ciphertextBase64) {
    throw new Error("不支持的凭据密文格式");
  }

  const decipher = createDecipheriv("aes-256-gcm", masterKey, Buffer.from(ivBase64, "base64"));
  decipher.setAuthTag(Buffer.from(tagBase64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextBase64, "base64")),
    decipher.final()
  ]).toString("utf8");
}
