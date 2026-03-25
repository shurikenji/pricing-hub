import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import type { ServerConfig } from "./types";

const ENCRYPTED_PREFIX = "enc:v1";
const SENSITIVE_SERVER_FIELDS: Array<keyof ServerConfig> = ["authToken", "authCookie", "authUserValue"];

function getEncryptionSecret() {
  return process.env.APP_ENCRYPTION_KEY || process.env.ADMIN_SECRET || "";
}

function getEncryptionKey() {
  return createHash("sha256").update(getEncryptionSecret()).digest();
}

function isEncryptedValue(value?: string) {
  return Boolean(value && value.startsWith(`${ENCRYPTED_PREFIX}:`));
}

export function hasPlaintextServerSecrets(config: Partial<ServerConfig>) {
  return SENSITIVE_SERVER_FIELDS.some((field) => {
    const value = config[field];
    return typeof value === "string" && Boolean(value) && !isEncryptedValue(value);
  });
}

export function encryptSecret(value?: string) {
  if (!value || isEncryptedValue(value)) {
    return value;
  }

  const secret = getEncryptionSecret();
  if (!secret) {
    return value;
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENCRYPTED_PREFIX}:${iv.toString("base64url")}:${tag.toString("base64url")}:${encrypted.toString("base64url")}`;
}

export function decryptSecret(value?: string) {
  if (!value || !isEncryptedValue(value)) {
    return value;
  }

  const secret = getEncryptionSecret();
  if (!secret) {
    throw new Error("APP_ENCRYPTION_KEY or ADMIN_SECRET is required to decrypt stored server secrets");
  }

  const [, , ivRaw, tagRaw, encryptedRaw] = value.split(":");
  const decipher = createDecipheriv("aes-256-gcm", getEncryptionKey(), Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function encryptServerSecrets(config: ServerConfig): ServerConfig {
  const next = { ...config };
  for (const field of SENSITIVE_SERVER_FIELDS) {
    const value = next[field];
    next[field] = (typeof value === "string" ? encryptSecret(value) : value) as never;
  }
  return next;
}

export function decryptServerSecrets(config: ServerConfig): ServerConfig {
  const next = { ...config };
  for (const field of SENSITIVE_SERVER_FIELDS) {
    const value = next[field];
    next[field] = (typeof value === "string" ? decryptSecret(value) : value) as never;
  }
  return next;
}

export function redactServerSecrets(config?: Partial<ServerConfig> | null) {
  if (!config) {
    return config;
  }

  const next: Record<string, unknown> = { ...config };
  for (const field of SENSITIVE_SERVER_FIELDS) {
    if (typeof next[field] === "string" && next[field]) {
      next[field] = "***redacted***";
    }
  }
  return next;
}
