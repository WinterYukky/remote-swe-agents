'use client';

import { useState, useEffect } from 'react';
import { getFileUrls } from '@/actions/file/action';

export type FileUrlData = {
  key: string;
  url: string;
  fileName: string;
  loading: boolean;
  error: boolean;
};

export const getFileName = (key: string): string => {
  const parts = key.split('/');
  return parts[parts.length - 1] || key;
};

/**
 * Resolve S3 object keys to short-lived pre-signed GET URLs, with a
 * cross-render cache so re-renders don't re-fetch. Shared by FileViewer
 * (download/open links) and VideoViewer (inline playback) so the URL
 * fetch + cache + error handling lives in one place.
 */
export const useFileUrls = (keys: string[]): FileUrlData[] => {
  const [items, setItems] = useState<FileUrlData[]>([]);
  const [cache, setCache] = useState<Map<string, FileUrlData>>(new Map());

  useEffect(() => {
    const load = async () => {
      const current = keys.map((key) => {
        const cached = cache.get(key);
        return cached ?? { key, url: '', fileName: getFileName(key), loading: true, error: false };
      });
      setItems(current);

      try {
        const result = await getFileUrls({ keys });

        if (result?.data) {
          const newCache = new Map(cache);
          result.data.forEach((item) => {
            newCache.set(item.key, {
              key: item.key,
              url: item.url,
              fileName: getFileName(item.key),
              loading: false,
              error: false,
            });
          });
          setCache(newCache);

          setItems(
            keys.map((key) => {
              const cached = newCache.get(key);
              return cached || { key, url: '', fileName: getFileName(key), loading: false, error: true };
            })
          );
        }
      } catch (error) {
        console.error('Failed to load file URLs:', error);
        const newCache = new Map(cache);
        keys.forEach((key) => {
          if (!newCache.has(key)) {
            newCache.set(key, { key, url: '', fileName: getFileName(key), loading: false, error: true });
          }
        });
        setCache(newCache);

        setItems(
          keys.map((key) => {
            const cached = newCache.get(key);
            return cached || { key, url: '', fileName: getFileName(key), loading: false, error: true };
          })
        );
      }
    };

    if (keys.length > 0) {
      load();
    } else {
      setItems([]);
    }
    // `cache` is a mutable cross-render cache Map; intentionally not a
    // dependency (re-running on mutation would defeat the cache).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys]);

  return items;
};
