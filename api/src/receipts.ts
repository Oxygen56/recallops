import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { canonicalJson } from "./hash.js";
import { CockroachRepository } from "./repository.js";

interface ReceiptSink {
  put(key: string, payload: Record<string, unknown>): Promise<void>;
  readonly name: string;
}

class FileReceiptSink implements ReceiptSink {
  readonly name = "local-file-evidence-sink";
  constructor(private readonly root = resolve(process.cwd(), "../artifacts/evidence/local-s3")) {}

  async put(key: string, payload: Record<string, unknown>): Promise<void> {
    const target = resolve(this.root, key);
    if (!target.startsWith(this.root)) throw new Error("receipt path escaped evidence root");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${canonicalJson(payload)}\n`, "utf8");
  }
}

class S3ReceiptSink implements ReceiptSink {
  readonly name = "amazon-s3";
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    region: string,
  ) {
    this.client = new S3Client({ region });
  }

  async put(key: string, payload: Record<string, unknown>): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: `${canonicalJson(payload)}\n`,
        ContentType: "application/json",
        ServerSideEncryption: "AES256",
        Metadata: { schema: "recallops-receipt-v1" },
      }),
    );
  }
}

export class ReceiptPublisher {
  private readonly sink: ReceiptSink;

  constructor(
    private readonly repository: CockroachRepository,
    options: { bucket?: string; region: string },
  ) {
    this.sink = options.bucket
      ? new S3ReceiptSink(options.bucket, options.region)
      : new FileReceiptSink();
  }

  async flush(tenantId: string): Promise<{ sink: string; published: number; failed: number }> {
    const records = await this.repository.pendingOutbox(tenantId);
    let published = 0;
    let failed = 0;
    for (const record of records) {
      try {
        await this.sink.put(record.receiptKey, record.payload);
        await this.repository.markOutboxPublished(record.tenantId, record.outboxId);
        published += 1;
      } catch (error) {
        failed += 1;
        await this.repository.markOutboxFailed(
          record.tenantId,
          record.outboxId,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return { sink: this.sink.name, published, failed };
  }
}
