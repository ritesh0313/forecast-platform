export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** JWT remains in React memory only. The server verifies role and tenant on every request. */
export function apiClient(token: string) {
  return async function request<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let data: { error?: { code?: string; message?: string } } & T;
    try {
      data = await response.json();
    } catch {
      throw new ApiError(
        response.status,
        'invalid_response',
        'The API returned an unreadable response.',
      );
    }
    if (!response.ok)
      throw new ApiError(
        response.status,
        data.error?.code ?? 'request_failed',
        data.error?.message ?? `Request failed (${response.status}).`,
      );
    return data;
  };
}

/** Unverified claims affect presentation only; they never authorize a server request. */
export function tokenRole(token: string): string | null {
  try {
    const payload = token.split('.')[1];
    const encoded = payload.replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')));
    return claims.role === 'trainer' ? 'trainer' : claims.role === 'reader' ? 'reader' : null;
  } catch {
    return null;
  }
}
