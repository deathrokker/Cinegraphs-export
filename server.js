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

// ==================== HELPER: Generate chart image ====================
async function generateChartImage(aspects, scores, maxScale, isDarkMode, primaryColor) {
  const pointLabelColor = isDarkMode ? '#fff' : '#333';
  const gridColor = isDarkMode ? 'rgba(255,255,255,0.2)' : '#ddd';

  const configuration = {
    type: 'radar',
    data: {
      labels: aspects,
      datasets: [{
        label: 'Rating',
        data: scores,
        backgroundColor: `${primaryColor}33`,
        borderColor: primaryColor,
        borderWidth: 2,
        pointBackgroundColor: primaryColor,
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
          grid: { color: gridColor },
          pointLabels: { color: pointLabelColor }
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

// ==================== Generate vignette overlay ====================
async function generateVignette(width, height, isDarkMode) {
  const intensity = isDarkMode ? 0.2 : 0.12;
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <radialGradient id="vignette" cx="50%" cy="50%" r="70%" fx="50%" fy="50%">
        <stop offset="0%" stop-color="black" stop-opacity="0"/>
        <stop offset="80%" stop-color="black" stop-opacity="${intensity}"/>
        <stop offset="100%" stop-color="black" stop-opacity="${intensity * 1.5}"/>
      </radialGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#vignette)"/>
  </svg>`;
  const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  return buffer;
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
      manualPosterUrl,
      isDarkMode = false,
      primaryColor = '#1abc9c'
    } = req.body;

    // Background color – pure black for dark mode
    const bgColor = isDarkMode ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };
    const textColor = isDarkMode ? '#fff' : '#333';
    const subTextColor = isDarkMode ? '#ccc' : '#666';
    const reviewColor = isDarkMode ? '#ddd' : '#444';

    // 1. Poster URL
    let posterUrl = manualPosterUrl;
    if (!posterUrl && tmdbId) {
      posterUrl = await getPosterUrl(tmdbId);
    }
    if (!posterUrl) {
      posterUrl = `https://placehold.co/200x300?text=${encodeURIComponent(title)}`;
    }
    console.log('Poster URL:', posterUrl);

    // 2. Chart
    let chartBuffer;
    try {
      chartBuffer = await generateChartImage(aspects, scores, maxScale, isDarkMode, primaryColor);
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

    // 3. Fetch poster
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

    // 5. Build SVG overlay (with dynamic review font size)
    const compWidth = 1000;
    const compHeight = 1000;

    let reviewFontSize = 14;
    let reviewLineLength = 60;
    if (reviewText) {
      if (reviewText.length < 100) {
        reviewFontSize = 18;
        reviewLineLength = 70;
      } else if (reviewText.length < 200) {
        reviewFontSize = 16;
        reviewLineLength = 65;
      } else if (reviewText.length < 300) {
        reviewFontSize = 14;
        reviewLineLength = 60;
      } else {
        reviewFontSize = 12;
        reviewLineLength = 55;
      }
    }

    const wrappedReview = reviewText ? wrapText(reviewText, reviewLineLength) : [];

    let svg = `<svg width="${compWidth}" height="${compHeight}" xmlns="http://www.w3.org/2000/svg">`;
    svg += `<style>
      .title { font-family: 'Segoe UI', sans-serif; font-size: 40px; font-weight: bold; fill: ${textColor}; text-anchor: middle; }
      .overall { font-family: 'Segoe UI', sans-serif; font-size: 20px; fill: ${primaryColor}; text-anchor: middle; }
      .date { font-family: 'Segoe UI', sans-serif; font-size: 16px; fill: ${subTextColor}; text-anchor: middle; }
      .review { font-family: 'Segoe UI', sans-serif; font-size: ${reviewFontSize}px; fill: ${reviewColor}; text-anchor: start; }
      .logo-square { stroke: ${primaryColor}; stroke-width: 2; fill: none; }
      .logo-text { font-family: 'Segoe UI', sans-serif; font-size: 10px; fill: ${primaryColor}; text-anchor: middle; }
      .app-name { font-family: 'Segoe UI', sans-serif; font-size: 20px; font-weight: bold; fill: ${textColor}; text-anchor: start; }
    </style>`;

    // Title
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
    if (wrappedReview.length) {
      let y = posterY + posterHeight + 30;
      for (const line of wrappedReview) {
        svg += `<text x="90" y="${y}" class="review">${escapeXml(line)}</text>`;
        y += reviewFontSize + 6;
      }
    }

    // Logo and app name
    const bottomY = compHeight - 60;
    const logoSize = 40;
    const textWidth = 120;
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

    // 6. Composite
    const chartX = compWidth - 500 - 80;
    const chartY = posterY + (posterHeight - 500) / 2;
    const vignetteBuffer = await generateVignette(compWidth, compHeight, isDarkMode);

    const layers = [
      { input: posterResized, left: posterX, top: posterY },
      { input: chartBuffer, left: chartX, top: chartY },
      { input: vignetteBuffer, left: 0, top: 0 },
      { input: svgBuffer, left: 0, top: 0 }
    ];

    const finalBuffer = await sharp({
      create: {
        width: compWidth,
        height: compHeight,
        channels: 4,
        background: bgColor
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