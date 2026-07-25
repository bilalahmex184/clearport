// Cloudflare Workers type declarations
declare interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  put(key: string, value: ArrayBuffer | ReadableStream | string, options?: R2PutOptions): Promise<R2Object>;
  delete(key: string): Promise<void>;
  list(options?: R2ListOptions): Promise<R2Objects>;
}
declare interface R2Object { key: string; size: number; etag: string; uploaded: Date; customMetadata: Record<string, string>; }
declare interface R2ObjectBody extends R2Object { body: ReadableStream; arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string>; json<T>(): Promise<T>; }
declare interface R2PutOptions { customMetadata?: Record<string, string>; httpMetadata?: Record<string, string>; }
declare interface R2Objects { objects: R2Object[]; truncated: boolean; cursor?: string; }
declare interface R2ListOptions { limit?: number; prefix?: string; cursor?: string; }
declare interface ScheduledEvent { scheduledTime: number; cron: string; }
declare interface ExecutionContext { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void; }
