import { PageSkeleton } from "@/components/admin/shell/page-boundary";

/**
 * Fallback for any admin page that has no boundary of its own (for example one added by another
 * workstream). Pages in this repo wrap themselves in PageBoundary so client navigations are instant.
 */
export default function AdminPageLoading() {
  return <PageSkeleton />;
}
