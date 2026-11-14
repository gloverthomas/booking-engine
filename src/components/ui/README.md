# UI kit (`src/components/ui`)

Shared building blocks for the admin and, where useful, the public booking flow. Import from
`@/components/ui` (barrel) or the file directly. Names and props here are stable: other workstreams
depend on them, so add optional props rather than changing existing ones.

**Direction:** editorial / Swiss, from Ryan Kennedy's brand (warm peach, black, heavy tight uppercase
grotesk) but calmer and more utilitarian for one-handed phone use. Flat surfaces, hairline rules,
small radii, no shadows except on overlays.

## Tokens (`src/app/globals.css`)

CSS custom properties on `:root` (light) with a `prefers-color-scheme: dark` override, mapped to
Tailwind utilities.

| Utility                                                                            | Meaning                                                 |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `bg-paper` / `bg-surface` / `bg-peach` / `bg-sunken`                               | page / cards and inputs / brand emphasis / wells        |
| `text-ink` / `text-ink-muted` / `text-ink-subtle`                                  | body / secondary / hints (all pass AA on every surface) |
| `border-line` / `border-line-strong`                                               | decorative hairline / control border (3:1)              |
| `bg-primary text-on-primary`                                                       | primary action                                          |
| `text-success` `text-warning` `text-danger` `text-info` (+ `-tint` backgrounds)    | status                                                  |
| `font-display` or the `.display` class                                             | heavy, tight, uppercase headings                        |
| `.eyebrow`                                                                         | small uppercase label                                   |
| `rounded-control` `rounded-card` `rounded-pill`, `shadow-overlay`                  | shape (overlays only get a shadow)                      |
| `--tap` (2.75rem), `--space-page`, `--space-section`, `--duration-*`, `--ease-out` | touch target, rhythm, motion                            |

Every text/background pair is checked against WCAG AA in `tests/admin-foundation/tokens-contrast.test.ts`.
The display face (`--font-archivo`) is loaded by the admin layouts via `next/font`; other pages fall back to a
heavy system sans. Focus is a single 3px ring (`:focus-visible`), and `prefers-reduced-motion` removes movement.

## Components

All form controls render their own label, hint and error and wire `aria-describedby` / `aria-invalid`.
Pass `label` always: it is the accessible name.

| Component                                                   | Props (beyond native element props)                                                                                  |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `Button`                                                    | `variant` primary / secondary / ghost / danger, `size` sm / md / lg, `fullWidth`, `loading`                          |
| `ButtonLink`                                                | Same styling on a Next `Link`. `buttonClasses(...)` gives the classes for anything else (e.g. a plain `<a>`)         |
| `Input`                                                     | `label`, `hint`, `error`, `prefix`, `suffix`, `wrapperClassName`                                                     |
| `Textarea`, `Select`                                        | `label`, `hint`, `error`, `wrapperClassName` (Select takes `<option>` children; native select)                       |
| `Checkbox`, `Switch`                                        | `label`, `hint`, `error`. Switch is `role="switch"`. The whole row is a 44px target                                  |
| `Dialog`                                                    | `open`, `onClose`, `title`, `description?`, `footer?`, children. Native `<dialog>`: focus trap, Escape, focus return |
| `Sheet`                                                     | As Dialog plus `side="bottom"` (default, phones) or `"right"`                                                        |
| `Card`, `CardHeader`, `CardTitle`, `CardBody`, `CardFooter` | `Card tone="default" / "peach"`; `CardHeader title eyebrow actions`                                                  |
| `Badge`                                                     | `tone` neutral / success / warning / danger / info / peach                                                           |
| `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent`            | Compound. `defaultValue` or `value` + `onValueChange`; arrows / Home / End navigate                                  |
| `Table`, `THead`, `TBody`, `TR`, `TH`, `TD`                 | `Table caption="..."` (visually hidden name). Scrolls horizontally on phones                                         |
| `ToastProvider`, `useToast()`                               | `toast({ title, description?, tone: "success" / "danger" / "info" })`. The admin shell already mounts the provider   |
| `EmptyState`                                                | `title`, `description?`, `action?`, `icon?`                                                                          |
| `Alert`                                                     | `tone`, `title?`. Danger alerts use `role="alert"`                                                                   |
| `PageHeader`                                                | `title`, `eyebrow?`, `description?`, `actions?`                                                                      |

## Conventions

- Server actions in the admin return `ActionResult` (`src/server/admin-foundation/action.ts`). In client forms use
  `useSubmit()` from `@/components/admin/shell/use-submit` to get pending state, a form-level `error`, and
  `fieldErrors` keyed by input path.
- Money is cents everywhere except the input box: use `parseDollarsToCents`, `formatCents` and
  `centsToInputValue` from `@/server/admin-foundation/money`.
- Minimum touch target is 44px (`min-h-11`); `Button size="sm"` is compact only for mouse pointers.
