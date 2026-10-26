import { unzipSync } from 'fflate';
import type {
  SupportedImageMimeType,
  ValidatedUploadItem,
  ValidationIssue,
} from './types.js';

export interface UploadValidationLimits {
  maxUploadFileBytes: number;
  maxBatchFiles: number;
  maxBatchTotalBytes: number;
  maxZipExpansionRatio: number;
  maxZipExtractedBytes: number;
  maxZipEntries: number;
}

export interface RawUploadCandidate {
  fileName: string;
  bytes: Uint8Array;
}

export interface BatchValidationResult {
  validItems: ValidatedUploadItem[];
  issues: ValidationIssue[];
}

const EXTENSION_TO_MIME: Record<string, SupportedImageMimeType> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
};

export const SUPPORTED_IMAGE_EXTENSIONS = Object.keys(EXTENSION_TO_MIME);
export const SUPPORTED_IMAGE_MIME_TYPES: SupportedImageMimeType[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
];

export function getLowercaseExtension(fileName: string): string {
  const lastDot = fileName.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === fileName.length - 1) {
    return '';
  }
  return fileName.slice(lastDot).toLowerCase();
}

export function isZipFileName(fileName: string): boolean {
  return getLowercaseExtension(fileName) === '.zip';
}

export function hasPathTraversal(entryPath: string): boolean {
  if (!entryPath || entryPath.includes('\0')) {
    return true;
  }
  if (entryPath.startsWith('/') || entryPath.startsWith('\\')) {
    return true;
  }
  if (/^[a-zA-Z]:/.test(entryPath)) {
    return true;
  }
  const normalized = entryPath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  for (const seg of segments) {
    if (seg === '..') {
      return true;
    }
  }
  return false;
}

export function isIgnoredSystemEntry(entryPath: string): boolean {
  const normalized = entryPath.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) {
    return true;
  }
  if (segments[0] === '__MACOSX') {
    return true;
  }
  const baseName = segments[segments.length - 1] ?? '';
  if (baseName === '.DS_Store' || baseName === 'Thumbs.db' || baseName.startsWith('._')) {
    return true;
  }
  return false;
}

/**
 * Verifies both the file extension and binary magic bytes to detect corrupted or spoofed images.
 */
export function validateImageBinary(
  fileName: string,
  bytes: Uint8Array
):
  | { ok: true; mimeType: SupportedImageMimeType }
  | { ok: false; reason: string } {
  const ext = getLowercaseExtension(fileName);
  const expectedMime = EXTENSION_TO_MIME[ext];
  if (!expectedMime) {
    return {
      ok: false,
      reason: `Неподдерживаемый формат файла (${ext || 'без расширения'}). Разрешены: JPG, JPEG, PNG, WEBP, GIF, AVIF.`,
    };
  }

  if (bytes.byteLength < 12) {
    return {
      ok: false,
      reason: 'Повреждённый файл изображения (слишком малый размер данных).',
    };
  }

  switch (expectedMime) {
    case 'image/jpeg': {
      const isJpegHeader =
        bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      if (!isJpegHeader) {
        return {
          ok: false,
          reason: 'Повреждённый файл JPEG (неверная сигнатура заголовка).',
        };
      }
      return { ok: true, mimeType: 'image/jpeg' };
    }
    case 'image/png': {
      const pngSig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
      const matches = pngSig.every((b, idx) => bytes[idx] === b);
      if (!matches) {
        return {
          ok: false,
          reason: 'Повреждённый файл PNG (неверная сигнатура заголовка).',
        };
      }
      return { ok: true, mimeType: 'image/png' };
    }
    case 'image/webp': {
      const isRiff =
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46;
      const isWebp =
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50;
      if (!isRiff || !isWebp) {
        return {
          ok: false,
          reason: 'Повреждённый файл WEBP (неверная сигнатура RIFF/WEBP).',
        };
      }
      return { ok: true, mimeType: 'image/webp' };
    }
    case 'image/gif': {
      const isGif87a =
        bytes[0] === 0x47 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x38 &&
        bytes[4] === 0x37 &&
        bytes[5] === 0x61;
      const isGif89a =
        bytes[0] === 0x47 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x38 &&
        bytes[4] === 0x39 &&
        bytes[5] === 0x61;
      if (!isGif87a && !isGif89a) {
        return {
          ok: false,
          reason: 'Повреждённый файл GIF (неверная сигнатура GIF87a/GIF89a).',
        };
      }
      return { ok: true, mimeType: 'image/gif' };
    }
    case 'image/avif': {
      const isFtyp =
        bytes[4] === 0x66 &&
        bytes[5] === 0x74 &&
        bytes[6] === 0x79 &&
        bytes[7] === 0x70;
      const brand = String.fromCharCode(
        bytes[8] ?? 0,
        bytes[9] ?? 0,
        bytes[10] ?? 0,
        bytes[11] ?? 0
      );
      if (!isFtyp || (brand !== 'avif' && brand !== 'avis' && brand !== 'mif1')) {
        return {
          ok: false,
          reason: 'Повреждённый файл AVIF (неверная сигнатура ISO BMFF ftyp).',
        };
      }
      return { ok: true, mimeType: 'image/avif' };
    }
  }
}

export function deduplicateFileName(
  rawFileName: string,
  usedNamesLower: Map<string, number>
): string {
  const normalized = rawFileName.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  const baseName = segments[segments.length - 1] ?? 'photo.jpg';
  const lower = baseName.toLowerCase();

  const existingCount = usedNamesLower.get(lower) ?? 0;
  usedNamesLower.set(lower, existingCount + 1);
  if (existingCount === 0) {
    return baseName;
  }

  const ext = getLowercaseExtension(baseName);
  const stem = ext ? baseName.slice(0, baseName.length - ext.length) : baseName;
  let suffix = existingCount + 1;
  let candidate = `${stem} (${suffix})${ext}`;
  while (usedNamesLower.has(candidate.toLowerCase())) {
    suffix++;
    candidate = `${stem} (${suffix})${ext}`;
  }
  usedNamesLower.set(candidate.toLowerCase(), 1);
  return candidate;
}

export function extractZipEntries(
  archiveName: string,
  archiveBytes: Uint8Array,
  limits: UploadValidationLimits
): {
  extractedFiles: Array<{ entryName: string; bytes: Uint8Array }>;
  issues: ValidationIssue[];
} {
  const issues: ValidationIssue[] = [];
  const extractedFiles: Array<{ entryName: string; bytes: Uint8Array }> = [];

  if (archiveBytes.byteLength < 22) {
    issues.push({
      fileName: archiveName,
      reason: 'Некорректный или повреждённый ZIP-архив.',
    });
    return { extractedFiles, issues };
  }

  const isZipMagic =
    archiveBytes[0] === 0x50 &&
    archiveBytes[1] === 0x4b &&
    ((archiveBytes[2] === 0x03 && archiveBytes[3] === 0x04) ||
      (archiveBytes[2] === 0x05 && archiveBytes[3] === 0x06));

  if (!isZipMagic) {
    issues.push({
      fileName: archiveName,
      reason: 'Некорректный или повреждённый ZIP-архив (неверная сигнатура PK).',
    });
    return { extractedFiles, issues };
  }

  let entryCount = 0;
  let cumulativeExtractedBytes = 0;
  const skippedByFilter = new Set<string>();

  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(archiveBytes, {
      filter(file) {
        entryCount++;
        if (entryCount > limits.maxZipEntries) {
          if (entryCount === limits.maxZipEntries + 1) {
            issues.push({
              fileName: `${archiveName}:${file.name}`,
              reason: `Превышено максимальное число элементов в ZIP-архиве (лимит: ${limits.maxZipEntries}).`,
            });
          }
          skippedByFilter.add(file.name);
          return false;
        }

        if (hasPathTraversal(file.name)) {
          issues.push({
            fileName: `${archiveName}:${file.name}`,
            reason:
              'Обнаружена попытка обхода пути (Path Traversal) в ZIP-архиве.',
          });
          skippedByFilter.add(file.name);
          return false;
        }

        if (file.name.endsWith('/') || isIgnoredSystemEntry(file.name)) {
          skippedByFilter.add(file.name);
          return false;
        }

        const compressedSize = Math.max(file.size, 1);
        const uncompressedSize = file.originalSize;
        const ratio = uncompressedSize / compressedSize;

        if (ratio > limits.maxZipExpansionRatio) {
          issues.push({
            fileName: `${archiveName}:${file.name}`,
            reason: `Превышен допустимый коэффициент сжатия ZIP (${ratio.toFixed(1)}x > ${limits.maxZipExpansionRatio}x).`,
          });
          skippedByFilter.add(file.name);
          return false;
        }

        if (uncompressedSize > limits.maxUploadFileBytes) {
          issues.push({
            fileName: `${archiveName}:${file.name}`,
            reason: `Размер файла в архиве (${uncompressedSize} байт) превышает лимит (${limits.maxUploadFileBytes} байт).`,
          });
          skippedByFilter.add(file.name);
          return false;
        }

        if (
          cumulativeExtractedBytes + uncompressedSize >
          limits.maxZipExtractedBytes
        ) {
          issues.push({
            fileName: `${archiveName}:${file.name}`,
            reason: `Превышен общий лимит распаковки ZIP-архива (${limits.maxZipExtractedBytes} байт).`,
          });
          skippedByFilter.add(file.name);
          return false;
        }

        cumulativeExtractedBytes += uncompressedSize;
        return true;
      },
    });
  } catch {
    issues.push({
      fileName: archiveName,
      reason: 'Не удалось распаковать ZIP-архив: архив повреждён.',
    });
    return { extractedFiles, issues };
  }

  const entryNames = Object.keys(unzipped).sort((a, b) => a.localeCompare(b));
  for (const name of entryNames) {
    if (skippedByFilter.has(name) || name.endsWith('/') || isIgnoredSystemEntry(name)) {
      continue;
    }
    const data = unzipped[name];
    if (!data) {
      continue;
    }
    extractedFiles.push({
      entryName: name,
      bytes: data,
    });
  }

  if (extractedFiles.length === 0 && issues.length === 0) {
    issues.push({
      fileName: archiveName,
      reason: 'ZIP-архив пуст или не содержит поддерживаемых файлов.',
    });
  }

  return { extractedFiles, issues };
}

/**
 * Validates and extracts a mixed batch of individual photographs and ZIP archives
 * while preserving deterministic ordering and reporting clear per-file errors.
 */
export function validateUploadBatch(
  candidates: readonly RawUploadCandidate[],
  limits: UploadValidationLimits,
  idGenerator: () => string
): BatchValidationResult {
  const validItems: ValidatedUploadItem[] = [];
  const issues: ValidationIssue[] = [];
  const usedNamesLower = new Map<string, number>();
  let totalAcceptedBytes = 0;

  const processSingleImage = (
    rawName: string,
    bytes: Uint8Array,
    sourceArchiveName: string | null
  ) => {
    const displayLabel = sourceArchiveName
      ? `${sourceArchiveName}:${rawName}`
      : rawName;

    if (validItems.length >= limits.maxBatchFiles) {
      issues.push({
        fileName: displayLabel,
        reason: `Превышен лимит количества файлов в пакете (максимум ${limits.maxBatchFiles}).`,
      });
      return;
    }

    if (bytes.byteLength > limits.maxUploadFileBytes) {
      issues.push({
        fileName: displayLabel,
        reason: `Размер файла (${bytes.byteLength} байт) превышает максимальный размер (${limits.maxUploadFileBytes} байт).`,
      });
      return;
    }

    if (totalAcceptedBytes + bytes.byteLength > limits.maxBatchTotalBytes) {
      issues.push({
        fileName: displayLabel,
        reason: `Превышен максимальный общий размер пакета загрузки (${limits.maxBatchTotalBytes} байт).`,
      });
      return;
    }

    const imgCheck = validateImageBinary(rawName, bytes);
    if (!imgCheck.ok) {
      issues.push({
        fileName: displayLabel,
        reason: imgCheck.reason,
      });
      return;
    }

    const finalFileName = deduplicateFileName(rawName, usedNamesLower);
    totalAcceptedBytes += bytes.byteLength;

    validItems.push({
      id: idGenerator(),
      fileName: finalFileName,
      mimeType: imgCheck.mimeType,
      sizeBytes: bytes.byteLength,
      bytes,
      sourceArchiveName,
    });
  };

  for (const candidate of candidates) {
    if (isZipFileName(candidate.fileName)) {
      const { extractedFiles, issues: zipIssues } = extractZipEntries(
        candidate.fileName,
        candidate.bytes,
        limits
      );
      issues.push(...zipIssues);
      for (const entry of extractedFiles) {
        processSingleImage(entry.entryName, entry.bytes, candidate.fileName);
      }
    } else {
      processSingleImage(candidate.fileName, candidate.bytes, null);
    }
  }

  return {
    validItems,
    issues,
  };
}
