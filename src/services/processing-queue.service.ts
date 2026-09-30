import { LogEvent, logger } from "./logger";
import { processVideo, type VideoProcessingJob } from "./video-processing.service";

/// In-process job queue for video processing.
///
/// Jobs run one at a time: an FFmpeg encode saturates every core, and two at
/// once would only make both slower while starving the API of CPU. Jobs are
/// held in memory, so a restart drops queued and running ones — their status
/// stays `PROCESSING` until an operator re-triggers them.
///
/// This file is the only thing that changes when processing moves to a worker:
/// `enqueueVideoProcessing` publishes `job` to the broker instead, and the
/// worker calls `processVideo(job)` — the pipeline itself is untouched.

const pending = new Set<string>();
let tail: Promise<unknown> = Promise.resolve();

export function isVideoProcessingQueued(videoId: string): boolean {
  return pending.has(videoId);
}

/// Queues a job. Returns `false` if this video already has one queued or
/// running here.
export function enqueueVideoProcessing(job: VideoProcessingJob): boolean {
  if (pending.has(job.videoId)) return false;

  pending.add(job.videoId);
  logger.info(LogEvent.processingQueued, {
    videoId: job.videoId,
    queueLength: pending.size,
  });

  tail = tail
    .then(() => processVideo(job))
    .catch((error: unknown) => {
      // processVideo never throws; this only guards against a bug in it taking
      // down the queue or the process with an unhandled rejection.
      logger.error(LogEvent.processingFailed, {
        videoId: job.videoId,
        reason: "unexpected_error",
        message: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => pending.delete(job.videoId));

  return true;
}

/// Resolves once every job queued so far has finished. For tests and shutdown.
export function videoProcessingIdle(): Promise<void> {
  return tail.then(() => undefined);
}
