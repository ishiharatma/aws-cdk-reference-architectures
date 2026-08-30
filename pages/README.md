# AWS CDK Reference Architectures - Pattern Gallery

This directory contains the GitHub Pages site that showcases AWS CDK architecture patterns.

## 📁 File Structure

- `index.html` - Main HTML file
- `app.js` - JavaScript for dynamic pattern rendering
- `patterns.json` - Architecture pattern data

## 🚀 Usage

### Local Preview

To preview locally, start an HTTP server:

```bash
# With Python 3
cd pages
python -m http.server 8000

# With Node.js
npx http-server pages -p 8000
```

Then open `http://localhost:8000` in your browser.

### Deploying to GitHub Pages

1. Go to Settings > Pages in the GitHub repository
2. Set Source to the `/pages` folder on the `main` branch
3. Click Save

The site will be published at the GitHub Pages URL within a few minutes.

## ✨ Features

- **Search**: Search by title, description, and tags
- **Filtering**: Filter by difficulty and tags
- **Responsive Design**: Supports mobile, tablet, and desktop
- **AWS-style Design**: AWS-style UI built with Tailwind CSS

## 📝 How to Add a New Pattern

Add a new entry to `patterns.json`:

```json
{
  "id": "unique-pattern-id",
  "title": "Pattern title",
  "description": "Pattern description",
  "image": "your-pattern/overview.drawio.svg",
  "tags": ["CDK", "TypeScript"],
  "link": "your-pattern",
  "difficulty": "beginner|intermediate|advanced",
  "level": 100,
  "date": "YYYY-MM-DD",
  "draft": false,
  "articles": {
    "devto": "https://dev.to/your-article-url",
    "zenn": "https://zenn.dev/your-article-url",
    "qiita": "https://qiita.com/your-article-url"
  }
}
```

### Field Reference

| Field | Required | Description |
| ----- | -------- | ----------- |
| `id` | Yes | Unique identifier for the pattern (kebab-case). Not rendered; used to keep entries distinct. |
| `title` | Yes | Title shown on the card. Searchable. |
| `description` | Yes | Short summary shown on the card. Searchable. |
| `image` | No | Architecture diagram. Relative path (`<id>/overview.drawio.svg`, resolved inside this repository) or a full `https://` URL for an image hosted elsewhere. Omit to render a card with no image. |
| `tags` | Yes | Array of tag strings. Drives search and the tag filter dropdown. |
| `link` | Yes | "View Pattern" button target. A relative slug resolves to `infrastructure/workspaces/<slug>` in this repository (with a `#readme` anchor). A full `https://` URL is used as-is and marks the pattern as living in a separate repository (see below). |
| `difficulty` | Yes | `beginner` / `intermediate` / `advanced`. Drives the difficulty badge and the difficulty filter. |
| `level` | No | AWS content level: `100` / `200` / `300` / `400` / `500`. Drives the `Lv.` badge. Omit to hide the badge. |
| `date` | Yes | `YYYY-MM-DD`. Sorts the gallery (newest first) and drives the `NEW` ribbon (shown for 7 days after this date). |
| `draft` | No | `true` shows a `DRAFT` ribbon and disables the "View Pattern" button (rendered as a non-clickable "Coming Soon"). Defaults to `false`. |
| `articles` | No | Object with optional `devto` / `zenn` / `qiita` article URLs. Each present key renders an icon link. |

### Referencing a Pattern in Another Repository

By default a pattern's `link` and `image` are resolved inside this repository. To showcase a pattern that lives in one of your other **public** repositories, use full URLs:

```json
{
  "id": "my-external-pattern",
  "title": "My External Pattern",
  "description": "A pattern maintained in a separate public repository.",
  "image": "https://cdn.jsdelivr.net/gh/ishiharatma/other-repo@main/docs/overview.drawio.svg",
  "tags": ["CDK", "TypeScript"],
  "link": "https://github.com/ishiharatma/other-repo",
  "difficulty": "advanced",
  "level": 300,
  "date": "2026-09-01",
  "articles": {}
}
```

- `link`: any `http(s)://` URL is used as-is (no `#readme` suffix is appended). The card shows an **External repo** badge.
- `image`: any `http(s)://` URL is used as-is. Note that `raw.githubusercontent.com` serves `.svg` with `Content-Type: text/plain`, so it will not render inside an `<img>`. Use jsDelivr (`https://cdn.jsdelivr.net/gh/<user>/<repo>@<ref>/<path>`), the other repository's GitHub Pages URL, or copy the diagram into this repository's `pages/<id>/` directory instead.
- The `pages.yml` deploy workflow only copies diagrams from `infrastructure/workspaces/*/`, so an external image must be reachable at its full URL at runtime.

### About Images

Place an `overview.png` for each pattern. Images are displayed as follows:
- Shown at the top of the card with a height of 200px
- Scaled down while preserving aspect ratio (`object-fit: contain`)
- Background color: light gray (`#f8f9fa`)
- Clicking an image opens it enlarged in a modal

### About Article Links

If a pattern has related articles, you can add links via the `articles` field:

- **dev.to**: DEV Community article URL
- **zenn**: Zenn article URL
- **qiita**: Qiita article URL

When article links are set, icon links for each platform are shown on the card.
Platforms without a link are hidden (all fields are optional).

**Icons displayed:**
- **DEV** - black icon (dev.to)
- **Z** - blue icon (Zenn)
- **Q** - green icon (Qiita)

## 📱 QR Code

The header's "QR コード" button opens a modal showing `qr-code.svg`, a QR code pointing to the page URL (`https://ishiharatma.github.io/aws-cdk-reference-architectures/`). It is pre-generated at build time and embedded as a static image — no external API call or client-side JS library is used at runtime.

### Regenerating after a URL change

If the GitHub Pages URL ever changes, regenerate the SVG with the [`qrcode`](https://www.npmjs.com/package/qrcode) npm package:

```bash
npx qrcode -t svg -e M -q 1 -o pages/qr-code.svg "https://new-url-here/"
```

Also update the URL text shown in the modal (`.qr-modal-url` element in `index.html`) to match.

## 🎨 Design Customization

### Color Palette

Uses an AWS-style color palette:

- AWS Orange: `#FF9900`
- AWS Squid (dark): `#232F3E`
- AWS Squid Light: `#37475A`

### Difficulty Badges

- **beginner**: green
- **intermediate**: yellow
- **advanced**: red

## 🔧 Development

The site is built with plain HTML/CSS/JavaScript and requires no build process.

### Tech Stack

- HTML5
- Tailwind CSS (CDN)
- Vanilla JavaScript
- JSON for data storage

## 📄 License

For the license of this project, see the LICENSE file in the repository root.
