export interface IPageLike<TItem> {
  items: TItem[];
  next?: string | null;
  total?: number;
}

export interface ICollectPagesOptions {
  /** First offset to read from. */
  offset: number;
  /** Items requested per Spotify call. */
  pageSize: number;
  /** Hard cap on collected items; keeps memory and request counts bounded. */
  maxItems: number;
}

export interface ICollectedPages<TItem> {
  items: TItem[];
  /** Total reported by the last page, when Spotify provides one. */
  total?: number;
  /** Offset at which a caller can continue; absent when the end was reached. */
  nextOffset?: number;
  /** Number of Spotify requests made. */
  requests: number;
}

/**
 * Follows offset-based Spotify paging until the end, `maxItems`, or an empty page.
 * Never loops without progress and never returns more than `maxItems` items.
 */
export async function collectPages<TItem>(
  fetchPage: (offset: number, limit: number) => Promise<IPageLike<TItem>>,
  options: ICollectPagesOptions,
): Promise<ICollectedPages<TItem>> {
  const items: TItem[] = [];
  let offset = options.offset;
  let total: number | undefined;
  let requests = 0;
  let hasMore = false;

  while (items.length < options.maxItems) {
    const limit = Math.min(options.pageSize, options.maxItems - items.length);
    const page = await fetchPage(offset, limit);
    requests += 1;
    total = page.total ?? total;
    items.push(...page.items);
    offset += page.items.length;
    hasMore = Boolean(page.next) && page.items.length > 0;
    if (!hasMore) {
      break;
    }
  }

  const reachedEnd = !hasMore || (total !== undefined && offset >= total);
  return {
    items: items.slice(0, options.maxItems),
    ...(total !== undefined ? { total } : {}),
    ...(reachedEnd ? {} : { nextOffset: offset }),
    requests,
  };
}
