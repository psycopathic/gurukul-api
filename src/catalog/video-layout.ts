/// Where a processed video's objects live inside its bucket:
///
/// ```text
/// videos/<videoId>/original.mp4   the upload, kept as the master asset
/// videos/<videoId>/720p.mp4       the playback rendition
/// videos/<videoId>/status.json    processing state (see video-status.service.ts)
/// ```
///
/// Every key is derived from the video id, so the id is validated before it
/// gets anywhere near one: a `/` or `..` would otherwise escape the prefix.

const VIDEO_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function isValidVideoId(value: string): boolean {
  return VIDEO_ID.test(value);
}

export interface VideoObjectKeys {
  original: string;
  playback: string;
  status: string;
}

export function videoObjectKeys(videoId: string): VideoObjectKeys {
  if (!isValidVideoId(videoId)) {
    throw new Error(`Invalid video id: ${JSON.stringify(videoId)}`);
  }
  const prefix = `videos/${videoId}`;
  return {
    original: `${prefix}/original.mp4`,
    playback: `${prefix}/720p.mp4`,
    status: `${prefix}/status.json`,
  };
}
