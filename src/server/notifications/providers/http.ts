import { PermanentSendError } from "../types";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** 4xx (other than 408/429) means the request itself is wrong, so retrying cannot help. */
export function failFromStatus(provider: string, status: number, detail: string): never {
  const message = `${provider} responded ${status}: ${detail}`.slice(0, 500);
  if (isPermanentStatus(status)) throw new PermanentSendError(message);
  throw new Error(message);
}

export function isPermanentStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

export function basicAuth(user: string, secret: string): string {
  return `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;
}
