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
  "image": "your-pattern/overview.png",
  "tags": ["CDK", "TypeScript"],
  "link": "your-pattern",
  "difficulty": "beginner|intermediate|advanced",
  "date": "YYYY-MM-DD",
  "articles": {
    "devto": "https://dev.to/your-article-url",
    "zenn": "https://zenn.dev/your-article-url",
    "qiita": "https://qiita.com/your-article-url"
  }
}
```

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
