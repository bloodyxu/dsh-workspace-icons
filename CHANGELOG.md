# Changelog

All notable changes to `dsh-workspace-icons` are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [2.1.0] — 2026-11-11

### Added

- Every bundled icon now has its own colour. Hues are spread with the golden angle over the icon's position in the catalog, generated in OKLCH and emitted as sRGB hex, so all 160 presets share one perceived lightness: contrast lands at 3.7–4.3:1 on the light theme and 4.1–4.9:1 on the dark theme. The same colour is used in sidebar rows, the picker, the settings previews and the AI suggestion row.
- A "Icon colours" section in the README explaining how the colours are derived.

### Changed

- Focus returns to the element that opened the picker when it closes.
- Stored icon entries are capped, so a long-lived profile cannot grow its localStorage use without bound.
- The suggestion route only reads directories that the workspace registry knows about, and rejects oversized request bodies.

## [2.0.0] — 2026-11-06

### Changed

- **Breaking:** the bundled icon set moved from Phosphor to [Hugeicons](https://hugeicons.com) (free set 4.4.0, MIT), 160 curated icons in 10 groups. Stored `kind: "glyph"` entries whose names do not exist in the new catalog are dropped on read; emoji and image icons are unaffected.
- Icons render as stroke-rounded artwork on a 24×24 grid, still through a CSS mask, so the colour and the theme still apply.

## [1.2.0] — 2026-11-06

### Added

- AI suggestions: for projects without a manual icon, the Host half reads bounded evidence (manifests, README head, top-level layout, language mix) and asks the configured default model to pick one icon, with a local rule engine as the fallback.
- `POST /api/workspace-icons/suggest` route on the owner-authenticated connection service.
- "Re-suggest" per project and "Re-suggest all" in the settings page, plus an on/off switch for the whole feature.

## [1.1.0] — 2026-10-28

### Added

- 155 bundled Phosphor icons in 10 groups with a search box, so presets no longer mean emoji only.
- Three-tab editor: icons, emoji, image URL.

## [1.0.0] — 2026-10-28

### Added

- Initial release: a "Project icons" settings page and a right-click picker on sidebar project rows, storing per-project emoji or image icons in localStorage.
