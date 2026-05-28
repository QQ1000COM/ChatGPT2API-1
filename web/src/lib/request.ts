import axios, {AxiosError, type AxiosRequestConfig} from "axios";

import webConfig from "@/constants/common-env";
import {clearAuthSessionCache} from "@/lib/auth-session";
import {clearStoredAuthSession, getStoredAuthKey} from "@/store/auth";

type RequestConfig = AxiosRequestConfig & {
    redirectOnUnauthorized?: boolean;
};

type ErrorPayload = {
    detail?: string | { error?: string | { message?: string } };
    error?: string | { message?: string };
    message?: string;
};

function errorMessageFromValue(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }
    if (!value || typeof value !== "object") {
        return "";
    }

    const item = value as { error?: unknown; message?: unknown };
    if (typeof item.message === "string") {
        return item.message;
    }
    return errorMessageFromValue(item.error);
}

export const request = axios.create({
    baseURL: webConfig.apiUrl.replace(/\/$/, ""),
});

request.interceptors.request.use(async (config) => {
    const nextConfig = {...config};
    const authKey = await getStoredAuthKey();
    const headers = {...(nextConfig.headers || {})} as Record<string, string>;
    if (authKey && !headers.Authorization) {
        headers.Authorization = `Bearer ${authKey}`;
    }
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error
    nextConfig.headers = headers;
    return nextConfig;
});

request.interceptors.response.use(
    (response) => response,
    async (error: AxiosError<ErrorPayload>) => {
        const status = error.response?.status;
        const shouldRedirect = (error.config as RequestConfig | undefined)?.redirectOnUnauthorized !== false;
        if (status === 401 && shouldRedirect && typeof window !== "undefined") {
            // Avoid redirect loop — only redirect if not already on /login
            if (!window.location.pathname.startsWith("/login")) {
                await clearStoredAuthSession();
                clearAuthSessionCache();
                window.location.replace("/login");
                // Return a never-resolving promise to prevent further error handling
                // while the browser navigates away
                return new Promise(() => {});
            }
        }

        const payload = error.response?.data;
        const message =
            errorMessageFromValue(payload?.detail) ||
            errorMessageFromValue(payload?.error) ||
            payload?.message ||
            error.message ||
            `请求失败 (${status || 500})`;
        return Promise.reject(new Error(message));
    },
);

type RequestOptions = {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    redirectOnUnauthorized?: boolean;
};

const inflightGetRequests = new Map<string, Promise<unknown>>();
const getResponseCache = new Map<string, {expiresAt: number; value: unknown}>();

const CACHEABLE_GETS: Array<{prefix: string; ttl: number}> = [
    {prefix: "/api/public-config", ttl: 30_000},
    {prefix: "/api/public-cases", ttl: 30_000},
    {prefix: "/api/me/onboarding", ttl: 10_000},
];

function cachePolicyForPath(path: string) {
    return CACHEABLE_GETS.find((item) => path.startsWith(item.prefix));
}

function getRequestKey(path: string, options: RequestOptions) {
    return JSON.stringify({
        path,
        method: (options.method || "GET").toUpperCase(),
        headers: options.headers || {},
        redirectOnUnauthorized: options.redirectOnUnauthorized !== false,
    });
}

export async function httpRequest<T>(path: string, options: RequestOptions = {}) {
    const {method = "GET", body, headers, redirectOnUnauthorized = true} = options;
    const upperMethod = method.toUpperCase();
    const cacheKey = getRequestKey(path, options);
    const cachePolicy = upperMethod === "GET" ? cachePolicyForPath(path) : undefined;
    if (cachePolicy) {
        const cached = getResponseCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.value as T;
        }
    }
    if (upperMethod === "GET") {
        const inflight = inflightGetRequests.get(cacheKey);
        if (inflight) {
            return inflight as Promise<T>;
        }
    } else {
        getResponseCache.clear();
    }

    const config: RequestConfig = {
        url: path,
        method: upperMethod,
        data: body,
        headers,
        redirectOnUnauthorized,
    };
    const promise = request.request<T>(config).then((response) => {
        if (cachePolicy) {
            getResponseCache.set(cacheKey, {
                expiresAt: Date.now() + cachePolicy.ttl,
                value: response.data,
            });
        }
        return response.data;
    });
    if (upperMethod === "GET") {
        inflightGetRequests.set(cacheKey, promise);
        promise.then(
            () => inflightGetRequests.delete(cacheKey),
            () => inflightGetRequests.delete(cacheKey),
        );
    }
    return promise;
}
