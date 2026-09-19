'use client';

import React from 'react';
import { FileText, FileArchive, FileSpreadsheet, FileCode, File } from 'lucide-react';

export const getFileIcon = (fileName: string) => {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  if (['pdf', 'doc', 'docx', 'txt', 'md', 'rtf'].includes(ext)) {
    return <FileText className="w-4 h-4 flex-shrink-0" />;
  }
  if (['zip', 'tar', 'gz', 'tgz', 'rar', '7z'].includes(ext)) {
    return <FileArchive className="w-4 h-4 flex-shrink-0" />;
  }
  if (['csv', 'xls', 'xlsx'].includes(ext)) {
    return <FileSpreadsheet className="w-4 h-4 flex-shrink-0" />;
  }
  if (
    ['ts', 'tsx', 'js', 'jsx', 'py', 'java', 'go', 'rs', 'html', 'css', 'json', 'xml', 'yaml', 'yml', 'sh'].includes(
      ext
    )
  ) {
    return <FileCode className="w-4 h-4 flex-shrink-0" />;
  }
  return <File className="w-4 h-4 flex-shrink-0" />;
};

const TAIL_CHARS = 8;

export const MiddleEllipsisFileName = ({ name, className }: { name: string; className?: string }) => {
  if (name.length <= TAIL_CHARS * 2) {
    return <span className={`truncate min-w-0 ${className ?? ''}`}>{name}</span>;
  }
  const tail = name.slice(-TAIL_CHARS);
  const head = name.slice(0, -TAIL_CHARS);
  return (
    <span className={`flex min-w-0 ${className ?? ''}`}>
      <span className="truncate min-w-0">{head}</span>
      <span className="flex-shrink-0">{tail}</span>
    </span>
  );
};
