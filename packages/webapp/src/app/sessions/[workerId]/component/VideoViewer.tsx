'use client';

import React, { useState } from 'react';
import { Loader2, FileVideo, FileDown } from 'lucide-react';
import { useFileUrls } from './use-file-urls';
import { MiddleEllipsisFileName } from './file-viewer-parts';

type VideoViewerProps = {
  videoKeys: string[];
};

const FileLink = ({ url, fileName }: { url: string; fileName: string }) => (
  <a
    href={url}
    target="_blank"
    rel="noopener noreferrer"
    className="inline-flex items-center gap-2 px-3 py-1.5 bg-gray-100 dark:bg-gray-800 rounded-md hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors group max-w-full"
    title={fileName}
  >
    <FileVideo className="w-4 h-4 flex-shrink-0" />
    <MiddleEllipsisFileName
      name={fileName}
      className="text-sm text-blue-600 dark:text-blue-400 group-hover:underline"
    />
    <FileDown className="w-3.5 h-3.5 text-gray-400 group-hover:text-blue-500 flex-shrink-0" />
  </a>
);

export const VideoViewer = ({ videoKeys }: VideoViewerProps) => {
  const videos = useFileUrls(videoKeys);
  // Keys whose <video> failed to load (unsupported codec, e.g. HEVC .mov in
  // Chrome/Firefox). The URL is valid, so fall back to a plain file link so
  // the file is always reachable.
  const [playbackFailed, setPlaybackFailed] = useState<Record<string, boolean>>({});

  if (videoKeys.length === 0) {
    return null;
  }

  return (
    <div className="mt-2">
      <div className="flex flex-col gap-2">
        {videos.map((video) => (
          <div key={video.key} className="flex flex-col gap-1">
            {video.loading ? (
              <div className="w-64 h-36 bg-gray-100 dark:bg-gray-800 rounded flex items-center justify-center">
                <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
              </div>
            ) : video.error ? (
              <div
                className="inline-flex items-center gap-2 px-3 py-1.5 bg-gray-100 dark:bg-gray-800 rounded-md max-w-full"
                title={video.fileName}
              >
                <FileVideo className="w-4 h-4 flex-shrink-0" />
                <MiddleEllipsisFileName name={`${video.fileName} (Error)`} className="text-sm text-gray-500" />
              </div>
            ) : playbackFailed[video.key] ? (
              <FileLink url={video.url} fileName={video.fileName} />
            ) : (
              <>
                <video
                  src={video.url}
                  controls
                  preload="metadata"
                  className="max-w-full w-64 max-h-[60vh] rounded bg-black"
                  onError={() => setPlaybackFailed((prev) => ({ ...prev, [video.key]: true }))}
                />
                <FileLink url={video.url} fileName={video.fileName} />
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};
