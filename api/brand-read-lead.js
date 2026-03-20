try {
  require('dotenv').config({ path: `${process.cwd()}/.env.local` });
} catch (_) {
  // dotenv is only needed for local development
}

const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');
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
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 56, bottom: 56, left: 56, right: 56 },
      info: {
        Title: `${sanitize(result.brandName || 'Brand')} Deep Read`,
        Author: 'SAHAR',
        Subject: 'Brand Read Report'
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
      line: '#2a3139'
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

    doc.rect(0, 0, doc.page.width, doc.page.height).fill(colors.bg);
    doc.fillColor(colors.gold)
      .font('Helvetica')
      .fontSize(10)
      .text('SAHAR | DEEP READ', 56, 52, { characterSpacing: 2 });

    doc.fillColor(colors.text)
      .font('Times-Roman')
      .fontSize(31)
      .text(sanitize(result.brandName || 'Your Brand'), 56, 92);

    doc.fillColor(colors.text)
      .font('Times-Bold')
      .fontSize(26)
      .text(sanitize(result.title || 'Untitled'), 56, 140);

    doc.fillColor(colors.gold)
      .font('Helvetica')
      .fontSize(11)
      .text(sanitize(result.genre || 'Brand Read'), 56, 176, { characterSpacing: 1.2 });

    doc.moveTo(56, 202).lineTo(539, 202).strokeColor(colors.line).stroke();

    doc.fillColor(colors.text)
      .font('Helvetica')
      .fontSize(11)
      .text(`Website: ${sanitize(url)}`, 56, 220, { width: 330 });

    doc.fillColor(colors.muted)
      .font('Helvetica')
      .fontSize(10)
      .text(`Prepared for: ${sanitize(email)}`, 56, 238, { width: 330 });

    if (sanitize(result.tagline)) {
      doc.fillColor(colors.text)
        .font('Helvetica-Oblique')
        .fontSize(13)
        .text(sanitize(result.tagline), 56, 274, { width: 480 });
    }

    let y = 330;

    sections.forEach(([heading, body], index) => {
      const bodyText = toParagraph(body);
      const estimatedHeight = 26 + doc.heightOfString(bodyText, {
        width: 483,
        align: 'left',
        lineGap: 2
      }) + 20;

      if (y + estimatedHeight > doc.page.height - 76) {
        doc.addPage();
        doc.rect(0, 0, doc.page.width, doc.page.height).fill(colors.bg);
        y = 58;
      }

      doc.fillColor(colors.gold)
        .font('Helvetica')
        .fontSize(10)
        .text(heading.toUpperCase(), 56, y, { characterSpacing: 1.5 });

      y += 20;

      doc.fillColor(colors.text)
        .font('Helvetica')
        .fontSize(12)
        .text(bodyText, 56, y, {
          width: 483,
          lineGap: 3
        });

      y = doc.y + 18;

      if (index !== sections.length - 1) {
        doc.moveTo(56, y - 6).lineTo(539, y - 6).strokeColor(colors.line).stroke();
      }
    });

    doc.end();
  });
}

async function sendReportEmail({ email, url, result }) {
  if (!isSmtpConfigured()) {
    return { ok: false, skipped: true, reason: 'SMTP not configured' };
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || Number(process.env.SMTP_PORT) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  const pdfBuffer = await generatePdfBuffer({ email, url, result });
  const brandName = sanitize(result.brandName || 'Your Brand');
  const from = process.env.MAIL_FROM;
  const replyTo = process.env.MAIL_REPLY_TO || from;

  await transporter.sendMail({
    from,
    to: email,
    replyTo,
    subject: `${brandName} | Deep Read from SAHAR`,
    text: [
      `Here is your Deep Read for ${brandName}.`,
      '',
      'Attached is the PDF version of the report.',
      '',
      'If you want to turn this into sharper priorities and a clearer direction, you can book a strategic session here:',
      'https://calendly.com/maryna-dabrytskaya/sahar-strategic-session',
      '',
      'SAHAR'
    ].join('\n'),
    html: `
      <div style="background:#10151b;padding:32px;font-family:Helvetica,Arial,sans-serif;color:#f1ece4;">
        <div style="max-width:640px;margin:0 auto;">
          <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#d5b06d;margin-bottom:18px;">SAHAR | Deep Read</div>
          <div style="font-family:Georgia,'Times New Roman',serif;font-size:30px;line-height:1.1;margin-bottom:14px;">${brandName}</div>
          <p style="font-size:15px;line-height:1.75;color:#c9c3bb;margin:0 0 18px 0;">Here is your Deep Read report. The PDF is attached.</p>
          <p style="font-size:15px;line-height:1.75;color:#c9c3bb;margin:0 0 24px 0;">If you want to turn this into sharper priorities and a clearer direction, you can book a strategic session below.</p>
          <p style="margin:0 0 24px 0;">
            <a href="https://calendly.com/maryna-dabrytskaya/sahar-strategic-session" style="display:inline-block;padding:12px 18px;border:1px solid #d5b06d;color:#f1ece4;text-decoration:none;letter-spacing:1px;text-transform:uppercase;font-size:12px;">Book a Strategic Session</a>
          </p>
          <p style="font-size:13px;line-height:1.7;color:#8d939b;margin:0;">Website reviewed: ${sanitize(url)}</p>
        </div>
      </div>
    `,
    attachments: [{
      filename: `${safeFilename(brandName)}-deep-read.pdf`,
      content: pdfBuffer,
      contentType: 'application/pdf'
    }]
  });

  return { ok: true };
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
      appendLeadToSheet({ email, url, source, result }),
      sendReportEmail({ email, url, result })
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
