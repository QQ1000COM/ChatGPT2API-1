"use client";

import localforage from "localforage";

export type AuthRole = "admin" | "user";

export type StoredAuthSession = {
  key: string;
  role: AuthRole;
  subjectId: string;
  name: string;
};

export const AUTH_KEY_STORAGE_KEY = "chatgpt2api_auth_key";
export const AUTH_SESSION_STORAGE_KEY = "chatgpt2api_auth_session";

const authStorage = localforage.createInstance({
  name: "chatgpt2api",
  storeName: "auth",
});

function hasBrowserStorage() {
  return typeof globalThis.window !== "undefined";
}

function readLocalAuthKey() {
  if (!hasBrowserStorage()) return "";
  try {
    return String(globalThis.window.localStorage.getItem(AUTH_KEY_STORAGE_KEY) || "").trim();
  } catch {
    return "";
  }
}

function writeLocalAuthSession(session: StoredAuthSession) {
  if (!hasBrowserStorage()) return;
  try {
    globalThis.window.localStorage.setItem(AUTH_KEY_STORAGE_KEY, session.key);
    globalThis.window.localStorage.setItem(AUTH_SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
  }
}

function readLocalAuthSession() {
  if (!hasBrowserStorage()) return null;
  try {
    return normalizeSession(
      JSON.parse(globalThis.window.localStorage.getItem(AUTH_SESSION_STORAGE_KEY) || "null"),
      readLocalAuthKey(),
    );
  } catch {
    return null;
  }
}

function clearLocalAuthSession() {
  if (!hasBrowserStorage()) return;
  try {
    globalThis.window.localStorage.removeItem(AUTH_KEY_STORAGE_KEY);
    globalThis.window.localStorage.removeItem(AUTH_SESSION_STORAGE_KEY);
  } catch {
  }
}

function normalizeSession(value: unknown, fallbackKey = ""): StoredAuthSession | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<StoredAuthSession>;
  const key = String(candidate.key || fallbackKey || "").trim();
  const role = candidate.role === "admin" || candidate.role === "user" ? candidate.role : null;
  if (!key || !role) {
    return null;
  }

  return {
    key,
    role,
    subjectId: String(candidate.subjectId || "").trim(),
    name: String(candidate.name || "").trim(),
  };
}

export function getDefaultRouteForRole(role: AuthRole) {
  return role === "admin" ? "/accounts" : "/image";
}

export async function getStoredAuthKey() {
  if (!hasBrowserStorage()) {
    return "";
  }
  const localValue = readLocalAuthKey();
  if (localValue) return localValue;
  try {
    const value = await authStorage.getItem<string>(AUTH_KEY_STORAGE_KEY);
    return String(value || "").trim();
  } catch {
    return "";
  }
}

export async function getStoredAuthSession() {
  if (!hasBrowserStorage()) {
    return null;
  }
  const localSession = readLocalAuthSession();
  if (localSession) return localSession;

  let storedKey = "";
  let storedSession: StoredAuthSession | null = null;
  try {
    [storedKey, storedSession] = await Promise.all([
      authStorage.getItem<string>(AUTH_KEY_STORAGE_KEY),
      authStorage.getItem<StoredAuthSession>(AUTH_SESSION_STORAGE_KEY),
    ]);
  } catch {
    return null;
  }

  const normalizedSession = normalizeSession(storedSession, String(storedKey || ""));
  if (normalizedSession) {
    if (normalizedSession.key !== String(storedKey || "").trim()) {
      await authStorage.setItem(AUTH_KEY_STORAGE_KEY, normalizedSession.key);
    }
    return normalizedSession;
  }

  if (String(storedKey || "").trim()) {
    await clearStoredAuthSession();
  }
  return null;
}

export async function setStoredAuthSession(session: StoredAuthSession) {
  const normalizedSession = normalizeSession(session);
  if (!normalizedSession) {
    await clearStoredAuthSession();
    return;
  }

  writeLocalAuthSession(normalizedSession);
  await Promise.all([
    authStorage.setItem(AUTH_KEY_STORAGE_KEY, normalizedSession.key),
    authStorage.setItem(AUTH_SESSION_STORAGE_KEY, normalizedSession),
  ]).catch(() => {});
}

export async function setStoredAuthKey(authKey: string) {
  const normalizedAuthKey = String(authKey || "").trim();
  if (!normalizedAuthKey) {
    await clearStoredAuthSession();
    return;
  }
  if (hasBrowserStorage()) {
    try {
      globalThis.window.localStorage.setItem(AUTH_KEY_STORAGE_KEY, normalizedAuthKey);
    } catch {
    }
  }
  await authStorage.setItem(AUTH_KEY_STORAGE_KEY, normalizedAuthKey).catch(() => {});
}

export async function clearStoredAuthSession() {
  if (!hasBrowserStorage()) {
    return;
  }
  clearLocalAuthSession();
  await Promise.all([
    authStorage.removeItem(AUTH_KEY_STORAGE_KEY),
    authStorage.removeItem(AUTH_SESSION_STORAGE_KEY),
  ]).catch(() => {});
}

export async function clearStoredAuthKey() {
  await clearStoredAuthSession();
}
