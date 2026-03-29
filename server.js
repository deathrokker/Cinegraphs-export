const express = require('express');
const fetch = require('node-fetch');
const sharp = require('sharp');

const app = express();
app.use(express.json({ limit: '10mb' }));

// ==================== CONFIGURATION ====================
const FANART_API_KEY = 'a6a74f76cc6e382e1f56ee0e4a4a9fb4';
// The Browserless API key will be read from an environment variable (set on Render)
const BROWSERLESS_API_KEY = process.env.BROWSERLESS_API_KEY;
if (!BROWSERLESS_API_KEY) {
  console.error('Missing BROWSERLESS_API_KEY environment variable');
  process.exit(1);
}
const BROWSERLESS_URL = `https://chrome.browserless.io/screenshot?token=${BROWSERLESS_API_KEY}`;

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

// ==================== HELPER: Generate chart image with Browserless ====================
async function generateChartImage(aspects, scores, maxScale) {
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
      <style>
        body { margin: 0; padding: 0; background: white; display: flex; justify-content: center; align-items: center; height: 100vh; }
        canvas { width: 500px; height: 500px; }
      </style>
    </head>
    <body>
      <canvas id="chart" width="500" height="500"></canvas>
      <script>
        const ctx = document.getElementById('chart').getContext('2d');
        new Chart(ctx, {
          type: 'radar',
          data: {
            labels: ${JSON.stringify(aspects)},
            datasets: [{
              data: ${JSON.stringify(scores)},
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
            plugins: { legend: { display: false }, tooltip: { enabled: false } },
            scales: {
              r: {
                beginAtZero: true,
                max: ${maxScale},
                ticks: { display: false, stepSize: 1 },
                grid: { color: '#ddd' },
                pointLabels: { color: '#333' }
              }
            }
          }
        });
      </script>
    </body>
    </html>
  `;

  const response = await fetch(BROWSERLESS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      html: html,
      options: {
        type: 'png',
        quality: 80,
        viewport: { width: 500, height: 500 },
        element: '#chart',
        screenshot: true,
        delay: 500
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Browserless request failed: ${response.statusText}`);
  }

  const buffer = await response.buffer();
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

    // 2. Generate chart image
    const chartBuffer = await generateChartImage(aspects, scores, maxScale);

    // 3. Fetch poster image as buffer
    const posterResponse = await fetch(posterUrl);
    if (!posterResponse.ok) throw new Error('Failed to fetch poster');
    const posterBuffer = await posterResponse.buffer();

    // 4. Create composite image
    const width = 1000;
    const height = 1000;
    let composite = sharp({
      create: {
        width,
        height,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 }
      }
    }).png();

    // Resize poster
    const posterWidth = 300;
    const posterHeight = 450;
    const posterX = 80;
    const posterY = 170;
    const posterResized = await sharp(posterBuffer)
      .resize(posterWidth, posterHeight, { fit: 'cover' })
      .toBuffer();

    // Place chart
    const chartWidth = 500;
    const chartHeight = 500;
    const chartX = width - chartWidth - 80;
    const chartY = posterY + (posterHeight - chartHeight) / 2;

    composite = composite.composite([
      { input: posterResized, left: posterX, top: posterY },
      { input: chartBuffer, left: chartX, top: chartY }
    ]);

    // 5. Build SVG overlay for all text elements
    let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`;
    svg += `<style>
      .title { font-family: 'Segoe UI', sans-serif; font-size: 40px; font-weight: bold; fill: #333; text-anchor: middle; }
      .overall { font-family: 'Segoe UI', sans-serif; font-size: 20px; fill: #1abc9c; text-anchor: middle; }
      .date { font-family: 'Segoe UI', sans-serif; font-size: 16px; fill: #666; text-anchor: middle; }
      .review { font-family: 'Segoe UI', sans-serif; font-size: 14px; fill: #444; text-anchor: start; }
      .logo-square { stroke: #1abc9c; stroke-width: 2; fill: none; }
      .logo-text { font-family: 'Segoe UI', sans-serif; font-size: 10px; fill: #1abc9c; text-anchor: middle; }
      .app-name { font-family: 'Segoe UI', sans-serif; font-size: 20px; font-weight: bold; fill: #333; text-anchor: start; }
    </style>`;

    svg += `<text x="500" y="70" class="title">${escapeXml(title)}</text>`;
    svg += `<text x="500" y="110" class="overall">Overall Rating: ${overall}/${maxScale}</text>`;
    if (dateWatched) {
      svg += `<text x="500" y="145" class="date">Watched: ${escapeXml(dateWatched)}</text>`;
    }
    if (reviewText) {
      const lines = wrapText(reviewText, 60);
      let y = posterY + posterHeight + 30;
      for (const line of lines) {
        svg += `<text x="90" y="${y}" class="review">${escapeXml(line)}</text>`;
        y += 20;
      }
    }

    const bottomY = height - 60;
    const logoSize = 40;
    const textWidth = 120; // rough width of "Cinegraphs"
    const totalWidth = logoSize + 10 + textWidth;
    const startX = (width - totalWidth) / 2;
    svg += `
      <rect x="${startX}" y="${bottomY - logoSize}" width="${logoSize}" height="${logoSize}" class="logo-square" />
      <text x="${startX + logoSize/2}" y="${bottomY - logoSize + 25}" class="logo-text">Logo</text>
      <text x="${startX + logoSize + 10}" y="${bottomY - 10}" class="app-name">Cinegraphs</text>
    `;

    svg += `</svg>`;
    const svgBuffer = Buffer.from(svg);
    composite = composite.composite([{ input: svgBuffer, left: 0, top: 0 }]);

    // 6. Output final image
    const finalBuffer = await composite.toBuffer();
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