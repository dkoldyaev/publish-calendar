import fs from 'node:fs';
import path from 'node:path';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ApiConfig } from '../config/env.js';

export interface S3StorageService {
  readonly bucket: string;
  buildPhotoKey(userId: string, photoId: string): string;
  createPresignedPutUrl(params: {
    key: string;
    contentType: string;
    contentLength: number;
  }): Promise<{ uploadUrl: string; expiresInSeconds: number }>;
  createPresignedGetUrl(params: {
    key: string;
    fileName: string;
  }): Promise<{ downloadUrl: string; expiresInSeconds: number }>;
  putObject(params: {
    key: string;
    body: Uint8Array;
    contentType: string;
    sha256Hex: string;
  }): Promise<{ etag: string | null }>;
  getObject(key: string): Promise<{ bytes: Uint8Array; contentType: string }>;
  headObject(
    key: string
  ): Promise<{ exists: boolean; sizeBytes: number; etag: string | null }>;
  deleteObject(key: string): Promise<void>;
}

interface LocalMetadataFile {
  contentType: string;
  sha256Hex: string;
  etag: string;
  sizeBytes: number;
}

export class LocalFileStorageService implements S3StorageService {
  public readonly bucket = 'local-filesystem';
  private readonly baseDir: string;
  private readonly publicApiOrigin: string;

  constructor(config: ApiConfig) {
    this.baseDir = path.resolve(config.localStorageDir);
    this.publicApiOrigin = config.publicApiOrigin.replace(/\/+$/, '');
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  buildPhotoKey(userId: string, photoId: string): string {
    return `users/${userId}/photos/${photoId}`;
  }

  private resolveSafePath(key: string): { filePath: string; metaPath: string } {
    const sanitized = key.replace(/^\/+/, '');
    const filePath = path.resolve(this.baseDir, sanitized);
    const rootWithSep = this.baseDir.endsWith(path.sep)
      ? this.baseDir
      : `${this.baseDir}${path.sep}`;
    if (!filePath.startsWith(rootWithSep)) {
      throw new Error(`Unsafe storage key path: ${key}`);
    }
    return {
      filePath,
      metaPath: `${filePath}.meta.json`,
    };
  }

  private extractPhotoId(key: string): string {
    const parts = key.split('/').filter(Boolean);
    return parts[parts.length - 1] ?? key;
  }

  async createPresignedPutUrl(params: {
    key: string;
    contentType: string;
    contentLength: number;
  }): Promise<{ uploadUrl: string; expiresInSeconds: number }> {
    const photoId = this.extractPhotoId(params.key);
    return Promise.resolve({
      uploadUrl: `${this.publicApiOrigin}/api/v1/photos/${encodeURIComponent(photoId)}/binary`,
      expiresInSeconds: 900,
    });
  }

  async createPresignedGetUrl(params: {
    key: string;
    fileName: string;
  }): Promise<{ downloadUrl: string; expiresInSeconds: number }> {
    const photoId = this.extractPhotoId(params.key);
    return Promise.resolve({
      downloadUrl: `${this.publicApiOrigin}/api/v1/photos/${encodeURIComponent(photoId)}/binary`,
      expiresInSeconds: 900,
    });
  }

  async putObject(params: {
    key: string;
    body: Uint8Array;
    contentType: string;
    sha256Hex: string;
  }): Promise<{ etag: string | null }> {
    const { filePath, metaPath } = this.resolveSafePath(params.key);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    const etag = `"${params.sha256Hex}"`;
    const meta: LocalMetadataFile = {
      contentType: params.contentType,
      sha256Hex: params.sha256Hex,
      etag,
      sizeBytes: params.body.byteLength,
    };
    await fs.promises.writeFile(filePath, params.body);
    await fs.promises.writeFile(metaPath, JSON.stringify(meta), 'utf8');
    return { etag };
  }

  async getObject(
    key: string
  ): Promise<{ bytes: Uint8Array; contentType: string }> {
    const { filePath, metaPath } = this.resolveSafePath(key);
    const buf = await fs.promises.readFile(filePath);
    let contentType = 'application/octet-stream';
    try {
      const rawMeta = await fs.promises.readFile(metaPath, 'utf8');
      const parsed = JSON.parse(rawMeta) as Partial<LocalMetadataFile>;
      if (typeof parsed.contentType === 'string' && parsed.contentType) {
        contentType = parsed.contentType;
      }
    } catch {
      // Metadata optional if raw file exists
    }
    return {
      bytes: new Uint8Array(buf),
      contentType,
    };
  }

  async headObject(
    key: string
  ): Promise<{ exists: boolean; sizeBytes: number; etag: string | null }> {
    const { filePath, metaPath } = this.resolveSafePath(key);
    try {
      const stat = await fs.promises.stat(filePath);
      let etag: string | null = null;
      try {
        const rawMeta = await fs.promises.readFile(metaPath, 'utf8');
        const parsed = JSON.parse(rawMeta) as Partial<LocalMetadataFile>;
        if (typeof parsed.etag === 'string') {
          etag = parsed.etag;
        }
      } catch {
        etag = `"size-${stat.size}"`;
      }
      return {
        exists: true,
        sizeBytes: stat.size,
        etag,
      };
    } catch {
      return {
        exists: false,
        sizeBytes: 0,
        etag: null,
      };
    }
  }

  async deleteObject(key: string): Promise<void> {
    const { filePath, metaPath } = this.resolveSafePath(key);
    await Promise.all([
      fs.promises.rm(filePath, { force: true }),
      fs.promises.rm(metaPath, { force: true }),
    ]);
  }
}

export class AwsS3StorageService implements S3StorageService {
  public readonly bucket: string;
  private readonly client: S3Client;
  private readonly presignedTtlSeconds: number;
  private bucketEnsured = false;

  constructor(config: ApiConfig) {
    this.bucket = config.s3Bucket;
    this.presignedTtlSeconds = config.s3PresignedUrlTtlSeconds;
    this.client = new S3Client({
      endpoint: config.s3Endpoint,
      region: config.s3Region,
      forcePathStyle: config.s3ForcePathStyle,
      credentials: {
        accessKeyId: config.s3AccessKeyId,
        secretAccessKey: config.s3SecretAccessKey,
      },
      requestHandler: {
        requestTimeout: config.s3OperationTimeoutMs,
      },
    });
  }

  buildPhotoKey(userId: string, photoId: string): string {
    return `users/${userId}/photos/${photoId}`;
  }

  async createPresignedPutUrl(params: {
    key: string;
    contentType: string;
    contentLength: number;
  }): Promise<{ uploadUrl: string; expiresInSeconds: number }> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: params.key,
      ContentType: params.contentType,
      ContentLength: params.contentLength,
    });
    const uploadUrl = await getSignedUrl(this.client, command, {
      expiresIn: this.presignedTtlSeconds,
    });
    return {
      uploadUrl,
      expiresInSeconds: this.presignedTtlSeconds,
    };
  }

  async createPresignedGetUrl(params: {
    key: string;
    fileName: string;
  }): Promise<{ downloadUrl: string; expiresInSeconds: number }> {
    const safeFileName = params.fileName.replace(/["\\\r\n]/g, '_');
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: params.key,
      ResponseContentDisposition: `attachment; filename="${safeFileName}"`,
    });
    const downloadUrl = await getSignedUrl(this.client, command, {
      expiresIn: this.presignedTtlSeconds,
    });
    return {
      downloadUrl,
      expiresInSeconds: this.presignedTtlSeconds,
    };
  }

  private async ensureBucket(): Promise<void> {
    if (this.bucketEnsured) {
      return;
    }
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      this.bucketEnsured = true;
    } catch {
      try {
        await this.client.send(
          new CreateBucketCommand({ Bucket: this.bucket })
        );
      } catch {
        // Ignore if bucket was concurrently created
      }
      this.bucketEnsured = true;
    }
  }

  async putObject(params: {
    key: string;
    body: Uint8Array;
    contentType: string;
    sha256Hex: string;
  }): Promise<{ etag: string | null }> {
    await this.ensureBucket();
    const res = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: params.key,
        Body: params.body,
        ContentType: params.contentType,
        Metadata: {
          sha256: params.sha256Hex,
        },
      })
    );
    return {
      etag: res.ETag ?? null,
    };
  }

  async getObject(
    key: string
  ): Promise<{ bytes: Uint8Array; contentType: string }> {
    const res = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      })
    );
    if (!res.Body) {
      throw new Error(`S3 object body is empty for key ${key}`);
    }
    const bytes = await res.Body.transformToByteArray();
    return {
      bytes,
      contentType: res.ContentType ?? 'application/octet-stream',
    };
  }

  async headObject(
    key: string
  ): Promise<{ exists: boolean; sizeBytes: number; etag: string | null }> {
    try {
      const res = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key,
        })
      );
      return {
        exists: true,
        sizeBytes: res.ContentLength ?? 0,
        etag: res.ETag ?? null,
      };
    } catch {
      return {
        exists: false,
        sizeBytes: 0,
        etag: null,
      };
    }
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      })
    );
  }
}

export function createStorageService(config: ApiConfig): S3StorageService {
  if (config.storageDriver === 'local') {
    return new LocalFileStorageService(config);
  }
  return new AwsS3StorageService(config);
}
