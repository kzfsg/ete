import { list } from '@vercel/blob';
import type { Lister } from './store';

/** Real lister bound to the store token. Reads never cache: the site must reflect new runs immediately. */
export const blobLister: Lister = async (opts) => {
  const r = await list({ ...opts, token: process.env.BLOB_READ_WRITE_TOKEN } as Parameters<typeof list>[0]);
  return { blobs: r.blobs, folders: (r as { folders?: string[] }).folders, hasMore: r.hasMore, cursor: r.cursor };
};

export const fetchJson = (url: string) => fetch(url, { cache: 'no-store' }).then((r) => r.json());
