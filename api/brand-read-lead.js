try {
  require('dotenv').config({ path: `${process.cwd()}/.env.local` });
} catch (_) {
  // dotenv is only needed for local development
}

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');
const { Resend } = require('resend');
const { google } = require('googleapis');

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function sanitize(value = '') {
  return String(value).replace(/\s+/g, ' ').trim();
}

function toParagraph(value = '') {
  return sanitize(value).replace(/([.!?])\s+/g, '$1\n\n');
}

function safeFilename(value = 'brand-read') {
  return sanitize(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'brand-read';
}

function titleFontSize(title = '') {
  const length = sanitize(title).length;
  if (length > 34) return 32;
  if (length > 24) return 38;
  return 44;
}

function fitPosterTitle(doc, title, width, maxHeight, initialSize) {
  let size = initialSize;
  while (size > 24) {
    doc.font('Times-Bold').fontSize(size);
    const height = doc.heightOfString(title, {
      width,
      lineGap: -2
    });
    if (height <= maxHeight) {
      return { size, height };
    }
    size -= 2;
  }

  doc.font('Times-Bold').fontSize(24);
  return {
    size: 24,
    height: doc.heightOfString(title, { width, lineGap: -2 })
  };
}

function posterAssetPath(visualWorld = 'sage') {
  const fileMap = {
    ruler: 'Ruler.png',
    sage: 'Sage.png',
    magician: 'Magician.png',
    creator: 'Creator.png',
    lover: 'Lover.png',
    caregiver: 'Caregiver.png',
    hero: 'Hero.png',
    rebel: 'Rebel.png',
    explorer: 'Explorer.png',
    everyman: 'Everyman.png',
    innocent: 'Innocent.png',
    jester: 'Jester.png'
  };

  const fileName = fileMap[String(visualWorld || '').toLowerCase()] || fileMap.sage;
  const fullPath = path.join(process.cwd(), fileName);
  return fs.existsSync(fullPath) ? fullPath : null;
}

function posterAssetFilename(visualWorld = 'sage') {
  const fileMap = {
    ruler: 'Ruler.png',
    sage: 'Sage.png',
    magician: 'Magician.png',
    creator: 'Creator.png',
    lover: 'Lover.png',
    caregiver: 'Caregiver.png',
    hero: 'Hero.png',
    rebel: 'Rebel.png',
    explorer: 'Explorer.png',
    everyman: 'Everyman.png',
    innocent: 'Innocent.png',
    jester: 'Jester.png'
  };

  return fileMap[String(visualWorld || '').toLowerCase()] || fileMap.sage;
}

async function loadPosterAsset(visualWorld = 'sage') {
  const localPath = posterAssetPath(visualWorld);
  if (localPath) {
    return fs.readFileSync(localPath);
  }

  const fileName = posterAssetFilename(visualWorld);
  const host =
    process.env.PUBLIC_SITE_URL ||
    process.env.VERCEL_PROJECT_PRODUCTION_URL ||
    process.env.VERCEL_URL ||
    'www.saharstudio.com';
  const normalizedHost = String(host).replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const assetUrl = `https://${normalizedHost}/${encodeURIComponent(fileName)}`;

  const response = await fetch(assetUrl);
  if (!response.ok) {
    throw new Error(`Unable to load poster asset: ${assetUrl}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

function withTimeout(promise, ms, label) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out`));
    }, ms);
  });

  return Promise.race([
    promise.finally(() => clearTimeout(timeoutId)),
    timeoutPromise
  ]);
}

function isSheetsConfigured() {
  return Boolean(
    process.env.GOOGLE_SHEET_ID &&
    process.env.GOOGLE_CLIENT_EMAIL &&
    process.env.GOOGLE_PRIVATE_KEY
  );
}

function isSmtpConfigured() {
  return Boolean(
    process.env.SMTP_HOST &&
    process.env.SMTP_PORT &&
    process.env.SMTP_USER &&
    process.env.SMTP_PASS &&
    process.env.MAIL_FROM
  );
}

function isResendConfigured() {
  return Boolean(
    process.env.RESEND_API_KEY &&
    process.env.MAIL_FROM
  );
}

async function getSheetsClient() {
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;

  const auth = new google.auth.JWT({
    email: clientEmail,
    key: privateKey.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  await auth.authorize();
  return google.sheets({ version: 'v4', auth });
}

async function getSheetRange(sheets, spreadsheetId) {
  const configuredTab = process.env.GOOGLE_SHEET_TAB;
  if (configuredTab) return `${configuredTab}!A:L`;

  const metadata = await sheets.spreadsheets.get({ spreadsheetId });
  const firstSheetTitle = metadata.data?.sheets?.[0]?.properties?.title;

  if (!firstSheetTitle) {
    throw new Error('Unable to find a sheet tab in the spreadsheet');
  }

  return `${firstSheetTitle}!A:L`;
}

async function appendLeadToSheet({ email, url, source, result }) {
  if (!isSheetsConfigured()) {
    return { ok: false, skipped: true, reason: 'Sheets not configured' };
  }

  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const sheets = await getSheetsClient();
  const range = await getSheetRange(sheets, spreadsheetId);

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[
        new Date().toISOString(),
        source,
        url,
        email,
        sanitize(result.title),
        sanitize(result.genre),
        sanitize(result.tagline),
        sanitize(result.summary),
        sanitize(result.current),
        sanitize(result.gap),
        sanitize(result.voice),
        sanitize(result.direction)
      ]]
    }
  });

  return { ok: true };
}

function generatePdfBuffer({ email, url, result }) {
  return new Promise(async (resolve, reject) => {
    const doc = new PDFDocument({
      autoFirstPage: false,
      size: 'A4',
      margins: { top: 56, bottom: 56, left: 56, right: 56 },
      info: {
        Title: `${sanitize(result.brandName || 'Brand')} Brand Review`,
        Author: 'SAHAR',
        Subject: 'Brand Review Report'
      }
    });

    const buffers = [];
    doc.on('data', (chunk) => buffers.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    const colors = {
      bg: '#10151b',
      text: '#f1ece4',
      muted: '#8d939b',
      gold: '#d5b06d',
      line: '#2a3139',
      card: '#161b21'
    };

    const sections = [
      ['Quick Read', result.summary],
      ['What It Signals', result.current],
      ['How It Comes Across', result.strength],
      ['What Is Missing', result.gap],
      ['Mixed Signals', result.mismatch],
      ['Tone Check', result.voice],
      ['What To Do Next', result.direction],
      ['What To Amplify', result.amplify],
      ['What To Drop', result.drop]
    ].filter(([, value]) => sanitize(value));

    doc.addPage();
    const pageWidth = doc.page.width;
    const pageHeight = doc.page.height;
    const posterX = 0;
    const posterY = 0;
    const posterW = pageWidth;
    const posterH = pageHeight;
    let posterImage = null;
    try {
      posterImage = await loadPosterAsset(result.visualWorld);
    } catch (_) {
      posterImage = null;
    }

    doc.rect(0, 0, pageWidth, pageHeight).fill(colors.bg);

    doc.save();
    doc.rect(posterX, posterY, posterW, posterH).clip();
    if (posterImage) {
      doc.image(posterImage, posterX, posterY, { width: posterW, height: posterH });
    } else {
      doc.rect(posterX, posterY, posterW, posterH).fill('#1d232a');
    }
    doc.restore();
    doc.fillOpacity(1);
    doc.strokeOpacity(1);

    doc.fillColor('#dcd4c6')
      .font('Helvetica')
      .fontSize(11)
      .text(`${sanitize(result.brandName || 'Your Brand')}, ON SCREEN`, 54, 44, {
        width: pageWidth - 108,
        characterSpacing: 2.4,
        lineBreak: false
      });

    const titleText = sanitize(result.title || 'Untitled');
    const titleWidth = pageWidth - 108;
    const titleMetrics = fitPosterTitle(
      doc,
      titleText,
      titleWidth,
      132,
      titleFontSize(result.title)
    );
    const titleY = pageHeight - 298 - titleMetrics.height;

    doc.fillColor('#13171c')
      .font('Times-Bold')
      .fontSize(titleMetrics.size)
      .text(titleText, 56, titleY + 2, {
        width: titleWidth,
        lineGap: -2,
        height: 132,
        ellipsis: true
      });

    doc.fillColor(colors.text)
      .font('Times-Bold')
      .fontSize(titleMetrics.size)
      .text(titleText, 54, titleY, {
        width: titleWidth,
        lineGap: -2,
        height: 132,
        ellipsis: true
      });

    const genreY = titleY + titleMetrics.height + 12;
    doc.fillColor('#201710')
      .font('Helvetica')
      .fontSize(12)
      .text(sanitize(result.genre || 'Brand Review'), 55, genreY + 1, {
        width: pageWidth - 108,
        characterSpacing: 2.2,
        height: 22,
        ellipsis: true,
        lineBreak: false
      });

    doc.fillColor(colors.gold)
      .font('Helvetica')
      .fontSize(12)
      .text(sanitize(result.genre || 'Brand Review'), 54, genreY, {
        width: pageWidth - 108,
        characterSpacing: 2.2,
        height: 22,
        ellipsis: true,
        lineBreak: false
      });

    if (sanitize(result.tagline)) {
      doc.fillColor('#efeae1')
        .font('Helvetica')
        .fontSize(12)
        .text(sanitize(result.tagline), 54, pageHeight - 118, {
          width: pageWidth * 0.5,
          lineGap: 3,
          height: 52,
          ellipsis: true
        });
    }

    doc.addPage();
    doc.fillOpacity(1);
    doc.strokeOpacity(1);
    doc.rect(0, 0, pageWidth, pageHeight).fill(colors.bg);
    doc.fillColor(colors.gold)
      .font('Helvetica')
      .fontSize(10)
      .text('SAHAR | DEEP READ', 56, 52, { characterSpacing: 2 });

    doc.fillColor(colors.text)
      .font('Times-Roman')
      .fontSize(30)
      .text(sanitize(result.brandName || 'Your Brand'), 56, 92);

    doc.fillColor(colors.muted)
      .font('Helvetica')
      .fontSize(9)
      .text('WEBSITE', 56, 134, { characterSpacing: 1.8 });

    doc.fillColor(colors.text)
      .font('Helvetica')
      .fontSize(11)
      .text(sanitize(url), 56, 151, { width: 483 });

    doc.moveTo(56, 182).lineTo(539, 182).strokeColor(colors.line).stroke();

    doc.roundedRect(56, 212, 483, 132, 8).fill(colors.card);
    doc.fillColor(colors.gold)
      .font('Helvetica')
      .fontSize(9)
      .text('FIRST READ', 76, 236, { characterSpacing: 2 });

    doc.fillColor(colors.text)
      .font('Times-Roman')
      .fontSize(15)
      .text(sanitize(result.summary), 76, 262, {
        width: 443,
        lineGap: 5
      });

    let y = 392;

    sections.slice(1).forEach(([heading, body], index, arr) => {
      const bodyText = toParagraph(body);
      const estimatedHeight = 56 + doc.heightOfString(bodyText, {
        width: 483,
        align: 'left',
        lineGap: 5
      }) + 30;

      if (y + estimatedHeight > doc.page.height - 76) {
        doc.addPage();
        doc.fillOpacity(1);
        doc.strokeOpacity(1);
        doc.rect(0, 0, doc.page.width, doc.page.height).fill(colors.bg);
        doc.fillColor(colors.gold)
          .font('Helvetica')
          .fontSize(10)
          .text('SAHAR | BRAND REVIEW', 56, 44, { characterSpacing: 2 });
        y = 90;
      }

      doc.moveTo(56, y).lineTo(539, y).strokeColor(colors.line).stroke();

      y += 16;

      doc.fillColor(colors.gold)
        .font('Times-Bold')
        .fontSize(20)
        .text(heading, 56, y, {
          width: 483,
          lineGap: 1
        });

      y = doc.y + 16;

      doc.fillColor(colors.text)
        .font('Helvetica')
        .fontSize(12)
        .text(bodyText, 56, y, {
          width: 483,
          lineGap: 5
        });

      y = doc.y + 34;
    });

    doc.end();
  });
}

async function sendReportEmailWithSmtp({ email, url, result, pdfBuffer }) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || Number(process.env.SMTP_PORT) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  const brandName = sanitize(result.brandName || 'Your Brand');
  const from = process.env.MAIL_FROM;
  const replyTo = process.env.MAIL_REPLY_TO || from;

  await transporter.sendMail({
    from,
    to: email,
    replyTo,
    subject: `${brandName} | Brand Review from SAHAR`,
    text: [
      `Here is your Brand Review for ${brandName}.`,
      '',
      'Attached is the PDF version of the report.',
      '',
      'If you want to turn this into sharper priorities and a clearer direction, you can book a strategic session here:',
      '$197 / 60 min. Paid at booking.',
      'If we continue into a project, the fee goes toward the work.',
      '',
      'https://calendly.com/maryna-dabrytskaya/sahar-strategic-session',
      '',
      'SAHAR'
    ].join('\n'),
    html: `
      <div style="background:#10151b;padding:32px;font-family:Helvetica,Arial,sans-serif;color:#f1ece4;">
        <div style="max-width:640px;margin:0 auto;">
          <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#d5b06d;margin-bottom:18px;">SAHAR | Brand Review</div>
          <div style="font-family:Georgia,'Times New Roman',serif;font-size:30px;line-height:1.1;margin-bottom:14px;">${brandName}</div>
          <p style="font-size:15px;line-height:1.75;color:#c9c3bb;margin:0 0 18px 0;">Here is your Brand Review report. The PDF is attached.</p>
          <p style="font-size:15px;line-height:1.75;color:#c9c3bb;margin:0 0 24px 0;">If you want to turn this into sharper priorities and a clearer direction, you can book a strategic session below.</p>
          <p style="margin:0 0 24px 0;">
            <a href="https://calendly.com/maryna-dabrytskaya/sahar-strategic-session" style="display:inline-block;padding:12px 18px;border:1px solid #d5b06d;color:#f1ece4;text-decoration:none;letter-spacing:1px;text-transform:uppercase;font-size:12px;">Book a Strategic Session</a>
          </p>
          <p style="font-size:13px;line-height:1.7;color:#d5b06d;margin:0 0 8px 0;">$197 / 60 min. Paid at booking.</p>
          <p style="font-size:13px;line-height:1.7;color:#8d939b;margin:0 0 24px 0;">If we continue into a project, the fee goes toward the work.</p>
          <p style="font-size:13px;line-height:1.7;color:#8d939b;margin:0;">Website reviewed: ${sanitize(url)}</p>
        </div>
      </div>
    `,
    attachments: [{
      filename: `${safeFilename(brandName)}-brand-review.pdf`,
      content: pdfBuffer,
      contentType: 'application/pdf'
    }]
  });

  return { ok: true, provider: 'smtp' };
}

async function sendReportEmailWithResend({ email, url, result, pdfBuffer }) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const brandName = sanitize(result.brandName || 'Your Brand');
  const from = process.env.MAIL_FROM;
  const replyTo = process.env.MAIL_REPLY_TO || from;

  const response = await resend.emails.send({
    from,
    to: email,
    replyTo,
    subject: `${brandName} | Brand Review from SAHAR`,
    text: [
      `Here is your Brand Review for ${brandName}.`,
      '',
      'Attached is the PDF version of the report.',
      '',
      'If you want to turn this into sharper priorities and a clearer direction, you can book a strategic session here:',
      '$197 / 60 min. Paid at booking.',
      'If we continue into a project, the fee goes toward the work.',
      '',
      'https://calendly.com/maryna-dabrytskaya/sahar-strategic-session',
      '',
      'SAHAR'
    ].join('\n'),
    html: `
      <div style="background:#10151b;padding:32px;font-family:Helvetica,Arial,sans-serif;color:#f1ece4;">
        <div style="max-width:640px;margin:0 auto;">
          <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#d5b06d;margin-bottom:18px;">SAHAR | Brand Review</div>
          <div style="font-family:Georgia,'Times New Roman',serif;font-size:30px;line-height:1.1;margin-bottom:14px;">${brandName}</div>
          <p style="font-size:15px;line-height:1.75;color:#c9c3bb;margin:0 0 18px 0;">Here is your Brand Review report. The PDF is attached.</p>
          <p style="font-size:15px;line-height:1.75;color:#c9c3bb;margin:0 0 24px 0;">If you want to turn this into sharper priorities and a clearer direction, you can book a strategic session below.</p>
          <p style="margin:0 0 24px 0;">
            <a href="https://calendly.com/maryna-dabrytskaya/sahar-strategic-session" style="display:inline-block;padding:12px 18px;border:1px solid #d5b06d;color:#f1ece4;text-decoration:none;letter-spacing:1px;text-transform:uppercase;font-size:12px;">Book a Strategic Session</a>
          </p>
          <p style="font-size:13px;line-height:1.7;color:#d5b06d;margin:0 0 8px 0;">$197 / 60 min. Paid at booking.</p>
          <p style="font-size:13px;line-height:1.7;color:#8d939b;margin:0 0 24px 0;">If we continue into a project, the fee goes toward the work.</p>
          <p style="font-size:13px;line-height:1.7;color:#8d939b;margin:0;">Website reviewed: ${sanitize(url)}</p>
        </div>
      </div>
    `,
    attachments: [{
      filename: `${safeFilename(brandName)}-brand-review.pdf`,
      content: pdfBuffer.toString('base64'),
      contentType: 'application/pdf'
    }]
  });

  if (response?.error) {
    throw new Error(response.error.message || 'Resend email send failed');
  }

  return { ok: true, provider: 'resend' };
}

async function sendReportEmail({ email, url, result }) {
  if (!isResendConfigured() && !isSmtpConfigured()) {
    return { ok: false, skipped: true, reason: 'Email provider not configured' };
  }

  const pdfBuffer = await generatePdfBuffer({ email, url, result });

  if (isResendConfigured()) {
    return sendReportEmailWithResend({ email, url, result, pdfBuffer });
  }

  return sendReportEmailWithSmtp({ email, url, result, pdfBuffer });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const email = sanitize(body.email);
    const url = sanitize(body.url);
    const source = sanitize(body.source || 'website');
    const result = body.result || {};

    if (!email) {
      sendJson(res, 400, { error: 'Email is required.' });
      return;
    }

    if (!url) {
      sendJson(res, 400, { error: 'URL is required.' });
      return;
    }

    const tasks = await Promise.allSettled([
      withTimeout(
        appendLeadToSheet({ email, url, source, result }),
        8000,
        'Lead save'
      ),
      withTimeout(
        sendReportEmail({ email, url, result }),
        15000,
        'Email send'
      )
    ]);

    const sheetResult = tasks[0].status === 'fulfilled'
      ? tasks[0].value
      : { ok: false, error: tasks[0].reason?.message || 'Lead save failed' };

    const emailResult = tasks[1].status === 'fulfilled'
      ? tasks[1].value
      : { ok: false, error: tasks[1].reason?.message || 'Email send failed' };

    const ok = Boolean(sheetResult.ok || emailResult.ok || sheetResult.skipped || emailResult.skipped);

    if (!ok) {
      sendJson(res, 500, {
        error: 'Unable to process the report right now.',
        detail: {
          sheet: sheetResult.error || sheetResult.reason || null,
          email: emailResult.error || emailResult.reason || null
        }
      });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      savedLead: Boolean(sheetResult.ok),
      emailed: Boolean(emailResult.ok),
      emailConfigured: !emailResult.skipped,
      sheetsConfigured: !sheetResult.skipped
    });
  } catch (error) {
    sendJson(res, 500, {
      error: 'Unable to process the report right now.',
      detail: error.message
    });
  }
};
