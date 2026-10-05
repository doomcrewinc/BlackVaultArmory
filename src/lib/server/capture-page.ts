/**
 * The phone capture page (/capture/<token>) renders without the app's chrome
 * and without the database-status provider. The proxy knows the path; the root
 * layout does not, so the proxy hands it over as a request header. The proxy
 * removes any copy of the header that arrived from outside.
 */
export const CAPTURE_PAGE_HEADER = "x-bv-capture-page";

export function isCapturePagePath(pathname: string): boolean {
  return pathname.startsWith("/capture/");
}
