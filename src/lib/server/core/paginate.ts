/**
 * 分页工具（对应原版 backend/app/schemas/common.py 的 paginated）
 */
export function paginated<T>(items: T[], page = 1, pageSize = 20): { total: number; page: number; page_size: number; items: T[] } {
  const safePage = Math.max(page, 1);
  const safePageSize = Math.min(Math.max(pageSize, 1), 100);
  const start = (safePage - 1) * safePageSize;
  const end = start + safePageSize;
  return {
    total: items.length,
    page: safePage,
    page_size: safePageSize,
    items: items.slice(start, end),
  };
}

/** 解析分页查询参数 */
export function parsePagination(searchParams: URLSearchParams): { page: number; pageSize: number } {
  const rawPage = Number.parseInt(searchParams.get("page") ?? "1", 10);
  const rawPageSize = Number.parseInt(searchParams.get("page_size") ?? "20", 10);
  return {
    page: Number.isNaN(rawPage) ? 1 : rawPage,
    pageSize: Number.isNaN(rawPageSize) ? 20 : rawPageSize,
  };
}
