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
