import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { BucketId } from "../config/buckets";
import { env } from "../config/env";
import { videoObjectKeys } from "../catalog/video-layout";
import type { RenditionInfo, VideoStatusRecord } from "../types/video.types";
import { LogEvent, logger } from "./logger";
import { objectStore } from "./r2.service";
import { TranscoderError, probeVideo, transcodeTo720p } from "./transcoder.service";
import { writeVideoStatus } from "./video-status.service";

/// Everything a processing run needs. Plain data, so it can be the body of a
/// queue message when processing moves to a dedicated worker.
export interface VideoProcessingJob {
  videoId: string;
  bucket: BucketId;
}

/// R2 original → temp file → FFmpeg → temp 720p → R2 rendition → `READY`.
///
/// Never throws: any failure is logged and recorded as `FAILED`, and the
/// original is left untouched. A previously published rendition is not touched
/// either — the upload is the last step and replaces the object atomically — so
/// a failed reprocess leaves the old 720p file playing.
///
/// The scratch directory is removed whatever happens. Nothing outlives the run.
export async function processVideo(job: VideoProcessingJob): Promise<VideoStatusRecord> {
  const { videoId, bucket } = job;
  const keys = videoObjectKeys(videoId);
  const startedAt = Date.now();
  let stage = "setup_failed";

  logger.info(LogEvent.processingStarted, { videoId, bucket });

  let workDir: string | undefined;

  try {
    await mkdir(env.videoProcessing.tmpDir, { recursive: true });
    workDir = await mkdtemp(path.join(env.videoProcessing.tmpDir, `gurukul-${videoId}-`));
    const inputPath = path.join(workDir, "original.mp4");
    const outputPath = path.join(workDir, "720p.mp4");

    stage = "download_failed";
    const downloadStartedAt = Date.now();
    const inputBytes = await objectStore().downloadToFile(bucket, keys.original, inputPath);
    logger.info(LogEvent.originalDownloaded, {
      videoId,
      key: keys.original,
      sizeBytes: inputBytes,
      durationMs: Date.now() - downloadStartedAt,
    });

    stage = "transcode_failed";
    const transcodeStartedAt = Date.now();
    logger.info(LogEvent.ffmpegStarted, { videoId, inputPath, outputPath });
    await transcodeTo720p(inputPath, outputPath);

    stage = "invalid_output";
    const probe = await probeVideo(outputPath);
    const outputBytes = (await stat(outputPath)).size;
    logger.info(LogEvent.ffmpegCompleted, {
      videoId,
      durationMs: Date.now() - transcodeStartedAt,
      width: probe.width,
      height: probe.height,
      videoDurationSeconds: probe.durationSeconds,
      bitRate: probe.bitRate,
      inputBytes,
      outputBytes,
    });

    stage = "upload_failed";
    const uploadStartedAt = Date.now();
    await objectStore().uploadFile(bucket, keys.playback, outputPath, "video/mp4");
    logger.info(LogEvent.renditionUploaded, {
      videoId,
      key: keys.playback,
      sizeBytes: outputBytes,
      durationMs: Date.now() - uploadStartedAt,
    });

    stage = "status_write_failed";
    const rendition: RenditionInfo = {
      width: probe.width,
      height: probe.height,
      durationSeconds: probe.durationSeconds,
      sizeBytes: outputBytes,
      bitRate: probe.bitRate,
      publishedAt: new Date().toISOString(),
    };
    const record = await writeVideoStatus(bucket, videoId, "READY", { rendition });

    logger.info(LogEvent.processingCompleted, {
      videoId,
      durationMs: Date.now() - startedAt,
      inputBytes,
      outputBytes,
      bitRate: probe.bitRate,
      width: probe.width,
      height: probe.height,
    });
    return record;
  } catch (error) {
    const reason = error instanceof TranscoderError ? error.reason : stage;
    logger.error(LogEvent.processingFailed, {
      videoId,
      reason,
      durationMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : String(error),
    });
    return markFailed(bucket, videoId, reason);
  } finally {
    if (workDir) await removeWorkDir(videoId, workDir);
  }
}

async function removeWorkDir(videoId: string, workDir: string): Promise<void> {
  await rm(workDir, { recursive: true, force: true }).catch((error: unknown) => {
      logger.error(LogEvent.processingCleanupFailed, {
      videoId,
      workDir,
      message: error instanceof Error ? error.message : String(error),
    });
  });
}

/// Records the failure. If even that write fails (R2 unreachable), the status
/// stays `PROCESSING`; the operator retries with `POST /process`, which is
/// allowed because no job is active for the video any more.
async function markFailed(
  bucket: BucketId,
  videoId: string,
  failureReason: string,
): Promise<VideoStatusRecord> {
  try {
    return await writeVideoStatus(bucket, videoId, "FAILED", { failureReason });
  } catch (error) {
    logger.error(LogEvent.processingFailed, {
      videoId,
      reason: "status_write_failed",
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      videoId,
      status: "FAILED",
      updatedAt: new Date().toISOString(),
      failureReason,
    };
  }
}
