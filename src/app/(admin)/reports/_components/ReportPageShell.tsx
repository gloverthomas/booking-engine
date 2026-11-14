import { Suspense, type ReactNode } from "react";
import { loadReportPage, type ReportPageContext, type SearchParams } from "../_lib/page-data";

function Skeleton() {
  return (
    <div aria-busy="true" aria-label="Loading report">
      <div className="rpt-skeleton" style={{ height: "6rem", marginBottom: "1rem" }} />
      <div className="rpt-skeleton" />
    </div>
  );
}

async function Loaded({
  searchParams,
  render,
}: {
  searchParams: SearchParams;
  render: (ctx: ReportPageContext) => Promise<ReactNode>;
}) {
  const ctx = await loadReportPage(searchParams);
  return (
    <>
      {ctx.inputError ? (
        <p role="alert" className="rpt-error">
          {ctx.inputError}
        </p>
      ) : null}
      {await render(ctx)}
    </>
  );
}

/**
 * Pages read the session and the URL, which only exist at request time, so everything dynamic sits inside
 * one Suspense boundary (Cache Components) and the layout and navigation show immediately.
 */
export function ReportPageShell({
  searchParams,
  render,
}: {
  searchParams: SearchParams;
  render: (ctx: ReportPageContext) => Promise<ReactNode>;
}) {
  return (
    <Suspense fallback={<Skeleton />}>
      <Loaded searchParams={searchParams} render={render} />
    </Suspense>
  );
}
