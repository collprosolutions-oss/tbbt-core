import type {
  PresignedDownload,
  PresignedUpload,
  StorageObjectBody,
  StorageObjectMeta,
  StorageProvider,
} from "@/lib/business-storage/types";

type MemoryObject = {
  body: Uint8Array;
  contentType: string;
};

export class MemoryStorageProvider implements StorageProvider {
  readonly id = "MEMORY" as const;
  private readonly objects = new Map<string, MemoryObject>();

  private objectKey(bucket: string, key: string) {
    return `${bucket}::${key}`;
  }

  async putObject(input: {
    bucket: string;
    key: string;
    body: Buffer | Uint8Array;
    contentType: string;
  }): Promise<StorageObjectMeta> {
    const body = input.body instanceof Buffer ? new Uint8Array(input.body) : input.body;
    this.objects.set(this.objectKey(input.bucket, input.key), {
      body,
      contentType: input.contentType,
    });
    return { key: input.key, sizeBytes: body.byteLength, contentType: input.contentType };
  }

  async deleteObject(input: { bucket: string; key: string }): Promise<void> {
    this.objects.delete(this.objectKey(input.bucket, input.key));
  }

  async getObjectMetadata(input: {
    bucket: string;
    key: string;
  }): Promise<StorageObjectMeta | null> {
    const object = this.objects.get(this.objectKey(input.bucket, input.key));
    if (!object) return null;
    return {
      key: input.key,
      sizeBytes: object.body.byteLength,
      contentType: object.contentType,
    };
  }

  async getObject(input: {
    bucket: string;
    key: string;
  }): Promise<StorageObjectBody | null> {
    const object = this.objects.get(this.objectKey(input.bucket, input.key));
    if (!object) return null;
    return {
      key: input.key,
      body: object.body,
      sizeBytes: object.body.byteLength,
      contentType: object.contentType,
    };
  }

  async objectExists(input: { bucket: string; key: string }): Promise<boolean> {
    return this.objects.has(this.objectKey(input.bucket, input.key));
  }

  async createUploadUrl(input: {
    bucket: string;
    key: string;
    contentType: string;
    contentLength: number;
    expiresInSeconds: number;
  }): Promise<PresignedUpload> {
    return {
      url: `memory://upload/${input.bucket}/${input.key}`,
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
    return {
      url: `memory://download/${input.bucket}/${input.key}`,
      expiresInSeconds: input.expiresInSeconds,
    };
  }
}
