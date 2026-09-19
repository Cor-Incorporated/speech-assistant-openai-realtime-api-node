// Admin v2 API client — mirrors the server contract:
//   * error body {code, message, fieldErrors, requestId}
//   * optimistic locking via If-Match against the ETag returned by GET/POST
//   * Idempotency-Key on creates
//   * never claims success before persistence completes

export class ApiError extends Error {
    constructor(
        public readonly status: number,
        public readonly code: string,
        message: string,
        public readonly fieldErrors?: Record<string, string>,
        public readonly requestId?: string
    ) {
        super(message);
    }

    get isConflict(): boolean {
        return this.status === 412 || this.status === 409;
    }
}

export interface ApiResult<T> {
    body: T;
    etag: string | null;
}

const parseError = async (response: Response): Promise<ApiError> => {
    try {
        const body = await response.json();
        return new ApiError(response.status, body.code ?? 'ERROR', body.message ?? `HTTP ${response.status}`, body.fieldErrors, body.requestId);
    } catch {
        return new ApiError(response.status, 'ERROR', `Request failed with ${response.status}`);
    }
};

export const api = async <T,>(path: string, init?: RequestInit): Promise<ApiResult<T>> => {
    const url = new URL(path, window.location.origin);
    // Fastify rejects an empty JSON body — only declare content-type when
    // there actually is one.
    const hasBody = init?.body !== undefined && init?.body !== null;
    const response = await fetch(url.toString(), {
        ...init,
        headers: {
            ...(hasBody ? { 'content-type': 'application/json' } : {}),
            ...(init?.headers || {})
        }
    });
    if (!response.ok) throw await parseError(response);
    const body = (await response.json()) as T;
    return { body, etag: response.headers.get('etag') };
};

export const apiGet = <T,>(path: string) => api<T>(path);

export const apiWrite = <T,>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown, headers: Record<string, string> = {}) =>
    api<T>(path, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
        headers
    });

export const idempotencyKey = (): string =>
    (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
