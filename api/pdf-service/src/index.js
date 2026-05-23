const { app } = require("@azure/functions");
const chromium = require("@sparticuz/chromium");
const playwright = require("playwright-core");

app.http("htmlToPdf", {
  methods: ["POST"],
  authLevel: "function",
  handler: async (request, context) => {
    let browser = null;
    try {
      const body = await request.json();
      const html = body.html;
      if (!html) {
        return { status: 400, jsonBody: { error: "Missing 'html' in request body" } };
      }

      browser = await playwright.chromium.launch({
        args: [...chromium.args, "--no-sandbox", "--disable-setuid-sandbox"],
        executablePath: await chromium.executablePath(),
        headless: true
      });

      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: "networkidle", timeout: 30000 });

      const pdfBuffer = await page.pdf({
        format: "A4",
        printBackground: true,
        margin: { top: "18mm", bottom: "18mm", left: "16mm", right: "16mm" },
        preferCSSPageSize: false
      });

      await browser.close();
      browser = null;

      return {
        status: 200,
        jsonBody: {
          pdfBase64: pdfBuffer.toString("base64"),
          contentType: "application/pdf"
        }
      };
    } catch (err) {
      context.error("PDF generation failed", err);
      if (browser) { try { await browser.close(); } catch {} }
      return { status: 500, jsonBody: { error: err.message } };
    }
  }
});