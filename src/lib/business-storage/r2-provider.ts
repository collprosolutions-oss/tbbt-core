import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ManagedStorageConfig } from "@/lib/business-storage/config";
import type {
  PresignedDownload,
  PresignedUpload,
  StorageObjectBody,
  StorageObjectMeta,
  StorageProvider,
} from "@/lib/business-storage/types";

function toUint8Array(body: Buffer | Uint8Array) {
  return body instanceof Buffer ? new Uint8Array(body) : body;
}

export class R2StorageProvider implements StorageProvider {
  readonly id = "R2" as const;
  private readonly client: S3Client;

  constructor(config: ManagedStorageConfig) {
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      // AWS SDK JS v3.729+ sends CRC32 checksums by default. R2 rejects
      // those headers on GetObject, which made /api/storage/public fail
      // while browser PUT + HeadObject finalize still succeeded.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }

  async putObject(input: {
    bucket: string;
    key: string;
    body: Buffer | Uint8Array;
    contentType: string;
    cacheControl?: string;
  }): Promise<StorageObjectMeta> {
    const body = toUint8Array(input.body);
    const result = await this.client.send(
      new PutObjectCommand({
        Bucket: input.bucket,
        Key: input.key,
        Body: body,
        ContentType: input.contentType,
        ContentLength: body.byteLength,
        CacheControl: input.cacheControl,
      }),
    );
    return {
      key: input.key,
      sizeBytes: body.byteLength,
      contentType: input.contentType,
      etag: result.ETag,
    };
  }

  async deleteObject(input: { bucket: string; key: string }): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: input.bucket, Key: input.key }),
    );
  }

  async getObjectMetadata(input: {
    bucket: string;
    key: string;
  }): Promise<StorageObjectMeta | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: input.bucket, Key: input.key }),
      );
      return {
        key: input.key,
        sizeBytes: result.ContentLength ?? 0,
        contentType: result.ContentType,
        etag: result.ETag,
      };
    } catch (error) {
      if (isMissingObject(error)) return null;
      throw error;
    }
  }

  async getObject(input: {
    bucket: string;
    key: string;
  }): Promise<StorageObjectBody | null> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: input.bucket, Key: input.key }),
      );
      const bytes = result.Body ? await result.Body.transformToByteArray() : new Uint8Array();
      return {
        key: input.key,
        body: bytes,
        sizeBytes: bytes.byteLength,
        contentType: result.ContentType,
        etag: result.ETag,
      };
    } catch (error) {
      if (isMissingObject(error)) return null;
      throw error;
    }
  }

  async objectExists(input: { bucket: string; key: string }): Promise<boolean> {
    return (await this.getObjectMetadata(input)) != null;
  }

  async createUploadUrl(input: {
    bucket: string;
    key: string;
    contentType: string;
    contentLength: number;
    expiresInSeconds: number;
  }): Promise<PresignedUpload> {
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: input.bucket,
        Key: input.key,
        ContentType: input.contentType,
        ContentLength: input.contentLength,
      }),
      { expiresIn: input.expiresInSeconds },
    );
    return {
      url,
      method: "PUT",
      headers: {
        "Content-Type": input.contentType,
        "Content-Length": String(input.contentLength),
      },
      expiresInSeconds: input.expiresInSeconds,
    };
  }

  async createDownloadUrl(input: {
    bucket: string;
    key: string;
    expiresInSeconds: number;
  }): Promise<PresignedDownload> {
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: input.bucket, Key: input.key }),
      { expiresIn: input.expiresInSeconds },
    );
    return { url, expiresInSeconds: input.expiresInSeconds };
  }
}

function isMissingObject(error: unknown) {
  const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
  const status =
    error && typeof error === "object" && "$metadata" in error
      ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
      : undefined;
  return name === "NotFound" || name === "NoSuchKey" || status === 404;
}

export function createR2StorageProvider(config: ManagedStorageConfig) {
  return new R2StorageProvider(config);
}
