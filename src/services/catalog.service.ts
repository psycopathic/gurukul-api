import { VIDEO_CATALOG, type VideoRecord } from "../catalog/video-catalog";

export type VideoLookup = (id: string) => Promise<VideoRecord | undefined>;

const staticIndex = new Map<string, VideoRecord>(
  VIDEO_CATALOG.map((video) => [video.id, video]),
);

const staticLookup: VideoLookup = async (id) => staticIndex.get(id);

let lookup: VideoLookup = staticLookup;

/// The single seam between the API and where video metadata lives. Point it at a
/// database query when Gurukul grows one; tests point it at fixtures.
export function setVideoLookup(next: VideoLookup | undefined): void {
  lookup = next ?? staticLookup;
}

export async function findVideoById(id: string): Promise<VideoRecord | undefined> {
  return lookup(id);
}
