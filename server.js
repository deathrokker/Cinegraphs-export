const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const sharp = require('sharp');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ==================== CONFIGURATION ====================
const FANART_API_KEY = 'a6a74f76cc6e382e1f56ee0e4a4a9fb4';

// ChartJS canvas setup
const width = 500;
const height = 500;
const chartJSNodeCanvas = new ChartJSNodeCanvas({ width, height });

// ==================== HELPER: Get poster from Fanart.tv ====================
async function getPosterUrl(tmdbId) {
  if (!tmdbId) return null;
  try {
    const res = await fetch(`https://webservice.fanart.tv/v3/movies/${tmdbId}?api_key=${FANART_API_KEY}`);
    if (res.ok) {
      const data = await res.json();
      const poster = data.movieposter?.find(p => p.lang === 'en') || data.movieposter?.[0];
      if (poster && poster.url) return poster.url;
    }
  } catch (e) {
    console.warn('Fanart fetch failed:', e);
  }
  return null;
}

// ==================== HELPER: Generate chart image locally ====================
async function generateChartImage(aspects, scores, maxScale) {
  const configuration = {
    type: 'radar',
    data: {
      labels: aspects,
      datasets: [{
        label: 'Rating',
        data: scores,
        backgroundColor: 'rgba(26, 188, 156, 0.2)',
        borderColor: '#1abc9c',
        borderWidth: 2,
        pointBackgroundColor: '#1abc9c',
        pointRadius: 5
      }]
    },
    options: {
      responsive: false,
      maintainAspectRatio: true,
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false }
      },
      scales: {
        r: {
          beginAtZero: true,
          max: maxScale,
          ticks: { display: false, stepSize: 1 },
          grid: { color: '#ddd' },
          pointLabels: { color: '#333' }
        }
      }
    }
  };
  const buffer = await chartJSNodeCanvas.renderToBuffer(configuration);
  return buffer;
}

// ==================== HELPER: Wrap text ====================
function wrapText(text, maxLength) {
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const w of words) {
    if ((current + w).length > maxLength && current) {
      lines.push(current);
      current = w;
    } else {
      current = current ? current + ' ' + w : w;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function wrapTitle(title, maxChars) {
  if (title.length <= maxChars) return [title];
  const words = title.split(' ');
  const lines = [];
  let current = '';
  for (const w of words) {
    if ((current + w).length > maxChars && current) {
      lines.push(current);
      current = w;
    } else {
      current = current ? current + ' ' + w : w;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function escapeXml(str) {
  if (!str) return '';
  return str.replace(/[<>&'"]/g, c => {
    if (c === '<') return '&lt;';
    if (c === '>') return '&gt;';
    if (c === '&') return '&amp;';
    if (c === "'") return '&apos;';
    if (c === '"') return '&quot;';
    return c;
  });
}

// ==================== MAIN EXPORT ENDPOINT ====================
app.post('/export', async (req, res) => {
  try {
    const {
      title,
      tmdbId,
      aspects,
      scores,
      overall,
      maxScale,
      reviewText,
      dateWatched,
      manualPosterUrl
    } = req.body;

    // 1. Get poster URL
    let posterUrl = manualPosterUrl;
    if (!posterUrl && tmdbId) {
      posterUrl = await getPosterUrl(tmdbId);
    }
    if (!posterUrl) {
      posterUrl = `https://placehold.co/200x300?text=${encodeURIComponent(title)}`;
    }
    console.log('Poster URL:', posterUrl);

    // 2. Generate chart image
    let chartBuffer;
    try {
      chartBuffer = await generateChartImage(aspects, scores, maxScale);
      console.log('Chart buffer size:', chartBuffer.length, 'bytes');
    } catch (err) {
      console.error('Chart generation failed, using placeholder:', err);
      chartBuffer = await sharp({
        create: {
          width: 500,
          height: 500,
          channels: 4,
          background: { r: 255, g: 255, b: 255, alpha: 1 }
        }
      }).png().toBuffer();
    }

    // 3. Fetch poster image as buffer
    const posterResponse = await fetch(posterUrl);
    if (!posterResponse.ok) throw new Error(`Failed to fetch poster: ${posterResponse.status}`);
    const posterBuffer = await posterResponse.buffer();
    console.log('Poster buffer size:', posterBuffer.length, 'bytes');

    // 4. Resize poster
    const posterWidth = 300;
    const posterHeight = 450;
    const posterX = 80;
    const posterY = 170;
    const posterResized = await sharp(posterBuffer)
      .resize(posterWidth, posterHeight, { fit: 'cover' })
      .toBuffer();
    console.log('Poster resized size:', posterResized.length, 'bytes');

    // 5. Build SVG overlay for all text elements
    const compWidth = 1000;
    const compHeight = 1000;
    let svg = `<svg width="${compWidth}" height="${compHeight}" xmlns="http://www.w3.org/2000/svg">`;
    svg += `<style>
      .title { font-family: 'Segoe UI', sans-serif; font-size: 40px; font-weight: bold; fill: #333; text-anchor: middle; }
      .overall { font-family: 'Segoe UI', sans-serif; font-size: 20px; fill: #1abc9c; text-anchor: middle; }
      .date { font-family: 'Segoe UI', sans-serif; font-size: 16px; fill: #666; text-anchor: middle; }
      .review { font-family: 'Segoe UI', sans-serif; font-size: 14px; fill: #444; text-anchor: start; }
      .logo-square { stroke: #1abc9c; stroke-width: 2; fill: none; }
      .logo-text { font-family: 'Segoe UI', sans-serif; font-size: 10px; fill: #1abc9c; text-anchor: middle; }
      .app-name { font-family: 'Segoe UI', sans-serif; font-size: 20px; font-weight: bold; fill: #333; text-anchor: start; }
    </style>`;

    // Title (wrapped)
    const titleLines = wrapTitle(title, 40);
    let titleY = 70;
    for (const line of titleLines) {
      svg += `<text x="500" y="${titleY}" class="title">${escapeXml(line)}</text>`;
      titleY += 45;
    }

    // Overall rating
    svg += `<text x="500" y="${titleY + 10}" class="overall">Overall Rating: ${overall}/${maxScale}</text>`;
    if (dateWatched) {
      svg += `<text x="500" y="${titleY + 50}" class="date">Watched: ${escapeXml(dateWatched)}</text>`;
    }

    // Review text
    if (reviewText) {
      const lines = wrapText(reviewText, 60);
      let y = posterY + posterHeight + 30;
      for (const line of lines) {
        svg += `<text x="90" y="${y}" class="review">${escapeXml(line)}</text>`;
        y += 20;
      }
    }

    // Logo and app name at bottom
    const bottomY = compHeight - 60;
    const logoSize = 40;
    const textWidth = 120; // rough width of "Cinegraphs"
    const totalWidth = logoSize + 10 + textWidth;
    const startX = (compWidth - totalWidth) / 2;
    svg += `
      <rect x="${startX}" y="${bottomY - logoSize}" width="${logoSize}" height="${logoSize}" class="logo-square" />
      <text x="${startX + logoSize/2}" y="${bottomY - logoSize + 25}" class="logo-text">Logo</text>
      <text x="${startX + logoSize + 10}" y="${bottomY - 10}" class="app-name">Cinegraphs</text>
    `;

    svg += `</svg>`;
    const svgBuffer = Buffer.from(svg);
    console.log('SVG buffer size:', svgBuffer.length, 'bytes');

    // 6. Create final image by compositing all layers at once
    const chartX = compWidth - 500 - 80;
    const chartY = posterY + (posterHeight - 500) / 2;

    const layers = [
      { input: posterResized, left: posterX, top: posterY },
      { input: chartBuffer, left: chartX, top: chartY },
      { input: svgBuffer, left: 0, top: 0 }
    ];

    const finalBuffer = await sharp({
      create: {
        width: compWidth,
        height: compHeight,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 }
      }
    }).png().composite(layers).toBuffer();

    console.log('Final image size:', finalBuffer.length, 'bytes');
    res.set('Content-Type', 'image/png');
    res.set('Content-Disposition', `attachment; filename="${title.replace(/[^a-z0-9]/gi, '_')}_review.png"`);
    res.send(finalBuffer);
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).send('Export failed');
  }
});

// ==================== START SERVER ====================
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
