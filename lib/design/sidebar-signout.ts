/**
 * The sign-out control for the ported `nav.dside` rail (MODULE: design
 * integration).
 *
 * The rail-carrying designs — the Overview desk, the portfolio, the expert and
 * liquidity workspaces — ship an identity card at the foot of the sidebar and
 * no way out of the account. This adds one, in the place the AppShell puts it:
 * directly beneath the identity, so the rail answers "who am I" and "leave" in
 * one spot instead of hiding the exit in a header the user has to hunt for.
 *
 * The button is a real `<button>` rather than a link, because signing out is
 * an action and not a destination, and it carries the design's own icon
 * language (24×24, `fill:none; stroke:currentColor`).
 *
 * What this module deliberately does NOT do is sign anyone out, and it does
 * not know what a session is: the caller says whether an account is signed in
 * (`setSidebarSignOutActive`) and owns the click. That keeps this file free of
 * any knowledge about the session, and it keeps the "clear the API token, then
 * end the Auth.js session" order in one place (the caller) rather than spread
 * across a DOM helper.
 *
 * The colours are derived from `currentColor` with `color-mix`, not from the
 * design's own custom properties: the six designs that use this rail do not
 * agree on their variable names (`--ln`, `--line`), while the text colour they
 * all inherit does carry the theme. The result is one button that reads
 * correctly in both the light and the dark theme of whichever design is
 * mounted.
 *
 * The control follows the identity card it belongs to. The designs hide that
 * card whenever the rail is compact — collapsed to a horizontal pill, or laid
 * out as a top strip on a narrow screen — and the AppShell's own sign-out
 * does the same thing there: the row stays, its label folds away. So the
 * button reads the identity's visibility rather than a hard-coded breakpoint,
 * which keeps it correct across six designs that do not share one.
 *
 * Scoped to `nav.dside` on purpose: designs with a different navigation
 * (`nav.toplinks`, the admin chrome, the staking top bar) are left alone, the
 * same way `lib/design/sidebar-nav.ts` leaves them alone.
 */

/** The class the injected button carries, and the hook the stylesheet uses. */
const BUTTON_CLASS = "pb-signout";

/** Added while the rail is compact: icon only, no label. */
const COMPACT_CLASS = "pb-signout-compact";

/** The id of the injected stylesheet, so a second mount cannot stack copies. */
const STYLE_ID = "pb-sidebar-signout";

/** Lucide's `LogOut`, in the design's own stroke language. */
const LOG_OUT_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>' +
  '<polyline points="16 17 21 12 16 7"/>' +
  '<line x1="21" x2="9" y1="12" y2="12"/>' +
  "</svg>";

/**
 * The button's own rules.
 *
 * `[hidden]` is spelled out because the base rule sets `display:flex`, and an
 * author rule beats the browser's `[hidden]{display:none}` whatever their
 * specificity — without this, hiding the button for a signed-out visitor
 * would not hide it at all.
 */
const STYLES = `
.pb-signout{
  display:flex;align-items:center;gap:8px;width:100%;
  padding:8px;border-radius:9px;
  border:1px solid color-mix(in srgb,currentColor 22%,transparent);
  background:none;color:inherit;font-family:inherit;font-size:11px;line-height:1.2;
  cursor:pointer;text-align:left;
  transition:background .18s ease,border-color .18s ease;
}
.pb-signout:hover{background:color-mix(in srgb,currentColor 10%,transparent)}
.pb-signout:focus-visible{outline:2px solid color-mix(in srgb,currentColor 55%,transparent);outline-offset:1px}
.pb-signout svg{width:14px;height:14px;flex:none;opacity:.85}
.pb-signout-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pb-signout[hidden]{display:none}
.pb-signout-compact{width:auto;flex:none;padding:7px 9px}
.pb-signout-compact .pb-signout-label{display:none}
`;

/**
 * What the helper remembers about one injected button.
 *
 * `active` is the caller's answer to "is an account signed in"; `identity` is
 * the card whose visibility decides between the full and the compact control.
 */
interface SignOutState {
  active: boolean;
  identity: HTMLElement | null;
}

/** Per-button state, so a re-mount cannot leave the previous one behind. */
const states = new WeakMap<HTMLButtonElement, SignOutState>();

/** Observers and listeners of the mounted button, torn down with it. */
let teardown: (() => void) | null = null;

/**
 * Re-reads the identity card and puts the button in the matching state.
 *
 * The label follows the identity: visible when the card is, folded away when
 * the design hides it.
 */
function sync(button: HTMLButtonElement): void {
  const state = states.get(button);
  if (!state) return;

  const identityShown = state.identity
    ? button.ownerDocument.defaultView?.getComputedStyle(state.identity).display !== "none"
    : true;

  button.classList.toggle(COMPACT_CLASS, !identityShown);
  button.hidden = !state.active;
}

/**
 * Adds a sign-out button to the mounted design's sidebar.
 *
 * Returns the button, or null when the design has no rail to put it in — the
 * admin chrome and the staking top bar, which are not this sidebar.
 *
 * The button starts hidden: the caller marks it active once it knows whether
 * an account is signed in.
 */
export function applySidebarSignOut(host: HTMLElement): HTMLButtonElement | null {
  const rail = host.querySelector<HTMLElement>("nav.dside") ?? host.querySelector<HTMLElement>(".dside");

  if (!rail) return null;

  const doc = host.ownerDocument;

  removeSidebarSignOut();

  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLES;
  doc.head.appendChild(style);

  const button = doc.createElement("button");
  button.type = "button";
  button.className = BUTTON_CLASS;
  button.setAttribute("aria-label", "Sign out");
  button.title = "Sign out";
  button.innerHTML = `${LOG_OUT_ICON}<span class="pb-signout-label">Sign out</span>`;

  // Directly under the identity card, which is the last thing in the rail.
  const identity = rail.querySelector<HTMLElement>(".me");

  if (identity?.parentNode) {
    identity.parentNode.insertBefore(button, identity.nextSibling);
  } else {
    rail.appendChild(button);
  }

  states.set(button, { active: false, identity });

  // The compact state is decided by the design's own CSS, so it is watched
  // rather than predicted: the rail's box changes when it collapses or when
  // the viewport crosses the design's breakpoint, and the page wrapper's class
  // changes when the design's own menu toggles it.
  const observer = new MutationObserver(() => sync(button));
  observer.observe(rail, { attributes: true, attributeFilter: ["class", "style"] });
  observer.observe(rail.closest(".app") ?? host, { attributes: true, attributeFilter: ["class"] });

  const resize = new ResizeObserver(() => sync(button));
  resize.observe(rail);

  const onResize = () => sync(button);
  window.addEventListener("resize", onResize);

  teardown = () => {
    observer.disconnect();
    resize.disconnect();
    window.removeEventListener("resize", onResize);
  };

  sync(button);

  return button;
}

/**
 * Says whether the button belongs on screen.
 *
 * The caller owns that answer — this module does not know about sessions —
 * and it can change while the page is open (the session resolving, or being
 * ended).
 */
export function setSidebarSignOutActive(button: HTMLButtonElement | null, active: boolean): void {
  if (!button) return;

  const state = states.get(button);
  if (!state) return;

  state.active = active;
  sync(button);
}

/** Removes the injected stylesheet. The button itself dies with the design. */
export function removeSidebarSignOut(): void {
  teardown?.();
  teardown = null;
  document.getElementById(STYLE_ID)?.remove();
}
