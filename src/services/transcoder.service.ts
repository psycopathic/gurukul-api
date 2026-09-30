import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { env } from "../config/env";

/// FFmpeg wrapper that turns one local file into another. It knows nothing
/// about R2, the catalog or HTTP, so a dedicated worker can run it unchanged.
///
/// Every invocation goes through `execFile` with an argument array: no shell is
/// involved, so nothing in a path or setting is ever interpreted as a command.

const execFileAsync = promisify(execFile);

/// The playback rendition. Single-pass constrained bitrate: ~3 Mbps on average,
/// never more than 3.5 Mbps over a 6 Mbit window, so a phone on a ~4 Mbps
/// connection plays without stalling. Changing any of this only affects videos
/// processed afterwards; existing renditions keep their encode until reprocessed.
export const PLAYBACK_PROFILE = {
  /// Upper bound on the *short* side, so portrait video gets 720 wide rather
  /// than 720 tall. Smaller sources are never upscaled.
  maxShortSide: 720,
  preset: "medium",
  videoBitrate: "3000k",
  maxRate: "3500k",
  bufferSize: "6000k",
  audioBitrate: "128k",
} as const;

/// Long enough for a feature-length source on a small instance; a stuck
/// process is killed rather than left holding the job queue.
const FFMPEG_TIMEOUT_MS = 60 * 60 * 1000;
const FFPROBE_TIMEOUT_MS = 60 * 1000;
const MAX_OUTPUT_BUFFER = 4 * 1024 * 1024;

/// Carries a machine-readable reason alongside the human message.
export class TranscoderError extends Error {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = "TranscoderError";
    this.reason = reason;
  }
}

interface ExecFailure {
  code?: string | number | null;
  killed?: boolean;
  signal?: string | null;
  stderr?: string;
  message?: string;
}

/// The tail of FFmpeg's stderr: where it states what actually went wrong.
function describeFailure(error: unknown): string {
  const failure = error as ExecFailure;
  const stderr = (failure.stderr ?? "").trim();
  const detail = stderr ? stderr.slice(-2000) : (failure.message ?? String(error));
  return failure.killed || failure.signal
    ? `killed (${failure.signal ?? "timeout"}): ${detail}`
    : detail;
}

function isMissingBinary(error: unknown): boolean {
  return (error as ExecFailure).code === "ENOENT";
}

/// `min(720, even(ih))` on the short side and `-2` — "keep the aspect ratio,
/// round to an even number" — on the other. H.264 in 4:2:0 needs both even.
/// Single quotes keep the commas inside each expression from being read as
/// filter separators; they are FFmpeg filtergraph quoting, not shell quoting.
function scaleFilter(maxShortSide: number): string {
  const cap = (dimension: "iw" | "ih") =>
    `min(${maxShortSide},trunc(${dimension}/2)*2)`;
  return (
    `scale=w='if(gte(iw,ih),-2,${cap("iw")})'` +
    `:h='if(gte(iw,ih),${cap("ih")},-2)'`
  );
}

export function playbackFfmpegArgs(inputPath: string, outputPath: string): string[] {
  const profile = PLAYBACK_PROFILE;
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    "-i", inputPath,
    // First video stream and, when there is one, the first audio stream.
    // Subtitle and data tracks are dropped: players choke on some of them.
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-vf", scaleFilter(profile.maxShortSide),
    "-c:v", "libx264",
    "-preset", profile.preset,
    "-profile:v", "high",
    // 8-bit 4:2:0 is what every phone's hardware decoder handles; a 10-bit or
    // 4:2:2 source would otherwise carry through and fail to play on Android.
    "-pix_fmt", "yuv420p",
    "-b:v", profile.videoBitrate,
    "-maxrate", profile.maxRate,
    "-bufsize", profile.bufferSize,
    "-c:a", "aac",
    "-b:a", profile.audioBitrate,
    "-ac", "2",
    // Index at the front, so playback starts before the whole file arrives.
    "-movflags", "+faststart",
    "-f", "mp4",
    outputPath,
  ];
}

let verified: Promise<void> | undefined;

/// Confirms FFmpeg and ffprobe run and that FFmpeg has libx264. Checked once per
/// process; a failed check is retried next time, so installing FFmpeg does not
/// need a restart.
export function assertTranscoderAvailable(): Promise<void> {
  verified ??= checkBinaries().catch((error: unknown) => {
    verified = undefined;
    throw error;
  });
  return verified;
}

async function checkBinaries(): Promise<void> {
  const { ffmpegPath, ffprobePath } = env.videoProcessing;

  for (const [name, binary, variable] of [
    ["FFmpeg", ffmpegPath, "FFMPEG_PATH"],
    ["ffprobe", ffprobePath, "FFPROBE_PATH"],
  ] as const) {
    try {
      await execFileAsync(binary, ["-version"], { timeout: FFPROBE_TIMEOUT_MS });
    } catch (error) {
      throw new TranscoderError(
        "ffmpeg_unavailable",
        isMissingBinary(error)
          ? `${name} not found at "${binary}". Install FFmpeg or set ${variable}.`
          : `${name} at "${binary}" failed to run: ${describeFailure(error)}`,
      );
    }
  }

  const { stdout } = await execFileAsync(
    ffmpegPath,
    ["-hide_banner", "-encoders"],
    { timeout: FFPROBE_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BUFFER },
  );
  if (!/\blibx264\b/.test(stdout)) {
    throw new TranscoderError(
      "ffmpeg_unavailable",
      `FFmpeg at "${ffmpegPath}" was built without libx264, which the playback rendition needs.`,
    );
  }
}

/// Encodes `inputPath` into the 720p playback MP4 at `outputPath`.
export async function transcodeTo720p(
  inputPath: string,
  outputPath: string,
): Promise<void> {
  await assertTranscoderAvailable();
  try {
    await execFileAsync(env.videoProcessing.ffmpegPath, playbackFfmpegArgs(inputPath, outputPath), {
      timeout: FFMPEG_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: MAX_OUTPUT_BUFFER,
    });
  } catch (error) {
    throw new TranscoderError("transcode_failed", `FFmpeg failed: ${describeFailure(error)}`);
  }
}

export interface VideoProbe {
  width: number;
  height: number;
  durationSeconds: number;
  sizeBytes: number;
  /// Overall bits per second, audio included.
  bitRate: number;
  videoCodec: string;
  audioCodec?: string;
}

interface FfprobeOutput {
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
  }>;
  format?: { duration?: string; size?: string; bit_rate?: string };
}

/// Reads a file's dimensions, duration, size and bitrate. Throws if it has no
/// video stream, so a broken encode is never published.
export async function probeVideo(filePath: string): Promise<VideoProbe> {
  await assertTranscoderAvailable();

  let parsed: FfprobeOutput;
  try {
    const { stdout } = await execFileAsync(
      env.videoProcessing.ffprobePath,
      [
        "-v", "error",
        "-show_entries", "stream=codec_type,codec_name,width,height",
        "-show_entries", "format=duration,size,bit_rate",
        "-of", "json",
        filePath,
      ],
      { timeout: FFPROBE_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BUFFER },
    );
    parsed = JSON.parse(stdout) as FfprobeOutput;
  } catch (error) {
    throw new TranscoderError("probe_failed", `ffprobe failed: ${describeFailure(error)}`);
  }

  const video = parsed.streams?.find((stream) => stream.codec_type === "video");
  const audio = parsed.streams?.find((stream) => stream.codec_type === "audio");
  if (!video?.width || !video.height || !video.codec_name) {
    throw new TranscoderError("invalid_output", "ffprobe found no video stream");
  }

  return {
    width: video.width,
    height: video.height,
    durationSeconds: Number(parsed.format?.duration ?? 0),
    sizeBytes: Number(parsed.format?.size ?? 0),
    bitRate: Number(parsed.format?.bit_rate ?? 0),
    videoCodec: video.codec_name,
    audioCodec: audio?.codec_name,
  };
}
