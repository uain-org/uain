# BAINK design handoff to Codex

Changed: `web/style.css`, `web/Orbit.jsx`, this file and `CHANGELOG.md`. `main.jsx`, logic, APIs and packages were not touched, and no new dependency is needed.

**Nothing has been built, rendered or run.** Only Read, Edit, Write, Glob and Grep were available. Every layout and visual claim below comes from reading the code and calculating, so all of it needs your render checks.

## Integration

`style.css` and `Orbit.jsx` drop in with no markup changes. The `Orbit` props and default export are unchanged. It adds one class, `orbit-failed`, which is styled in `style.css`.

## Check first

1. **Three.js 0.186 API.** I couldn't read `node_modules/three` because the symlink resolves outside this workspace, so these were written from memory of the API: `PMREMGenerator.fromScene`, `LatheGeometry`, `WireframeGeometry`, `MeshPhysicalMaterial`. `envMap` is set per material on purpose, because `envMapIntensity` doesn't apply to `scene.environment` in current Three.
2. **Hero exposure.** Softbox values and `envMapIntensity` in `Orbit.jsx` are estimates. Compare with `references/live-landing-final.png`. The core should stay near black with blue highlights, and tune the `box([...])` values if the rings blow out.
3. **Coin path.** It should rest at right of centre and pass behind the core, then in front of it, about every 84 seconds. On narrow canvases its path pulls in and it may briefly cross a ring.
4. **Coin mark.** The new lowercase b should read clearly at the rendered size.
5. **WebGL failure.** Disable WebGL and check `.orbit-fallback`. Force a context loss (`WEBGL_lose_context`) and check that the fallback appears, then that the orbit returns with its reflections intact.
6. **Motion.** Check the pause button, reduced motion on load, reduced motion switched on mid-session, and a hidden tab. Paused or reduced motion should show one still frame and no pointer response.
7. **Exact amounts.** Test `107,999,999,999,999.999999`, `0.000001` and the inactive `—` state in the balance panel at 320, 390, 768, 1024 and 1440px. Confirm nothing clips, and that `container-type` on `.balance-panel` and `.amount-input` doesn't collapse either one.
8. **Type scale.** All text went up one step, with an 11px minimum. Look for new wrapping in the sidebar brand row, the mobile `.quick-actions`, the landing header at 320px and `.hero-bottom`.
9. **Sticky header.** `.workspace-header` is now sticky. Check it under the modal and the mobile sidebar. Also check that the hidden sidebar can't be tabbed to at 700px and below.

## Markup changes for Codex

All optional except the first, which affects copying.

- **Security public address and key (`main.jsx:1859`, `:1872`):** each `<label className="field">` wraps a `copy-field` containing a `<button>`. Clicking the code text activates that button through the label, which can interfere with manual selection. Use a `<div className="field">`, with the styling unchanged.
- **Balance amount (`main.jsx:2821`):** `aria-label` on a plain `<div>` is unreliable. Add `role="group"`, or move the text into an `sr-only` span.
- **Long-amount threshold (`main.jsx:2822`):** `ledger.amount.length > 10` works with the new container sizing. Keep the `balance-amount-long` class name.
- **Menus:** add `aria-expanded` to both `.mobile-menu` buttons.
- **Scroll regions:** add `tabIndex={0}` with an accessible name to `.history-table` and `.request-list` so they can be scrolled by keyboard.
- **View tabs:** add `aria-pressed` to the `.view-tabs` buttons.
- **Workspace switcher:** `.workspace-switch` shows a chevron but isn't a control. Remove the chevron or wire it up.
- **Hero kicker:** `.hero-kicker` is typed in capitals in the JSX. I left it as existing brand copy.

## Truthful states

The inactive balance still shows `—`, its reason and the status text. No success styling, fabricated figures or decorative funds were added. `.status-badge.open` is darker for contrast, and its wording and meaning are unchanged.
