'use client';

import React, { useMemo } from 'react';
import { Loader2, FileDown } from 'lucide-react';
import { isVideoKey } from './image-viewer-utils';
import { VideoViewer } from './VideoViewer';
import { useFileUrls } from './use-file-urls';
import { getFileIcon, MiddleEllipsisFileName } from './file-viewer-parts';

type FileViewerProps = {
  fileKeys: string[];
};

export const FileViewer = ({ fileKeys }: FileViewerProps) => {
  const videoKeys = useMemo(() => fileKeys.filter(isVideoKey), [fileKeys]);
  const nonVideoKeys = useMemo(() => fileKeys.filter((key) => !isVideoKey(key)), [fileKeys]);
  const files = useFileUrls(nonVideoKeys);

  if (fileKeys.length === 0) {
    return null;
  }

  return (
    <>
      {videoKeys.length > 0 && <VideoViewer videoKeys={videoKeys} />}
      {nonVideoKeys.length > 0 && (
        <div className="mt-2">
          <div className="flex flex-col gap-1.5">
            {files.map((file) => (
              <div key={file.key}>
                {file.loading ? (
                  <div
                    className="inline-flex items-center gap-2 px-3 py-1.5 bg-gray-100 dark:bg-gray-800 rounded-md max-w-full"
                    title={file.fileName}
                  >
                    <Loader2 className="w-4 h-4 animate-spin text-gray-400 flex-shrink-0" />
                    <MiddleEllipsisFileName name={file.fileName} className="text-sm text-gray-500" />
                  </div>
                ) : file.error ? (
                  <div
                    className="inline-flex items-center gap-2 px-3 py-1.5 bg-gray-100 dark:bg-gray-800 rounded-md max-w-full"
                    title={file.fileName}
                  >
                    {getFileIcon(file.fileName)}
                    <MiddleEllipsisFileName name={`${file.fileName} (Error)`} className="text-sm text-gray-500" />
                  </div>
                ) : (
                  <a
                    href={file.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 px-3 py-1.5 bg-gray-100 dark:bg-gray-800 rounded-md hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors group max-w-full"
                    title={file.fileName}
                  >
                    {getFileIcon(file.fileName)}
                    <MiddleEllipsisFileName
                      name={file.fileName}
                      className="text-sm text-blue-600 dark:text-blue-400 group-hover:underline"
                    />
                    <FileDown className="w-3.5 h-3.5 text-gray-400 group-hover:text-blue-500 flex-shrink-0" />
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
};
