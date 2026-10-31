/**
 * MODULE 07 - the colour language of the copy book.
 *
 * One colour per traded instrument, taken from the application's own palette
 * and long enough that a book with six instruments still tells them apart. A
 * seventh instrument reuses the first colour rather than inventing a hue the
 * rest of the product does not have.
 *
 * WHY IT LIVES HERE. The chart that draws these lines is loaded through
 * `next/dynamic` with `ssr: false`, because lightweight-charts is a browser
 * library. The legend beside the chart needs the same list, and the page is
 * server-rendered, so the list cannot live in the chart module: importing it
 * from there would drag the browser library into the server graph. One list,
 * two importers, no duplication.
 */
export const COPY_SYMBOL_COLOURS = [
  "#FF5A1F",
  "#38BDF8",
  "#A78BFA",
  "#00D26A",
  "#F59E0B",
  "#F43F5E",
] as const;
